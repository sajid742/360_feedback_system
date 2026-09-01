import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { FeedbackAuditService } from '../../feedback-audit/feedback-audit.service';
import { UserNotificationService } from '../../user-notifications/user-notification.service';
import { cycleCoverage } from '../questionnaire-resolution';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';
import { CycleService } from './cycle.service';
import type { AddParticipantDto, AddSourceDto, UpdateSourceDto } from '../appraisal.dto';

/** Feedback-source configuration + participant enrollment for a cycle. */
@Injectable()
export class SetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cycles: CycleService,
    private readonly audit: AuditService,
    private readonly feedbackAudit: FeedbackAuditService,
    private readonly notifications: UserNotificationService,
  ) {}

  /* ---- Feedback sources (weightage) ---- */
  async listSources(user: AuthUser, cycleId: string): Promise<Record<string, unknown>[]> {
    await this.cycles.getOwned(user.organizationId, cycleId);
    const rows = await this.prisma.feedbackSource.findMany({
      where: { cycleId },
      orderBy: { code: 'asc' },
      include: { template: { select: { id: true, name: true } } },
    });
    // AppraisalCycle.templateId is a plain column (no Prisma relation), so the cycle
    // questionnaire's name is read separately.
    const cycle = await this.prisma.appraisalCycle.findUniqueOrThrow({
      where: { id: cycleId },
      select: { templateId: true },
    });
    const cycleTemplateName = cycle.templateId
      ? (await this.prisma.questionnaireTemplate.findUnique({ where: { id: cycle.templateId }, select: { name: true } }))?.name ?? null
      : null;
    const totalWeight = rows.reduce((sum, r) => sum + Number(r.weight), 0);
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      label: r.label,
      weight: Number(r.weight),
      requiredCount: r.requiredCount,
      isAnonymous: r.isAnonymous,
      weightShare: totalWeight > 0 ? Math.round((Number(r.weight) / totalWeight) * 100) : 0,
      // Quadrant-specific questionnaire. `templateId` is what is configured on this
      // quadrant; `effectiveTemplate*` is what its reviewers actually answer once the
      // fall-back to the cycle questionnaire is applied.
      templateId: r.templateId,
      templateName: r.template?.name ?? null,
      // Parents quadrant only: how it collects feedback. NULL/'standard' = the original
      // one-form-per-teacher behaviour.
      parentMode: r.parentMode ?? null,
      parentRequireAll: r.parentRequireAll,
      effectiveTemplateId: r.templateId ?? cycle.templateId,
      effectiveTemplateName: r.template?.name ?? cycleTemplateName,
      inheritsCycleTemplate: !r.templateId,
    }));
  }

  async addSource(user: AuthUser, ctx: RequestContext, cycleId: string, dto: AddSourceDto): Promise<{ id: string }> {
    const cycle = await this.cycles.getOwned(user.organizationId, cycleId);
    const clash = await this.prisma.feedbackSource.findFirst({ where: { cycleId, code: dto.code }, select: { id: true } });
    if (clash) throw new ConflictException('A source with this code already exists in the cycle.');
    await this.assertLabelFree(cycleId, dto.label, null);
    const row = await this.prisma.feedbackSource.create({
      data: {
        cycleId,
        code: dto.code,
        label: dto.label,
        weight: dto.weight ?? 1,
        requiredCount: dto.requiredCount ?? 1,
        isAnonymous: dto.isAnonymous ?? false,
        templateId: dto.templateId ? await this.assertTemplate(user.organizationId, dto.templateId) : null,
      },
    });
    await this.feedbackAudit.record({
      organizationId: user.organizationId,
      action: 'source.added',
      actorUserId: user.userId,
      actorName: user.email,
      cycleId,
      cycleName: cycle.name,
      sourceType: dto.label ?? dto.code,
      entityType: 'feedback_source',
      entityId: row.id,
      newValue: { code: dto.code, label: dto.label, weight: dto.weight ?? 1, requiredCount: dto.requiredCount ?? 1, isAnonymous: dto.isAnonymous ?? false },
      ctx,
    });
    return { id: row.id };
  }

  /**
   * Change a quadrant's label, weight, required count or anonymity after creation.
   *
   * `code` is deliberately NOT editable: reviewer assignments, the coverage matrix and
   * the bulk generator all resolve a quadrant by its code, and renaming it under them
   * would silently orphan those references. Delete and re-add if a code is truly wrong.
   */
  async updateSource(user: AuthUser, ctx: RequestContext, cycleId: string, sourceId: string, dto: UpdateSourceDto): Promise<Record<string, unknown>> {
    const cycle = await this.cycles.getOwned(user.organizationId, cycleId);
    const before = await this.prisma.feedbackSource.findFirst({
      where: { id: sourceId, cycleId },
      select: { id: true, code: true, label: true, weight: true, requiredCount: true, isAnonymous: true, isActive: true },
    });
    if (!before) throw new NotFoundException('Source not in this cycle.');
    if (dto.label !== undefined) await this.assertLabelFree(cycleId, dto.label, sourceId);

    const data: Record<string, unknown> = {};
    if (dto.label !== undefined) data.label = dto.label;
    if (dto.weight !== undefined) data.weight = dto.weight;
    if (dto.requiredCount !== undefined) data.requiredCount = dto.requiredCount;
    if (dto.isAnonymous !== undefined) data.isAnonymous = dto.isAnonymous;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (Object.keys(data).length === 0) return { id: before.id };

    const row = await this.prisma.feedbackSource.update({ where: { id: sourceId }, data, select: { id: true, code: true, label: true, weight: true, requiredCount: true, isAnonymous: true, isActive: true } });
    await this.feedbackAudit.record({
      organizationId: user.organizationId,
      action: 'source.updated',
      actorUserId: user.userId,
      actorName: user.email,
      cycleId,
      cycleName: cycle.name,
      sourceType: row.label ?? row.code,
      entityType: 'feedback_source',
      entityId: sourceId,
      previousValue: { label: before.label, weight: Number(before.weight), requiredCount: before.requiredCount, isAnonymous: before.isAnonymous, isActive: before.isActive },
      newValue: { label: row.label, weight: Number(row.weight), requiredCount: row.requiredCount, isAnonymous: row.isAnonymous, isActive: row.isActive },
      ctx,
    });
    return { ...row, weight: Number(row.weight) };
  }

  /**
   * Two quadrants in one cycle may not share a label.
   *
   * This is not cosmetic. The report layer aggregates per-source figures by LABEL
   * (`bySource`, `radar`, `sourceCounts`), so two quadrants called the same thing —
   * easy to do with several manager levels — would silently merge into one blended
   * series rather than showing as two. Blocking it at the door is cheaper than
   * de-duplicating results afterwards.
   */
  private async assertLabelFree(cycleId: string, label: string, exceptSourceId: string | null): Promise<void> {
    const rows = await this.prisma.feedbackSource.findMany({ where: { cycleId }, select: { id: true, label: true } });
    const taken = rows.some((r) => r.id !== exceptSourceId && r.label.trim().toLowerCase() === label.trim().toLowerCase());
    if (taken) throw new ConflictException(`Another quadrant in this cycle is already called "${label}". Reports group by label, so each quadrant needs a distinct one.`);
  }

  /**
   * Set or clear the quadrant's own questionnaire.
   *
   * Passing `templateId: null` restores the default — reviewers in this quadrant answer
   * the cycle questionnaire, exactly as every cycle did before per-quadrant questionnaires
   * existed. Changing it affects forms not yet opened; answers already submitted keep
   * pointing at the questions they were given, so nothing historic is rewritten.
   */
  async setSourceTemplate(
    user: AuthUser,
    ctx: RequestContext,
    cycleId: string,
    sourceId: string,
    templateId: string | null,
  ): Promise<Record<string, unknown>> {
    const cycle = await this.cycles.getOwned(user.organizationId, cycleId);
    const source = await this.prisma.feedbackSource.findFirst({
      where: { id: sourceId, cycleId },
      select: { id: true, code: true, label: true, templateId: true },
    });
    if (!source) throw new NotFoundException('Source not in this cycle.');
    const resolved = templateId ? await this.assertTemplate(user.organizationId, templateId) : null;

    const row = await this.prisma.feedbackSource.update({
      where: { id: sourceId },
      data: { templateId: resolved },
      include: { template: { select: { id: true, name: true } } },
    });
    await this.feedbackAudit.record({
      organizationId: user.organizationId,
      action: 'source.questionnaire.changed',
      actorUserId: user.userId,
      actorName: user.email,
      cycleId,
      cycleName: cycle.name,
      sourceType: source.label ?? source.code,
      entityType: 'feedback_source',
      entityId: sourceId,
      previousValue: { templateId: source.templateId },
      newValue: { templateId: resolved },
      ctx,
    });
    return { id: row.id, templateId: row.templateId, templateName: row.template?.name ?? null };
  }

  /** Competency × quadrant coverage for the cycle setup screen (configuration, not scores). */
  /**
   * Choose how the Parents quadrant collects feedback.
   *
   * `null` (or 'standard') is the original behaviour: one secure link per teacher.
   * 'consolidated' issues one link per student listing all of that student's teachers,
   * each rating still landing on that teacher's own external assignment — so scoring,
   * the quadrant weight, the anonymity threshold and every report are unchanged.
   */
  async setParentMode(
    user: AuthUser,
    ctx: RequestContext,
    cycleId: string,
    sourceId: string,
    mode: string | null,
    requireAll: boolean,
  ): Promise<Record<string, unknown>> {
    const cycle = await this.cycles.getOwned(user.organizationId, cycleId);
    const source = await this.prisma.feedbackSource.findFirst({
      where: { id: sourceId, cycleId },
      select: { id: true, code: true, label: true, parentMode: true, templateId: true },
    });
    if (!source) throw new NotFoundException('Source not in this cycle.');
    if (source.code !== 'parent') {
      throw new BadRequestException('Parent feedback mode applies only to the Parents quadrant.');
    }
    const next = mode === 'consolidated' ? 'consolidated' : null;

    // The consolidated form asks ONE question per teacher, so the quadrant's effective
    // questionnaire must contain exactly one rating question. Checking here — where the
    // administrator can still fix it — beats failing later in front of a parent.
    if (next === 'consolidated') {
      const templateId = source.templateId ?? cycle.templateId;
      if (!templateId) {
        throw new BadRequestException(
          'Give the Parents quadrant a questionnaire before switching to the consolidated form.',
        );
      }
      const links = await this.prisma.sectionQuestion.findMany({
        where: { section: { templateId } },
        select: { question: { select: { type: true } } },
      });
      const ratings = links.filter((l) => l.question.type !== 'text').length;
      if (ratings !== 1) {
        throw new BadRequestException(
          `The consolidated form asks one question about each teacher, so the Parents questionnaire must hold exactly one rating question — this one has ${ratings}.`,
        );
      }
    }

    const row = await this.prisma.feedbackSource.update({
      where: { id: sourceId },
      data: { parentMode: next, parentRequireAll: requireAll },
      select: { id: true, code: true, label: true, parentMode: true, parentRequireAll: true },
    });
    await this.feedbackAudit.record({
      organizationId: user.organizationId,
      action: 'source.parent_mode.changed',
      actorUserId: user.userId,
      actorName: user.email,
      cycleId,
      cycleName: cycle.name,
      sourceType: source.label ?? source.code,
      entityType: 'feedback_source',
      entityId: sourceId,
      previousValue: { parentMode: source.parentMode },
      newValue: { parentMode: next, parentRequireAll: requireAll },
      ctx,
    });
    return { id: row.id, parentMode: row.parentMode, parentRequireAll: row.parentRequireAll };
  }

  async coverage(user: AuthUser, cycleId: string): Promise<Record<string, unknown>> {
    await this.cycles.getOwned(user.organizationId, cycleId);
    return cycleCoverage(this.prisma, cycleId) as unknown as Record<string, unknown>;
  }

  /** A questionnaire must belong to this tenant and contain at least one question. */
  private async assertTemplate(organizationId: string, templateId: string): Promise<string> {
    const template = await this.prisma.questionnaireTemplate.findFirst({
      where: { id: templateId, organizationId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!template) throw new NotFoundException('Questionnaire not found in this organization.');
    const questions = await this.prisma.sectionQuestion.count({ where: { section: { templateId } } });
    if (questions === 0) {
      throw new BadRequestException(
        `The questionnaire "${template.name}" has no questions. Add questions before assigning it to a quadrant.`,
      );
    }
    return template.id;
  }

  async removeSource(user: AuthUser, ctx: RequestContext, cycleId: string, sourceId: string): Promise<void> {
    const cycle = await this.cycles.getOwned(user.organizationId, cycleId);
    const src = await this.prisma.feedbackSource.findFirst({ where: { id: sourceId, cycleId }, select: { code: true, label: true, weight: true } });
    await this.prisma.feedbackSource.deleteMany({ where: { id: sourceId, cycleId } });
    await this.feedbackAudit.record({
      organizationId: user.organizationId,
      action: 'source.removed',
      actorUserId: user.userId,
      actorName: user.email,
      cycleId,
      cycleName: cycle.name,
      sourceType: src?.label ?? src?.code ?? null,
      entityType: 'feedback_source',
      entityId: sourceId,
      previousValue: src ? { code: src.code, label: src.label, weight: Number(src.weight) } : undefined,
      ctx,
    });
  }

  /* ---- Participants (appraisees) ---- */
  async listParticipants(user: AuthUser, cycleId: string): Promise<Record<string, unknown>[]> {
    await this.cycles.getOwned(user.organizationId, cycleId);
    const rows = await this.prisma.appraisalParticipant.findMany({
      where: { cycleId },
      include: { employee: { include: { user: { select: { fullName: true, email: true } } } }, _count: { select: { assignments: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      employeeId: r.employeeId,
      name: r.employee.user.fullName ?? r.employee.user.email,
      status: r.status,
      finalScore: r.finalScore ? Number(r.finalScore) : null,
      potentialRating: r.potentialRating ? Number(r.potentialRating) : null,
      assignments: r._count.assignments,
      visibility: r.visibility,
      releasedAt: r.releasedAt,
    }));
  }

  /**
   * Release (or retract) an appraisee's results. Until released, the report is
   * held for HR/manager review; releasing makes it shareable with the employee.
   */
  async setRelease(
    user: AuthUser,
    ctx: RequestContext,
    cycleId: string,
    participantId: string,
    release: boolean,
  ): Promise<Record<string, unknown>> {
    await this.cycles.getOwned(user.organizationId, cycleId);
    const participant = await this.prisma.appraisalParticipant.findFirst({
      where: { id: participantId, cycleId },
      select: { id: true, employee: { select: { userId: true } }, cycle: { select: { name: true } } },
    });
    if (!participant) throw new NotFoundException('Participant not in this cycle.');
    const row = await this.prisma.appraisalParticipant.update({
      where: { id: participantId },
      data: release
        ? { visibility: 'released', releasedAt: new Date(), releasedBy: user.userId }
        : { visibility: 'draft', releasedAt: null, releasedBy: null },
    });
    if (release) {
      // Notify the employee in-app that their results are available (NH-5).
      await this.notifications.create(user.organizationId, {
        userId: participant.employee.userId,
        type: 'results_released',
        title: 'Your 360° feedback results are ready',
        body: `Results for "${participant.cycle.name}" have been released and are now available to view.`,
        link: '/reports',
      });
    }
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: release ? 'appraisal.participant.release' : 'appraisal.participant.retract',
      entityType: 'appraisal_participant',
      entityId: participantId,
      ip: ctx.ip,
      device: ctx.device,
    });
    await this.feedbackAudit.record({
      organizationId: user.organizationId,
      action: release ? 'results.released' : 'results.retracted',
      actorUserId: user.userId,
      actorName: user.email,
      ...(await this.feedbackAudit.participantContext(participantId)),
      entityType: 'appraisal_participant',
      entityId: participantId,
      ctx,
    });
    return { id: row.id, visibility: row.visibility, releasedAt: row.releasedAt };
  }

  async addParticipant(user: AuthUser, ctx: RequestContext, cycleId: string, dto: AddParticipantDto): Promise<{ id: string }> {
    // Enrolment is allowed while draft or running, never after close/archive (F-C5).
    await this.cycles.assertNotFinalized(user.organizationId, cycleId);
    const employee = await this.prisma.employee.findFirst({
      where: { id: dto.employeeId, organizationId: user.organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!employee) throw new NotFoundException('Employee not found.');
    const clash = await this.prisma.appraisalParticipant.findFirst({ where: { cycleId, employeeId: dto.employeeId }, select: { id: true } });
    if (clash) throw new ConflictException('Employee already enrolled in this cycle.');
    const row = await this.prisma.appraisalParticipant.create({ data: { cycleId, employeeId: dto.employeeId } });
    await this.feedbackAudit.record({
      organizationId: user.organizationId,
      action: 'participant.added',
      actorUserId: user.userId,
      actorName: user.email,
      ...(await this.feedbackAudit.participantContext(row.id)),
      entityType: 'appraisal_participant',
      entityId: row.id,
      ctx,
    });
    return { id: row.id };
  }

  async removeParticipant(user: AuthUser, ctx: RequestContext, cycleId: string, participantId: string): Promise<void> {
    await this.cycles.getOwned(user.organizationId, cycleId);
    const context = await this.feedbackAudit.participantContext(participantId); // capture before delete
    await this.prisma.appraisalParticipant.deleteMany({ where: { id: participantId, cycleId } });
    await this.feedbackAudit.record({
      organizationId: user.organizationId,
      action: 'participant.removed',
      actorUserId: user.userId,
      actorName: user.email,
      ...context,
      entityType: 'appraisal_participant',
      entityId: participantId,
      ctx,
    });
  }

  /**
   * Bulk-enroll participants from a list of employee emails (HV-7). Reuses the
   * existing employee lookup and unique constraint; reports what happened per row.
   */
  async importParticipants(
    user: AuthUser,
    ctx: RequestContext,
    cycleId: string,
    emails: string[],
  ): Promise<{ added: number; skipped: number; notFound: string[] }> {
    await this.cycles.assertNotFinalized(user.organizationId, cycleId); // F-C5
    const cycle = await this.cycles.getOwned(user.organizationId, cycleId);
    const cleaned = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    let added = 0;
    let skipped = 0;
    const notFound: string[] = [];
    for (const email of cleaned) {
      const employee = await this.prisma.employee.findFirst({
        where: { organizationId: user.organizationId, deletedAt: null, user: { email: { equals: email, mode: 'insensitive' } } },
        select: { id: true },
      });
      if (!employee) {
        notFound.push(email);
        continue;
      }
      const clash = await this.prisma.appraisalParticipant.findFirst({ where: { cycleId, employeeId: employee.id }, select: { id: true } });
      if (clash) {
        skipped++;
        continue;
      }
      await this.prisma.appraisalParticipant.create({ data: { cycleId, employeeId: employee.id } });
      added++;
    }
    await this.feedbackAudit.record({
      organizationId: user.organizationId,
      action: 'participant.imported',
      actorUserId: user.userId,
      actorName: user.email,
      cycleId,
      cycleName: cycle.name,
      entityType: 'appraisal_cycle',
      entityId: cycleId,
      newValue: { added, skipped, notFound: notFound.length },
      ctx,
    });
    return { added, skipped, notFound };
  }

  /**
   * Live participation for a cycle (HV-2): completion by feedback source plus the
   * list of outstanding reviewers, for the admin nudge screen.
   */
  /**
   * Completion tracker for a cycle.
   *
   * Performance (F-P5): this loaded EVERY assignment in the cycle with four levels of
   * nested includes — thousands of fully-hydrated rows (measured ~2.3s on a
   * 1,500-person cycle) — purely to count them and list who is outstanding. The
   * counts are now aggregated in SQL, and only a bounded page of outstanding
   * reviewers is hydrated for display. `pendingTotal` reports the true count so the
   * UI can show "showing N of M".
   */
  async participation(user: AuthUser, cycleId: string, pendingLimit = 100): Promise<Record<string, unknown>> {
    await this.cycles.getOwned(user.organizationId, cycleId);

    const bySourceRows = await this.prisma.$queryRaw<
      { source: string; total: number; submitted: number }[]
    >(Prisma.sql`
      SELECT fs.label AS source,
             count(*)::int AS total,
             count(*) FILTER (WHERE ra.status = 'submitted')::int AS submitted
      FROM reviewer_assignments ra
      JOIN feedback_sources fs ON fs.id = ra.source_id
      WHERE ra.cycle_id = ${cycleId}::uuid
      GROUP BY fs.label
      ORDER BY fs.label`);

    const total = bySourceRows.reduce((s, r) => s + r.total, 0);
    const submitted = bySourceRows.reduce((s, r) => s + r.submitted, 0);
    const pendingTotal = total - submitted;

    const pendingRows = await this.prisma.reviewerAssignment.findMany({
      where: { cycleId, status: { not: 'submitted' } },
      include: {
        source: { select: { label: true } },
        reviewer: { include: { user: { select: { fullName: true, email: true } } } },
        participant: { include: { employee: { include: { user: { select: { fullName: true, email: true } } } } } },
      },
      orderBy: { createdAt: 'asc' },
      take: Math.min(500, Math.max(1, pendingLimit)),
    });

    return {
      total,
      submitted,
      completionPct: total ? Math.round((submitted / total) * 100) : 0,
      bySource: bySourceRows.map((r) => ({
        source: r.source,
        total: r.total,
        submitted: r.submitted,
        completionPct: r.total ? Math.round((r.submitted / r.total) * 100) : 0,
      })),
      pendingTotal,
      pending: pendingRows.map((a) => ({
        assignmentId: a.id,
        reviewer: a.reviewer ? a.reviewer.user.fullName ?? a.reviewer.user.email : a.externalName ?? 'External reviewer',
        appraisee: a.participant.employee.user.fullName ?? a.participant.employee.user.email,
        source: a.source.label,
        status: a.status,
        lastRemindedAt: a.lastRemindedAt,
      })),
    };
  }
}
