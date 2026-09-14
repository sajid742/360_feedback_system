import { BadRequestException, GoneException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';
import { SIS_PROVIDER, type SisProvider } from '../../sis/sis-provider.interface';
import { NotificationService } from '../../communication/services/notification.service';
import { TemplateService } from '../../communication/services/template.service';
import { CommunicationSettingsService } from '../../communication/communication.settings';
import { IdentityMapService } from '../../identity/identity-map.service';
import { ScoringService } from '../../appraisal/services/scoring.service';
import { FeedbackAuditService } from '../../feedback-audit/feedback-audit.service';
import { submissionDeadlinePassed } from '../../common/dates/submission-deadline';
import { DEFAULT_RATING_SCALE, DEFAULT_TEACHER_QUESTIONS, type EvalQuestion } from '../default-questionnaire';
import { EntitlementService } from '../../license/entitlement.service';
import type {
  CreateConsolidatedLinkDto,
  CreateEvaluationLinkDto,
  SendEvaluationLinkDto,
  SubmitConsolidatedDto,
  SubmitEvaluationDto,
} from '../external-evaluation.dto';

type Channel = 'whatsapp' | 'email' | 'sms';

/** Actor label/role for the anonymous parent who holds only a secure link. */
const PARENT_ACTOR = { actorName: 'Parent (secure link)', actorRole: 'External' } as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `evaluation_links.mode` / `feedback_sources.parent_mode` value for the consolidated form. */
const CONSOLIDATED = 'consolidated';

/** A guardian's contact details, as far as any of these paths care. */
interface ParentContact {
  mobile?: string | null;
  whatsapp?: string | null;
  email?: string | null;
}

/**
 * The address to use FOR THE CHANNEL BEING SENT ON.
 *
 * The bug this replaces: the recipient was resolved once, at link creation, as
 * `whatsapp ?? mobile ?? email` — a phone number for almost every guardian — and then
 * reused whatever channel was chosen later. Sending by e-mail therefore put a phone
 * number in the `To:` header, and nodemailer rejected the message with
 * "No recipients defined", which names neither the address nor the cause.
 *
 * The admin screen has always shown the right thing ("Sends to: …" switches with the
 * channel picker); only the server disagreed. This makes the server agree.
 */
export function contactForChannel(channel: Channel, parent: ParentContact): string | null {
  const clean = (v: string | null | undefined): string | null => {
    const t = (v ?? '').trim();
    return t.length > 0 ? t : null;
  };
  if (channel === 'email') return clean(parent.email);
  // SMS needs a real mobile; a WhatsApp-only number is usually the same handset, so it
  // is a reasonable fallback. WhatsApp prefers its own number and falls back to mobile.
  if (channel === 'sms') return clean(parent.mobile) ?? clean(parent.whatsapp);
  return clean(parent.whatsapp) ?? clean(parent.mobile);
}

/**
 * Refuse an address that cannot work on the chosen channel, before handing it to a
 * provider. Catching it here turns an opaque SMTP failure recorded against the parent
 * into an actionable message for the administrator who pressed Send.
 */
export function assertRecipientShape(channel: Channel, recipient: string): void {
  const value = recipient.trim();
  if (channel === 'email') {
    // Deliberately permissive — one @, something either side, no spaces. The point is
    // to catch a phone number, not to re-litigate RFC 5322.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      throw new BadRequestException(
        `"${value}" is not an e-mail address, so this invitation cannot be sent by e-mail. ` +
          `Add the guardian's e-mail under Student Integration → Students & Parents, or send by WhatsApp or SMS instead.`,
      );
    }
    return;
  }
  // WhatsApp and SMS: a phone number. An e-mail address here fails just as silently.
  if (value.includes('@') || !/[0-9]/.test(value)) {
    throw new BadRequestException(
      `"${value}" is not a phone number, so this invitation cannot be sent by ${channel === 'sms' ? 'SMS' : 'WhatsApp'}. ` +
        `Add the guardian's mobile number under Student Integration → Students & Parents, or send by e-mail instead.`,
    );
  }
}

@Injectable()
export class EvaluationLinkService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(SIS_PROVIDER) private readonly sis: SisProvider,
    private readonly notifications: NotificationService,
    private readonly templates: TemplateService,
    private readonly settings: CommunicationSettingsService,
    private readonly identity: IdentityMapService,
    private readonly scoring: ScoringService,
    private readonly feedbackAudit: FeedbackAuditService,
    private readonly entitlements: EntitlementService,
  ) {}

  /* ------------------------------- Admin --------------------------------- */

  async create(user: AuthUser, dto: CreateEvaluationLinkDto, targetCycleId?: string, ctx?: RequestContext): Promise<Record<string, unknown>> {
    // Fail BEFORE anything is written. Resolving the public URL here rather than at
    // the end means an unusable configuration cannot leave a half-built link row
    // behind for an administrator to clean up.
    await this.baseUrl(user.organizationId);
    /*
     * The monthly parent-link cap, checked alongside the public-URL check so both
     * failures happen BEFORE anything is written. Regeneration (line ~257) is
     * deliberately NOT capped: re-issuing a link the tenant already paid for is a
     * correction, not new consumption, and refusing it would strand a parent whose
     * first invitation went to a mistyped address.
     */
    await this.entitlements.assertWithinLimit(user.organizationId, 'maxParentLinksPerMonth', 1);
    const [student, assignment] = await Promise.all([
      this.sis.getStudent(dto.studentId).catch(() => null),
      this.sis.getTeachingAssignment(dto.teachingAssignmentId).catch(() => null),
    ]);
    if (!student) throw new NotFoundException('Student not found in SIS.');
    if (!assignment) throw new NotFoundException('Teaching assignment not found in SIS.');

    let parentName: string | null = null;
    let recipient = dto.recipient ?? null;
    if (dto.parentId) {
      const parents = await this.sis.getParentsOfStudent(dto.studentId).catch(() => []);
      const parent = parents.find((p) => p.id === dto.parentId);
      if (parent) {
        parentName = parent.name;
        // Resolved for the channel this link will actually be sent on, not for a fixed
        // order of preference. An explicit dto.recipient still wins.
        if (!recipient) recipient = contactForChannel(dto.channel ?? 'whatsapp', parent);
      }
    }

    // Resolve the SIS teacher to a 360 employee (explicit mapping only), then
    // auto-provision that employee's active-cycle participant + "Parents" source +
    // an external reviewer assignment. This is what makes parent feedback flow into
    // the employee's real 360 cycle, scoring, and reports.
    const employeeId = await this.identity.resolveEmployee(user.organizationId, 'teacher', assignment.teacherId);
    if (!employeeId) {
      throw new BadRequestException(
        `Teacher "${assignment.teacher}" is not yet mapped to a 360 employee. Create a Teacher ↔ Employee mapping first.`,
      );
    }
    const binding = await this.provisionCycle(user.organizationId, employeeId, targetCycleId);

    const token = randomBytes(24).toString('base64url');
    const expiresInDays = dto.expiresInDays ?? 14;
    const row = await this.prisma.evaluationLink.create({
      data: {
        organizationId: user.organizationId,
        tokenHash: this.hash(token),
        studentId: dto.studentId,
        studentName: student.name,
        parentId: dto.parentId ?? null,
        parentName,
        recipient,
        teacherId: assignment.teacherId,
        teacherName: assignment.teacher,
        subjectId: assignment.subjectId,
        subjectName: assignment.subject,
        teachingAssignmentId: assignment.id,
        className: assignment.gradeClass ?? null,
        sectionName: assignment.section ?? null,
        sessionName: assignment.session ?? null,
        // Parent evaluates against the cycle's questionnaire so responses map to the
        // same competency-linked questions as every other evaluator source.
        templateId: dto.templateId ?? binding.templateId ?? null,
        employeeId,
        cycleId: binding.cycleId,
        oneTime: dto.oneTime ?? true,
        expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000),
        createdBy: user.userId,
      },
    });

    // One external reviewer assignment per link, tagged back to the link.
    const asg = await this.prisma.reviewerAssignment.create({
      data: {
        organizationId: user.organizationId,
        cycleId: binding.cycleId,
        participantId: binding.participantId,
        sourceId: binding.sourceId,
        reviewerEmployeeId: null,
        reviewerType: 'external',
        externalRef: row.id,
        externalName: parentName ?? `Parent of ${student.name}`,
        nominationStatus: 'approved',
        status: 'pending',
      },
    });
    await this.prisma.evaluationLink.update({ where: { id: row.id }, data: { reviewerAssignmentId: asg.id } });

    let sent: { channel: Channel; recipient: string } | null = null;
    if (dto.send) {
      const channel = dto.channel ?? 'whatsapp';
      if (!recipient) {
        throw new BadRequestException(
          channel === 'email'
            ? 'This guardian has no e-mail address on record, so there is nothing to send to. Add one under Student Integration → Students & Parents, or send by WhatsApp or SMS.'
            : 'This guardian has no phone number on record, so there is nothing to send to. Add one under Student Integration → Students & Parents, or send by e-mail.',
        );
      }
      assertRecipientShape(channel, recipient);
      await this.deliverWithToken(user.organizationId, user.userId, row, token, channel, recipient);
      sent = { channel, recipient };
    }
    await this.feedbackAudit.recordForLink('link.generated', row.id, {
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorName: user.email,
      evaluatorName: parentName ?? `Parent of ${student.name}`,
      newValue: { sent: !!dto.send, channel: sent?.channel ?? null, student: student.name, teacher: assignment.teacher },
      ctx: ctx ?? null,
    });
    const fresh = await this.prisma.evaluationLink.findUnique({ where: { id: row.id } });
    return { ...this.toAdminDto(fresh ?? row), url: this.publicUrl(await this.baseUrl(user.organizationId), token), token, sent };
  }

  async list(user: AuthUser, studentId?: string): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.evaluationLink.findMany({
      where: { organizationId: user.organizationId, ...(studentId ? { studentId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((r) => this.toAdminDto(r));
  }

  async get(user: AuthUser, id: string): Promise<Record<string, unknown>> {
    const row = await this.owned(user.organizationId, id);
    return this.toAdminDto(row);
  }

  async revoke(user: AuthUser, id: string, ctx?: RequestContext): Promise<Record<string, unknown>> {
    const row = await this.owned(user.organizationId, id);
    const updated = await this.prisma.evaluationLink.update({ where: { id: row.id }, data: { status: 'revoked' } });
    // Revoking withdraws any contribution the parent already made to the score. A
    // consolidated link carries one assignment PER TEACHER, so every one of them has
    // to be reset — missing this would leave the other teachers' scores standing on
    // feedback that has been revoked.
    const withdrawn = await this.resetAssignments(row.id, row.reviewerAssignmentId);
    await this.feedbackAudit.recordForLink('link.revoked', row.id, {
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorName: user.email,
      previousValue: { status: row.status },
      newValue: { status: 'revoked', assignmentsCleared: withdrawn },
      ctx: ctx ?? null,
    });
    return this.toAdminDto(updated);
  }

  /**
   * Issue a fresh token (invalidates the old link) and reset the lifecycle.
   * Only the hash is ever stored, so a lost link can never be recovered — it is
   * re-minted here. Optionally re-delivers it in the same call.
   */
  async regenerate(user: AuthUser, id: string, dto: SendEvaluationLinkDto = {}, ctx?: RequestContext): Promise<Record<string, unknown>> {
    // Fail BEFORE anything is written. Resolving the public URL here rather than at
    // the end means an unusable configuration cannot leave a half-built link row
    // behind for an administrator to clean up.
    await this.baseUrl(user.organizationId);
    const row = await this.owned(user.organizationId, id);
    /*
     * Re-issuing clears responses, overallScore and comment and resets every linked
     * reviewer assignment. On a link the parent has ALREADY submitted, that is the
     * deletion of collected feedback — irreversible, and not what someone clicking
     * "resend" expects. Refuse unless it is asked for explicitly.
     *
     * Both submission paths (`submit` and `submitConsolidated`) set `status` and
     * `completedAt` together; `completedAt` is checked as well so a row left
     * inconsistent by an older build still counts as answered.
     */
    if ((row.status === 'completed' || row.completedAt !== null) && dto.force !== true) {
      throw new BadRequestException(
        'This link has already been submitted. Re-issuing it permanently discards the responses and score already recorded and resets the reviewer assignment. Send force: true to do that deliberately.',
      );
    }
    const token = randomBytes(24).toString('base64url');
    const updated = await this.prisma.evaluationLink.update({
      where: { id: row.id },
      data: { tokenHash: this.hash(token), status: 'pending', openedAt: null, completedAt: null, sentAt: null, responses: undefined, overallScore: null, comment: null },
    });
    // Reset every linked reviewer assignment so a fresh submission can be recorded
    // (and recompute each employee's score without the stale parent responses).
    await this.resetAssignments(row.id, row.reviewerAssignmentId);
    let sent: { channel: Channel; recipient: string } | null = null;
    if (dto.channel || dto.recipient) {
      const channel = dto.channel ?? 'whatsapp';
      // Re-resolve from the roster for THIS channel. `updated.recipient` holds whatever
      // the link was last sent to — normally a phone number — so reusing it here is what
      // put a phone number in the To: header of an e-mail resend. An explicit
      // dto.recipient still wins, and a link with no parentId keeps its stored value.
      const resolved = await this.recipientForChannel(updated, channel);
      const recipient = dto.recipient ?? resolved ?? undefined;
      if (!recipient) {
        throw new BadRequestException(
          channel === 'email'
            ? 'This guardian has no e-mail address on record, so there is nothing to send to. Add one under Student Integration → Students & Parents, or send by WhatsApp or SMS.'
            : 'This guardian has no phone number on record, so there is nothing to send to. Add one under Student Integration → Students & Parents, or send by e-mail.',
        );
      }
      assertRecipientShape(channel, recipient);
      await this.deliverWithToken(user.organizationId, user.userId, updated, token, channel, recipient);
      sent = { channel, recipient };
    }
    await this.feedbackAudit.recordForLink('link.regenerated', row.id, {
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorName: user.email,
      // `discardedSubmission` records the one case where re-issuing destroyed data.
      newValue: { resent: !!(dto.channel || dto.recipient), channel: sent?.channel ?? null, discardedSubmission: dto.force === true },
      ctx: ctx ?? null,
    });
    const fresh = await this.prisma.evaluationLink.findUnique({ where: { id: row.id } });
    return { ...this.toAdminDto(fresh ?? updated), url: this.publicUrl(await this.baseUrl(user.organizationId), token), token, sent };
  }

  /* ------------------------------- Public -------------------------------- */

  /** Validate a token and (idempotently) record the open. Returns the eval context. */
  async validate(token: string, ctx?: RequestContext): Promise<Record<string, unknown>> {
    const row = await this.findByToken(token);
    if (row.status === 'revoked') throw new GoneException('This evaluation link has been revoked.');
    if (row.status === 'completed' && row.oneTime) throw new GoneException('This evaluation has already been submitted.');
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
      if (row.status !== 'expired') {
        await this.prisma.evaluationLink.update({ where: { id: row.id }, data: { status: 'expired' } });
        await this.feedbackAudit.recordForLink('link.expired', row.id, { organizationId: row.organizationId, actorRole: 'System', ctx: ctx ?? null });
      }
      throw new GoneException('This evaluation link has expired.');
    }
    // Check the CYCLE before rendering the form, not only at submit.
    //
    // This guard used to run on submit alone, so a parent opened a perfectly valid
    // link, saw an open form, rated every question, wrote a comment, pressed Submit —
    // and only then learned the cycle had closed, losing the lot. On a phone, over
    // mobile data, that is the worst possible place to fail. Failing here costs the
    // parent one page load instead of ten minutes of work.
    await this.assertCycleOpen(row.cycleId);
    if (row.status === 'pending' || row.status === 'sent') {
      await this.prisma.evaluationLink.update({ where: { id: row.id }, data: { status: 'opened', openedAt: row.openedAt ?? new Date() } });
      await this.feedbackAudit.recordForLink('link.accessed', row.id, { organizationId: row.organizationId, ...PARENT_ACTOR, ctx: ctx ?? null });
    }
    if (row.mode === CONSOLIDATED) return this.consolidatedContext(row);
    return {
      student: row.studentName,
      parent: row.parentName,
      teacher: row.teacherName,
      subject: row.subjectName,
      class: row.className,
      section: row.sectionName,
      session: row.sessionName,
      organizationName: (await this.templates.branding(row.organizationId)).organizationName,
      questions: await this.questions(row.templateId),
      scale: DEFAULT_RATING_SCALE,
      status: row.status === 'completed' ? 'completed' : 'open',
    };
  }

  async submit(token: string, dto: SubmitEvaluationDto, ctx?: RequestContext): Promise<{ status: string }> {
    const row = await this.findByToken(token);
    if (row.mode === CONSOLIDATED) {
      throw new BadRequestException('This is a consolidated form — submit it with per-teacher ratings.');
    }
    if (row.status === 'revoked') throw new GoneException('This evaluation link has been revoked.');
    if (row.status === 'expired' || (row.expiresAt && row.expiresAt.getTime() < Date.now())) throw new GoneException('This evaluation link has expired.');
    if (row.status === 'completed' && row.oneTime) throw new GoneException('This evaluation has already been submitted.');
    // Parent/external feedback must not land in a cycle that has already closed or
    // passed its deadline (F-C5). Same guard as the consolidated path and as
    // `validate()`, so the three can never drift apart.
    await this.assertCycleOpen(row.cycleId);

    const ratings = dto.responses.filter((r) => typeof r.ratingValue === 'number').map((r) => r.ratingValue as number);
    const overall = ratings.length ? Number((ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2)) : null;
    const comment = dto.responses.find((r) => r.textValue && r.textValue.trim().length > 0)?.textValue ?? null;

    await this.prisma.evaluationLink.update({
      where: { id: row.id },
      data: {
        responses: dto.responses as unknown as object,
        overallScore: overall,
        comment,
        status: 'completed',
        completedAt: new Date(),
      },
    });

    // Record the parent's answers against the external reviewer assignment so they
    // count in the employee's 360 scoring/competency/reports exactly like any other
    // source. Only real question rows (UUIDs from the cycle template) are persisted
    // — the built-in generic questionnaire (no cycle template) affects only the
    // link's own overall score.
    if (row.reviewerAssignmentId) {
      const items = dto.responses.filter((r) => UUID_RE.test(r.questionId));
      if (items.length > 0) {
        await this.prisma.$transaction(async (tx) => {
          for (const item of items) {
            await tx.feedbackResponse.upsert({
              where: { assignment_question: { assignmentId: row.reviewerAssignmentId as string, questionId: item.questionId } },
              update: { ratingValue: item.ratingValue ?? null, textValue: item.textValue ?? null },
              create: { assignmentId: row.reviewerAssignmentId as string, questionId: item.questionId, ratingValue: item.ratingValue ?? null, textValue: item.textValue ?? null },
            });
          }
          await tx.reviewerAssignment.update({ where: { id: row.reviewerAssignmentId as string }, data: { status: 'submitted', submittedAt: new Date() } });
        });
        const asg = await this.prisma.reviewerAssignment.findUnique({ where: { id: row.reviewerAssignmentId }, select: { participantId: true } });
        if (asg) await this.scoring.compute(asg.participantId);
      }
    }
    await this.feedbackAudit.recordForLink('parent.feedback.submitted', row.id, {
      organizationId: row.organizationId,
      ...PARENT_ACTOR,
      evaluatorName: row.parentName ?? `Parent of ${row.studentName ?? 'student'}`,
      newValue: { overall, answered: dto.responses.length },
      ctx: ctx ?? null,
    });
    return { status: 'completed' };
  }

  /* ---------------------- consolidated parent form ----------------------- */

  /**
   * One form per student, covering every teacher that student has.
   *
   * The parent still produces one ordinary external reviewer assignment per teacher,
   * so scoring, the Parents quadrant weight, the anonymity threshold and every report
   * keep working per teacher and unchanged. The consolidated form is a data-entry
   * improvement, not a second feedback subsystem.
   */
  async createConsolidated(
    user: AuthUser,
    dto: CreateConsolidatedLinkDto,
    ctx?: RequestContext,
  ): Promise<Record<string, unknown>> {
    // Fail BEFORE anything is written. Resolving the public URL here rather than at
    // the end means an unusable configuration cannot leave a half-built link row
    // behind for an administrator to clean up.
    await this.baseUrl(user.organizationId);
    /*
     * The monthly parent-link cap, checked alongside the public-URL check so both
     * failures happen BEFORE anything is written. Regeneration (line ~257) is
     * deliberately NOT capped: re-issuing a link the tenant already paid for is a
     * correction, not new consumption, and refusing it would strand a parent whose
     * first invitation went to a mistyped address.
     */
    await this.entitlements.assertWithinLimit(user.organizationId, 'maxParentLinksPerMonth', 1);
    const student = await this.sis.getStudent(dto.studentId).catch(() => null);
    if (!student) throw new NotFoundException('Student not found in SIS.');

    const roster = await this.sis.getTeachersOfStudent(dto.studentId).catch(() => []);
    if (roster.length === 0) {
      throw new BadRequestException(
        `${student.name} has no teacher assignments in the SIS, so there is nothing to rate.`,
      );
    }

    // Deduplicate by TEACHER, not by teaching assignment. A teacher who teaches this
    // child two subjects appears twice in the roster; rating them twice on one form
    // would double-count in both the Parents average and the anonymity threshold.
    const byTeacher = new Map<string, { teacherId: string; teacher: string; subjects: string[]; teachingAssignmentId: string }>();
    for (const r of roster) {
      const seen = byTeacher.get(r.teacherId);
      if (seen) {
        if (r.subject && !seen.subjects.includes(r.subject)) seen.subjects.push(r.subject);
        continue;
      }
      byTeacher.set(r.teacherId, {
        teacherId: r.teacherId,
        teacher: r.teacher,
        subjects: r.subject ? [r.subject] : [],
        teachingAssignmentId: r.teachingAssignmentId,
      });
    }

    let parentName: string | null = null;
    let recipient = dto.recipient ?? null;
    if (dto.parentId) {
      const parents = await this.sis.getParentsOfStudent(dto.studentId).catch(() => []);
      const parent = parents.find((p) => p.id === dto.parentId);
      if (parent) {
        parentName = parent.name;
        // Same channel-aware resolution as the per-teacher path above.
        if (!recipient) recipient = contactForChannel(dto.channel ?? 'whatsapp', parent);
      }
    }

    // Resolve every teacher to a 360 employee BEFORE creating anything. A teacher with
    // no identity mapping is skipped and reported — one unmapped teacher must not block
    // feedback for the child's other teachers.
    const resolved: { teacherId: string; teacher: string; subjects: string[]; teachingAssignmentId: string; employeeId: string }[] = [];
    const skipped: { teacher: string; reason: string }[] = [];
    for (const t of byTeacher.values()) {
      const employeeId = await this.identity.resolveEmployee(user.organizationId, 'teacher', t.teacherId);
      if (!employeeId) {
        skipped.push({ teacher: t.teacher, reason: 'not mapped to a 360 employee' });
        continue;
      }
      resolved.push({ ...t, employeeId });
    }
    if (resolved.length === 0) {
      throw new BadRequestException(
        `None of ${student.name}'s teachers is mapped to a 360 employee. Create Teacher ↔ Employee mappings first.`,
      );
    }

    const first = await this.provisionCycle(user.organizationId, resolved[0].employeeId, dto.cycleId);
    const token = randomBytes(24).toString('base64url');
    const expiresInDays = dto.expiresInDays ?? 14;

    const row = await this.prisma.evaluationLink.create({
      data: {
        organizationId: user.organizationId,
        tokenHash: this.hash(token),
        mode: CONSOLIDATED,
        studentId: dto.studentId,
        studentName: student.name,
        parentId: dto.parentId ?? null,
        parentName,
        recipient,
        // Student-scoped: the teachers live in evaluation_link_targets.
        teacherId: null,
        className: student.currentClass ?? null,
        sectionName: student.currentSection ?? null,
        templateId: first.templateId,
        cycleId: first.cycleId,
        oneTime: dto.oneTime ?? true,
        expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000),
        createdBy: user.userId,
      },
    });

    // One external assignment per teacher, exactly the shape the per-teacher flow
    // already creates — which is what keeps scoring and reporting unchanged.
    let sortOrder = 0;
    for (const t of resolved) {
      const binding = await this.provisionCycle(user.organizationId, t.employeeId, dto.cycleId);
      const asg = await this.prisma.reviewerAssignment.create({
        data: {
          organizationId: user.organizationId,
          cycleId: binding.cycleId,
          participantId: binding.participantId,
          sourceId: binding.sourceId,
          reviewerEmployeeId: null,
          reviewerType: 'external',
          externalRef: row.id,
          externalName: parentName ?? `Parent of ${student.name}`,
          nominationStatus: 'approved',
          status: 'pending',
        },
      });
      await this.prisma.evaluationLinkTarget.create({
        data: {
          linkId: row.id,
          teacherId: t.teacherId,
          teacherName: t.teacher,
          subjectNames: t.subjects.join(', ') || null,
          teachingAssignmentId: t.teachingAssignmentId,
          employeeId: t.employeeId,
          reviewerAssignmentId: asg.id,
          sortOrder: sortOrder++,
        },
      });
    }

    let sent: { channel: Channel; recipient: string } | null = null;
    if (dto.send) {
      const channel = dto.channel ?? 'whatsapp';
      if (!recipient) {
        throw new BadRequestException(
          channel === 'email'
            ? 'This guardian has no e-mail address on record, so there is nothing to send to. Add one under Student Integration → Students & Parents, or send by WhatsApp or SMS.'
            : 'This guardian has no phone number on record, so there is nothing to send to. Add one under Student Integration → Students & Parents, or send by e-mail.',
        );
      }
      assertRecipientShape(channel, recipient);
      await this.deliverConsolidated(user.organizationId, user.userId, row, token, channel, recipient, resolved.length);
      sent = { channel, recipient };
    }

    await this.feedbackAudit.recordForLink('link.generated', row.id, {
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorName: user.email,
      evaluatorName: parentName ?? `Parent of ${student.name}`,
      newValue: { mode: CONSOLIDATED, teachers: resolved.length, skipped: skipped.length, student: student.name, sent: !!dto.send },
      ctx: ctx ?? null,
    });

    const fresh = await this.prisma.evaluationLink.findUnique({ where: { id: row.id } });
    return {
      ...this.toAdminDto(fresh ?? row),
      mode: CONSOLIDATED,
      teachers: resolved.map((t) => ({ teacherId: t.teacherId, teacher: t.teacher, subjects: t.subjects.join(', ') })),
      skipped,
      url: this.publicUrl(await this.baseUrl(user.organizationId), token),
      token,
      sent,
    };
  }

  /** What the parent sees when they open a consolidated link. */
  private async consolidatedContext(row: { id: string; organizationId: string; studentName: string | null; parentName: string | null; className: string | null; sectionName: string | null; templateId: string | null; cycleId: string | null; status: string }): Promise<Record<string, unknown>> {
    const targets = await this.prisma.evaluationLinkTarget.findMany({
      where: { linkId: row.id },
      orderBy: { sortOrder: 'asc' },
    });
    const question = (await this.questions(row.templateId)).find((q) => q.type === 'rating') ?? null;
    return {
      mode: CONSOLIDATED,
      student: row.studentName,
      parent: row.parentName,
      class: row.className,
      section: row.sectionName,
      organizationName: (await this.templates.branding(row.organizationId)).organizationName,
      question: question ? { id: question.id, text: question.text } : null,
      scale: await this.scaleFor(row.cycleId),
      requireAll: await this.requireAll(row.cycleId),
      teachers: targets.map((t) => ({
        teacherId: t.teacherId,
        teacher: t.teacherName,
        subjects: t.subjectNames,
        rating: t.ratingValue === null ? null : Number(t.ratingValue),
      })),
      status: row.status === 'completed' ? 'completed' : 'open',
    };
  }

  /**
   * One submission, many teachers. Each rating becomes an ordinary feedback response
   * against that teacher's own external assignment, so per-teacher attribution,
   * aggregation and suppression all fall out of the existing model.
   */
  async submitConsolidated(token: string, dto: SubmitConsolidatedDto, ctx?: RequestContext): Promise<{ status: string; rated: number; skipped: number }> {
    const row = await this.findByToken(token);
    if (row.mode !== CONSOLIDATED) throw new BadRequestException('This link is not a consolidated form.');
    if (row.status === 'revoked') throw new GoneException('This evaluation link has been revoked.');
    if (row.status === 'expired' || (row.expiresAt && row.expiresAt.getTime() < Date.now())) throw new GoneException('This evaluation link has expired.');
    if (row.status === 'completed' && row.oneTime) throw new GoneException('This evaluation has already been submitted.');
    await this.assertCycleOpen(row.cycleId);

    const targets = await this.prisma.evaluationLinkTarget.findMany({ where: { linkId: row.id }, orderBy: { sortOrder: 'asc' } });
    const question = (await this.questions(row.templateId)).find((q) => q.type === 'rating') ?? null;
    if (!question || !UUID_RE.test(question.id)) {
      throw new BadRequestException('This cycle has no parent question configured, so feedback cannot be recorded.');
    }
    const { min, max } = await this.scaleBounds(row.cycleId);

    const byTeacher = new Map(targets.map((t) => [t.teacherId, t]));
    const rated = dto.ratings.filter((r) => byTeacher.has(r.teacherId));
    for (const r of rated) {
      if (r.ratingValue < min || r.ratingValue > max) {
        throw new BadRequestException(`Ratings must be between ${min} and ${max}.`);
      }
    }
    if (await this.requireAll(row.cycleId)) {
      if (rated.length < targets.length) {
        throw new BadRequestException('Please rate every teacher listed before submitting.');
      }
    }
    if (rated.length === 0) throw new BadRequestException('Please rate at least one teacher before submitting.');

    const participantIds = new Set<string>();
    await this.prisma.$transaction(async (tx) => {
      for (const r of rated) {
        const target = byTeacher.get(r.teacherId)!;
        if (!target.reviewerAssignmentId) continue;
        await tx.feedbackResponse.upsert({
          where: { assignment_question: { assignmentId: target.reviewerAssignmentId, questionId: question.id } },
          update: { ratingValue: r.ratingValue },
          create: { assignmentId: target.reviewerAssignmentId, questionId: question.id, ratingValue: r.ratingValue },
        });
        await tx.reviewerAssignment.update({
          where: { id: target.reviewerAssignmentId },
          data: { status: 'submitted', submittedAt: new Date() },
        });
        await tx.evaluationLinkTarget.update({
          where: { id: target.id },
          data: { ratingValue: r.ratingValue, status: 'submitted' },
        });
      }
      // A teacher the parent chose not to rate is "not asked": no response row, the
      // assignment stays unsubmitted, so they are excluded from the Parents average
      // AND from the anonymity count. That is different from a low score.
      const ratedIds = new Set(rated.map((r) => r.teacherId));
      for (const t of targets) {
        if (!ratedIds.has(t.teacherId)) {
          await tx.evaluationLinkTarget.update({ where: { id: t.id }, data: { status: 'skipped' } });
        }
      }
      const values = rated.map((r) => r.ratingValue);
      await tx.evaluationLink.update({
        where: { id: row.id },
        data: {
          responses: rated as unknown as object,
          overallScore: values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)) : null,
          status: 'completed',
          completedAt: new Date(),
        },
      });
    });

    // Recompute once per affected participant, not once per rating.
    for (const r of rated) {
      const target = byTeacher.get(r.teacherId)!;
      if (!target.reviewerAssignmentId) continue;
      const asg = await this.prisma.reviewerAssignment.findUnique({
        where: { id: target.reviewerAssignmentId },
        select: { participantId: true },
      });
      if (asg) participantIds.add(asg.participantId);
    }
    for (const participantId of participantIds) await this.scoring.compute(participantId);

    await this.feedbackAudit.recordForLink('parent.feedback.submitted', row.id, {
      organizationId: row.organizationId,
      ...PARENT_ACTOR,
      evaluatorName: row.parentName ?? `Parent of ${row.studentName ?? 'student'}`,
      newValue: { mode: CONSOLIDATED, rated: rated.length, skipped: targets.length - rated.length },
      ctx: ctx ?? null,
    });
    return { status: 'completed', rated: rated.length, skipped: targets.length - rated.length };
  }

  /* ------------------------------ cycles -------------------------------- */

  /**
   * The cycles this page may target, newest first, active ones first.
   *
   * Served from here rather than from Appraisals → Cycles so the page needs only
   * `external.evaluation.manage`: somebody who generates parent links is not
   * necessarily permitted to read the appraisal module.
   *
   * `selectable` marks the cycles a NEW link may be generated into — `active` only,
   * because an expired or draft cycle refuses feedback the moment the parent opens
   * the form. The first selectable row is by construction the same cycle
   * `provisionCycle()` falls back to when no id is sent, so the picker's default and
   * the server's default cannot drift apart.
   *
   * Non-selectable cycles are returned too, so a link generated into a cycle that has
   * since closed can still be labelled with its name instead of showing a bare id.
   */
  async cycles(orgId: string): Promise<
    {
      id: string;
      name: string;
      status: string;
      startDate: Date;
      endDate: Date;
      submissionDeadline: Date | null;
      selectable: boolean;
    }[]
  > {
    const rows = await this.prisma.appraisalCycle.findMany({
      where: { organizationId: orgId, deletedAt: null },
      orderBy: { startDate: 'desc' },
      select: { id: true, name: true, status: true, startDate: true, endDate: true, submissionDeadline: true },
    });
    const active = rows.filter((r) => r.status === 'active');
    const rest = rows.filter((r) => r.status !== 'active');
    return [...active, ...rest].map((r) => ({ ...r, selectable: r.status === 'active' }));
  }

  /* --------------------- consolidated-mode internals --------------------- */

  /** Is this cycle's Parents quadrant configured for the consolidated form? */
  async parentModeOf(orgId: string, cycleId?: string): Promise<{ cycleId: string | null; mode: string | null; requireAll: boolean }> {
    const cycle = cycleId
      ? await this.prisma.appraisalCycle.findFirst({ where: { id: cycleId, organizationId: orgId, deletedAt: null }, select: { id: true } })
      : await this.prisma.appraisalCycle.findFirst({ where: { organizationId: orgId, status: 'active', deletedAt: null }, orderBy: { startDate: 'desc' }, select: { id: true } });
    if (!cycle) return { cycleId: null, mode: null, requireAll: false };
    const source = await this.prisma.feedbackSource.findFirst({
      where: { cycleId: cycle.id, code: 'parent' },
      select: { parentMode: true, parentRequireAll: true },
    });
    return { cycleId: cycle.id, mode: source?.parentMode ?? null, requireAll: source?.parentRequireAll ?? false };
  }

  private async requireAll(cycleId: string | null): Promise<boolean> {
    if (!cycleId) return false;
    const source = await this.prisma.feedbackSource.findFirst({ where: { cycleId, code: 'parent' }, select: { parentRequireAll: true } });
    return source?.parentRequireAll ?? false;
  }

  /**
   * The rating anchors the parent sees. Consolidated forms read the cycle's configured
   * scale; the per-teacher form keeps its original built-in scale so live links are
   * unaffected.
   */
  private async scaleFor(cycleId: string | null): Promise<{ value: number; label: string }[]> {
    const levels = await this.scaleLevels(cycleId);
    return levels.length > 0 ? levels : DEFAULT_RATING_SCALE;
  }

  private async scaleLevels(cycleId: string | null): Promise<{ value: number; label: string }[]> {
    if (!cycleId) return [];
    const cycle = await this.prisma.appraisalCycle.findUnique({ where: { id: cycleId }, select: { ratingScaleId: true } });
    if (!cycle?.ratingScaleId) return [];
    const rows = await this.prisma.ratingScaleLevel.findMany({
      where: { ratingScaleId: cycle.ratingScaleId },
      orderBy: { value: 'asc' },
      select: { value: true, label: true },
    });
    return rows.map((r) => ({ value: Number(r.value), label: r.label }));
  }

  private async scaleBounds(cycleId: string | null): Promise<{ min: number; max: number }> {
    const levels = await this.scaleFor(cycleId);
    const values = levels.map((l) => l.value);
    return { min: Math.min(...values), max: Math.max(...values) };
  }

  /**
   * Shared cycle-open guard: parent feedback must not land in a closed or overdue cycle.
   *
   * Called from `validate()` as well as the two submit paths, so a parent whose cycle
   * has closed is told on OPENING the link rather than after filling the whole form in.
   * Queried directly rather than through CycleService to avoid a module dependency cycle.
   */
  private async assertCycleOpen(cycleId: string | null): Promise<void> {
    if (!cycleId) return;
    const cycle = await this.prisma.appraisalCycle.findFirst({
      where: { id: cycleId, deletedAt: null },
      select: { status: true, submissionDeadline: true },
    });
    if (cycle && cycle.status !== 'active') throw new GoneException('The feedback cycle for this evaluation is no longer open.');
    if (submissionDeadlinePassed(cycle?.submissionDeadline)) {
      // Name the date. A parent who is turned away can then say "the deadline was the
      // 8th" to whoever sent them the link, instead of reporting that "it did not work".
      const day = cycle?.submissionDeadline?.toISOString().slice(0, 10);
      throw new GoneException(
        day
          ? `The submission deadline for this evaluation has passed. Feedback closed after ${day}. Please contact the school if you still need to respond.`
          : 'The submission deadline for this evaluation has passed.',
      );
    }
  }

  private async deliverConsolidated(
    orgId: string,
    userId: string | null,
    row: { id: string; studentName: string | null; parentName: string | null },
    token: string,
    channel: Channel,
    recipient: string,
    teacherCount: number,
  ): Promise<void> {
    const branding = await this.templates.branding(orgId);
    const url = this.publicUrl(await this.baseUrl(orgId), token);
    const greeting = row.parentName ? `Dear ${row.parentName}` : 'Dear Parent/Guardian';
    const body =
      `${greeting},\n\n` +
      `${branding.organizationName} invites you to rate ${row.studentName ?? 'your child'}'s ` +
      `${teacherCount} teacher${teacherCount === 1 ? '' : 's'} — one short question each, on a single form.\n\n` +
      `${url}\n\n` +
      `Thank you,\n${branding.organizationName}`;
    await this.notifications.send(orgId, userId, {
      channel,
      recipient,
      subject: channel === 'sms' ? undefined : `${branding.organizationName}: rate your child's teachers`,
      body,
      templateKey: 'external_evaluation.invite',
    });
    await this.prisma.evaluationLink.update({
      where: { id: row.id },
      data: { status: 'sent', sentAt: new Date(), sendChannel: channel, recipient },
    });
  }

  /**
   * Find the org's active cycle and ensure this employee has a participant record,
   * a "Parents" feedback source on that cycle, and returns the cycle's template so
   * the parent evaluates against the same competency-linked questionnaire.
   */
  private async provisionCycle(
    orgId: string,
    employeeId: string,
    explicitCycleId?: string,
  ): Promise<{ cycleId: string; participantId: string; sourceId: string; templateId: string | null }> {
    // Bulk generation targets a specific (freshly created) cycle; the single-link
    // flow targets whatever cycle is currently active.
    const cycle = explicitCycleId
      ? await this.prisma.appraisalCycle.findFirst({
          where: { id: explicitCycleId, organizationId: orgId, deletedAt: null },
          select: { id: true, templateId: true },
        })
      : await this.prisma.appraisalCycle.findFirst({
          where: { organizationId: orgId, status: 'active', deletedAt: null },
          orderBy: { startDate: 'desc' },
          select: { id: true, templateId: true },
        });
    if (!cycle) {
      throw new BadRequestException(
        explicitCycleId
          ? 'Target cycle not found.'
          : 'There is no active feedback cycle. Activate a cycle before generating parent evaluations.',
      );
    }
    let participant = await this.prisma.appraisalParticipant.findFirst({
      where: { cycleId: cycle.id, employeeId },
      select: { id: true },
    });
    if (!participant) {
      participant = await this.prisma.appraisalParticipant.create({ data: { cycleId: cycle.id, employeeId }, select: { id: true } });
    }
    let source = await this.prisma.feedbackSource.findFirst({ where: { cycleId: cycle.id, code: 'parent' }, select: { id: true, templateId: true } });
    if (!source) {
      source = await this.prisma.feedbackSource.create({
        data: { cycleId: cycle.id, code: 'parent', label: 'Parents', weight: 1, requiredCount: 1, isAnonymous: true, isActive: true },
        select: { id: true, templateId: true },
      });
    }
    // Parents answer the Parents quadrant's own questionnaire when one is configured —
    // typically the short, parent-appropriate set — and the cycle questionnaire otherwise.
    // Same fall-back rule as every internal reviewer, so a cycle that predates
    // per-quadrant questionnaires behaves exactly as before.
    return {
      cycleId: cycle.id,
      participantId: participant.id,
      sourceId: source.id,
      templateId: source.templateId ?? cycle.templateId,
    };
  }

  /* ------------------------------ internals ------------------------------ */

  /**
   * Withdraw a link's contribution to the 360: delete its responses, put its
   * assignments back to pending, reset any consolidated targets, and recompute each
   * affected participant.
   *
   * Handles both shapes — the per-teacher link's single `reviewerAssignmentId` and a
   * consolidated link's N targets — and returns how many assignments it touched.
   */
  private async resetAssignments(linkId: string, singleAssignmentId: string | null): Promise<number> {
    const targets = await this.prisma.evaluationLinkTarget.findMany({
      where: { linkId },
      select: { id: true, reviewerAssignmentId: true },
    });
    const ids = [
      ...(singleAssignmentId ? [singleAssignmentId] : []),
      ...targets.map((t) => t.reviewerAssignmentId).filter((id): id is string => Boolean(id)),
    ];
    if (ids.length === 0) return 0;

    const affected = await this.prisma.reviewerAssignment.findMany({
      where: { id: { in: ids } },
      select: { participantId: true },
    });
    await this.prisma.feedbackResponse.deleteMany({ where: { assignmentId: { in: ids } } });
    await this.prisma.reviewerAssignment.updateMany({
      where: { id: { in: ids } },
      data: { status: 'pending', submittedAt: null },
    });
    if (targets.length > 0) {
      await this.prisma.evaluationLinkTarget.updateMany({
        where: { linkId },
        data: { status: 'pending', ratingValue: null },
      });
    }
    for (const participantId of new Set(affected.map((a) => a.participantId))) {
      await this.scoring.compute(participantId);
    }
    return ids.length;
  }


  /** Compose and send the evaluation message for a freshly minted token. */
  /**
   * The address to resend an existing link to, for a given channel, read fresh from the
   * roster. Falls back to the link's stored recipient when the guardian cannot be
   * resolved (a link created with a hand-typed recipient and no parentId), and returns
   * that stored value only when it is plausible for the channel — otherwise null, so the
   * caller raises a message naming the missing contact detail rather than sending a
   * phone number to an SMTP server.
   */
  private async recipientForChannel(
    row: { studentId: string | null; parentId: string | null; recipient: string | null },
    channel: Channel,
  ): Promise<string | null> {
    if (row.studentId && row.parentId) {
      const parents = await this.sis.getParentsOfStudent(row.studentId).catch(() => []);
      const parent = parents.find((p) => p.id === row.parentId);
      if (parent) {
        const resolved = contactForChannel(channel, parent);
        if (resolved) return resolved;
      }
    }
    const stored = (row.recipient ?? '').trim();
    if (!stored) return null;
    const looksLikeEmail = stored.includes('@');
    return (channel === 'email') === looksLikeEmail ? stored : null;
  }

  private async deliverWithToken(
    orgId: string,
    userId: string | null,
    row: { id: string; studentName: string | null; teacherName: string | null; subjectName: string | null; parentName: string | null },
    token: string,
    channel: Channel,
    recipient: string,
  ): Promise<void> {
    const branding = await this.templates.branding(orgId);
    const url = this.publicUrl(await this.baseUrl(orgId), token);
    const greeting = row.parentName ? `Dear ${row.parentName}` : 'Dear Parent/Guardian';
    const body =
      `${greeting},\n\n` +
      `${branding.organizationName} invites you to evaluate ${row.teacherName ?? 'the teacher'} ` +
      `for ${row.subjectName ?? 'the subject'} taught to ${row.studentName ?? 'your child'}.\n\n` +
      `Please complete the short evaluation using the link below:\n` +
      // On its own line, bare, with nothing appended. WhatsApp linkifies a URL that
      // stands alone; trailing punctuation or surrounding text gets swallowed into it.
      `${url}\n\n` +
      `Thank you,\n${branding.organizationName}`;
    await this.notifications.send(orgId, userId, {
      channel,
      recipient,
      subject: channel === 'sms' ? undefined : `${branding.organizationName}: teacher evaluation`,
      body,
      templateKey: 'external_evaluation.invite',
    });
    await this.prisma.evaluationLink.update({ where: { id: row.id }, data: { status: 'sent', sentAt: new Date(), sendChannel: channel, recipient } });
  }

  private async questions(templateId: string | null): Promise<EvalQuestion[]> {
    if (!templateId) return DEFAULT_TEACHER_QUESTIONS;
    const sections = await this.prisma.templateSection.findMany({
      where: { templateId },
      orderBy: { sortOrder: 'asc' },
      include: { questions: { orderBy: { sortOrder: 'asc' }, include: { question: { select: { id: true, text: true, type: true } } } } },
    });
    const qs = sections.flatMap((s) => s.questions.map((sq) => sq.question));
    if (qs.length === 0) return DEFAULT_TEACHER_QUESTIONS;
    return qs.map((q) => ({ id: q.id, text: q.text, type: q.type === 'text' ? 'text' : 'rating' }));
  }

  private async findByToken(token: string) {
    const row = await this.prisma.evaluationLink.findUnique({ where: { tokenHash: this.hash(token) } });
    if (!row) throw new NotFoundException('This evaluation link is invalid.');
    return row;
  }

  private async owned(orgId: string, id: string) {
    const row = await this.prisma.evaluationLink.findFirst({ where: { id, organizationId: orgId } });
    if (!row) throw new NotFoundException('Evaluation link not found.');
    return row;
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private publicUrl(base: string, token: string): string {
    return `${base.replace(/\/$/, '')}/evaluate/${token}`;
  }

  /**
   * Parent links leave the building, so this uses the guarded resolver: it refuses in
   * production rather than minting a link on a loopback host that the recipient's phone
   * would resolve to their own device.
   */
  private async baseUrl(orgId: string): Promise<string> {
    return this.settings.requireExternalBaseUrl(orgId);
  }

  /**
   * The administrative view of a link.
   *
   * It deliberately returns the DENORMALISED columns — parent name, recipient,
   * student name, teacher name — exactly as they were stored when the link was
   * generated. Correcting the roster afterwards must not rewrite this history, so
   * nothing here is re-resolved against the current snapshot.
   *
   * `parentId`, `teacherId` and `cycleId` are included so an administrator can
   * trace a row back to the roster record it came from; that is a traceability
   * improvement only, and it changes nothing about report anonymity, which is
   * enforced separately in ReportsService by `min_responses_to_show`.
   */
  private toAdminDto(r: {
    id: string; studentId: string; studentName: string | null; parentId: string | null; parentName: string | null; recipient: string | null;
    teacherId: string | null; teacherName: string | null; subjectName: string | null; className: string | null; sectionName: string | null;
    sessionName: string | null; cycleId: string | null; mode: string | null; status: string; oneTime: boolean; expiresAt: Date | null; overallScore: unknown;
    sendChannel: string | null; sentAt: Date | null; openedAt: Date | null; completedAt: Date | null; createdAt: Date;
  }): Record<string, unknown> {
    return {
      id: r.id,
      studentId: r.studentId,
      student: r.studentName,
      parentId: r.parentId,
      parent: r.parentName,
      recipient: r.recipient,
      teacherId: r.teacherId,
      cycleId: r.cycleId,
      mode: r.mode ?? 'per_teacher',
      teacher: r.teacherName,
      subject: r.subjectName,
      class: r.className,
      section: r.sectionName,
      session: r.sessionName,
      status: r.status,
      oneTime: r.oneTime,
      expiresAt: r.expiresAt,
      overallScore: r.overallScore === null || r.overallScore === undefined ? null : Number(r.overallScore),
      channel: r.sendChannel,
      sentAt: r.sentAt,
      openedAt: r.openedAt,
      completedAt: r.completedAt,
      createdAt: r.createdAt,
    };
  }
}
