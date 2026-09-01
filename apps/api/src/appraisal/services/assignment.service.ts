import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';
import { DispatchService } from '../../communication/services/dispatch.service';
import { FeedbackAuditService } from '../../feedback-audit/feedback-audit.service';
import { COMM_EVENTS } from '../../communication/comm.events';
import { CycleService } from './cycle.service';
import { ScoringService } from './scoring.service';
import type { CreateAssignmentDto, SubmitFeedbackDto } from '../appraisal.dto';
import { resolveTemplateId, templateQuestionIds } from '../questionnaire-resolution';

@Injectable()
export class AssignmentService {
  private readonly logger = new Logger(AssignmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cycles: CycleService,
    private readonly scoring: ScoringService,
    private readonly dispatch: DispatchService,
    private readonly feedbackAudit: FeedbackAuditService,
  ) {}

  /**
   * Reviewer assignments for a cycle.
   *
   * Performance (F-P5): this returned EVERY assignment with four levels of nested
   * includes — for a 1,500-person cycle that is ~7,500 rows serialised into a single
   * response (measured ~2s). It now takes a bounded page and an optional
   * nominationStatus filter, so the Assignments tab pages through and the Nominations
   * queue asks only for what it needs. `limit` is capped server-side.
   */
  async list(
    user: AuthUser,
    cycleId: string,
    opts: { page?: number; pageSize?: number; nominationStatus?: string } = {},
  ): Promise<{ items: Record<string, unknown>[]; page: number; pageSize: number; total: number; totalPages: number }> {
    await this.cycles.getOwned(user.organizationId, cycleId);
    const page = Math.max(1, Number(opts.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(opts.pageSize) || 50));
    const where = {
      cycleId,
      ...(opts.nominationStatus ? { nominationStatus: opts.nominationStatus } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.reviewerAssignment.findMany({
        where,
        include: {
          participant: { include: { employee: { include: { user: { select: { fullName: true, email: true } } } } } },
          reviewer: { include: { user: { select: { fullName: true, email: true } } } },
          source: { select: { code: true, label: true } },
        },
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.reviewerAssignment.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        appraisee: r.participant.employee.user.fullName ?? r.participant.employee.user.email,
        reviewer: r.reviewer ? r.reviewer.user.fullName ?? r.reviewer.user.email : r.externalName ?? 'External reviewer',
        source: r.source.label,
        status: r.status,
        nominationStatus: r.nominationStatus,
      })),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  /** Approve or reject a proposed reviewer nomination (HV-6). */
  async setNomination(user: AuthUser, ctx: RequestContext, assignmentId: string, approved: boolean): Promise<{ id: string; nominationStatus: string }> {
    const existing = await this.prisma.reviewerAssignment.findFirst({ where: { id: assignmentId, organizationId: user.organizationId }, select: { id: true, nominationStatus: true } });
    if (!existing) throw new NotFoundException('Assignment not found.');
    const row = await this.prisma.reviewerAssignment.update({
      where: { id: assignmentId },
      data: { nominationStatus: approved ? 'approved' : 'rejected' },
    });
    await this.feedbackAudit.recordForAssignment(approved ? 'assignment.approved' : 'assignment.rejected', assignmentId, {
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorName: user.email,
      previousValue: { nominationStatus: existing.nominationStatus },
      newValue: { nominationStatus: row.nominationStatus },
      ctx,
    });
    return { id: row.id, nominationStatus: row.nominationStatus };
  }

  async create(user: AuthUser, ctx: RequestContext, cycleId: string, dto: CreateAssignmentDto): Promise<{ id: string }> {
    // Reviewers may be added while the cycle is draft or running, never after it
    // has been closed/archived (F-C5).
    await this.cycles.assertNotFinalized(user.organizationId, cycleId);
    const participant = await this.prisma.appraisalParticipant.findFirst({ where: { id: dto.participantId, cycleId }, select: { id: true } });
    if (!participant) throw new NotFoundException('Participant not in this cycle.');
    const source = await this.prisma.feedbackSource.findFirst({ where: { id: dto.sourceId, cycleId }, select: { id: true } });
    if (!source) throw new NotFoundException('Source not in this cycle.');
    const reviewer = await this.prisma.employee.findFirst({ where: { id: dto.reviewerEmployeeId, organizationId: user.organizationId, deletedAt: null }, select: { id: true } });
    if (!reviewer) throw new NotFoundException('Reviewer not found.');

    try {
      const row = await this.prisma.reviewerAssignment.create({
        data: {
          organizationId: user.organizationId,
          cycleId,
          participantId: dto.participantId,
          sourceId: dto.sourceId,
          reviewerEmployeeId: dto.reviewerEmployeeId,
          // Nominations require manager approval before the reviewer sees the task.
          nominationStatus: dto.propose ? 'proposed' : 'approved',
        },
      });
      await this.feedbackAudit.recordForAssignment('assignment.created', row.id, {
        organizationId: user.organizationId,
        actorUserId: user.userId,
        actorName: user.email,
        newValue: { nominationStatus: dto.propose ? 'proposed' : 'approved' },
        ctx,
      });
      return { id: row.id };
    } catch {
      throw new ConflictException('This reviewer is already assigned for this source.');
    }
  }

  /** Reviews assigned to the current user (as a reviewer employee). */
  async myReviews(user: AuthUser): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.reviewerAssignment.findMany({
      where: {
        organizationId: user.organizationId,
        reviewer: { userId: user.userId },
        status: { in: ['pending', 'in_progress'] },
        nominationStatus: 'approved',
      },
      include: {
        participant: {
          include: {
            cycle: { select: { name: true, submissionDeadline: true } },
            employee: {
              include: {
                user: { select: { fullName: true, email: true } },
                designation: { select: { name: true } },
                department: { select: { name: true } },
              },
            },
          },
        },
        source: { select: { code: true, label: true, isAnonymous: true } },
        _count: { select: { responses: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      cycle: r.participant.cycle.name,
      // The appraisee is ALWAYS named to their own assigned reviewer. `isAnonymous`
      // is a property of the quadrant and protects the *evaluator's* identity in the
      // appraisee's report (reports.service, min_responses_to_show) — it never means
      // "hide the person being reviewed". Masking it here left two thirds of review
      // tasks (peer/subordinate/parent) titled "Confidential" with no way to tell
      // whose performance was being rated, while the invitation e-mail for the very
      // same assignment named them anyway.
      appraisee: r.participant.employee.user.fullName ?? r.participant.employee.user.email,
      appraiseeTitle: r.participant.employee.designation?.name ?? null,
      appraiseeDepartment: r.participant.employee.department?.name ?? null,
      source: r.source.label,
      sourceCode: r.source.code,
      /** True when THIS reviewer's identity is withheld from the appraisee's report. */
      anonymousToAppraisee: r.source.isAnonymous,
      status: r.status,
      answered: r._count.responses,
      deadline: r.participant.cycle.submissionDeadline,
    }));
  }

  /** Template questions for an assignment + any saved responses. */
  async form(user: AuthUser, assignmentId: string): Promise<Record<string, unknown>> {
    const assignment = await this.requireReviewer(user, assignmentId);
    const cycle = await this.prisma.appraisalCycle.findUniqueOrThrow({
      where: { id: assignment.cycleId },
      select: { templateId: true, ratingScaleId: true, name: true, submissionDeadline: true },
    });
    // Which questionnaire this reviewer answers: their quadrant's own template when one
    // is configured, otherwise the cycle's. A cycle created before per-quadrant
    // questionnaires existed has no source template, so this returns cycle.templateId
    // and the form is identical to what it always was.
    const templateId = await resolveTemplateId(this.prisma, assignment.cycleId, assignment.sourceId);
    // Who am I reviewing, and in which quadrant? The form used to return questions
    // only, so a reviewer who opened a task had no idea whose performance they were
    // rating. Same disclosure rule as myReviews(): name the appraisee, and state
    // whether the reviewer's own identity is withheld from them.
    const context = await this.prisma.reviewerAssignment.findUniqueOrThrow({
      where: { id: assignmentId },
      select: {
        participant: {
          select: {
            employee: {
              select: {
                user: { select: { fullName: true, email: true } },
                designation: { select: { name: true } },
                department: { select: { name: true } },
              },
            },
          },
        },
        source: { select: { code: true, label: true, isAnonymous: true } },
      },
    });
    const questions = templateId ? await this.templateQuestions(templateId) : [];
    const responses = await this.prisma.feedbackResponse.findMany({ where: { assignmentId }, select: { questionId: true, ratingValue: true, textValue: true } });
    const answered = new Map(responses.map((r) => [r.questionId, r]));
    // Behavioural anchors: the rating-scale levels shown inline on the form (NH-4).
    const scale = cycle.ratingScaleId
      ? await this.prisma.ratingScaleLevel.findMany({
          where: { ratingScaleId: cycle.ratingScaleId },
          orderBy: { sortOrder: 'asc' },
          select: { value: true, label: true, color: true },
        })
      : [];
    return {
      id: assignment.id,
      status: assignment.status,
      appraisee: context.participant.employee.user.fullName ?? context.participant.employee.user.email,
      appraiseeTitle: context.participant.employee.designation?.name ?? null,
      appraiseeDepartment: context.participant.employee.department?.name ?? null,
      cycle: cycle.name,
      source: context.source.label,
      sourceCode: context.source.code,
      anonymousToAppraisee: context.source.isAnonymous,
      deadline: cycle.submissionDeadline,
      scale: scale.map((l) => ({ value: Number(l.value), label: l.label, color: l.color })),
      questions: questions.map((q) => ({
        id: q.id,
        text: q.text,
        type: q.type,
        ratingValue: answered.get(q.id)?.ratingValue ? Number(answered.get(q.id)!.ratingValue) : null,
        textValue: answered.get(q.id)?.textValue ?? null,
      })),
    };
  }

  async submit(user: AuthUser, ctx: RequestContext, assignmentId: string, dto: SubmitFeedbackDto): Promise<{ status: string; score: number | null }> {
    const assignment = await this.requireWritableAssignment(user, assignmentId);
    if (assignment.status === 'submitted') throw new BadRequestException('Feedback already submitted.');
    await this.assertValidResponses(assignment.cycleId, assignment.sourceId, dto.responses); // F-H4
    await this.prisma.$transaction(async (tx) => {
      for (const item of dto.responses) {
        await tx.feedbackResponse.upsert({
          where: { assignment_question: { assignmentId, questionId: item.questionId } },
          update: { ratingValue: item.ratingValue ?? null, textValue: item.textValue ?? null },
          create: { assignmentId, questionId: item.questionId, ratingValue: item.ratingValue ?? null, textValue: item.textValue ?? null },
        });
      }
      await tx.reviewerAssignment.update({ where: { id: assignmentId }, data: { status: 'submitted', submittedAt: new Date() } });
    });
    const score = await this.scoring.compute(assignment.participantId);
    await this.confirmSubmission(user.organizationId, assignmentId);
    // Audit the submission (action + recomputed score only — NOT the responses).
    await this.feedbackAudit.recordForAssignment('evaluation.submitted', assignmentId, {
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorName: user.email,
      newValue: { status: 'submitted', answered: dto.responses.length, score },
      ctx,
    });
    return { status: 'submitted', score };
  }

  /** Communication v2: confirm to the evaluator that their feedback was recorded. */
  private async confirmSubmission(orgId: string, assignmentId: string): Promise<void> {
    try {
      const a = await this.prisma.reviewerAssignment.findFirst({
        where: { id: assignmentId, organizationId: orgId },
        include: {
          reviewer: { include: { user: { select: { id: true, email: true, fullName: true } } } },
          participant: {
            include: {
              cycle: { select: { name: true } },
              employee: { include: { user: { select: { fullName: true, email: true } } } },
            },
          },
        },
      });
      if (!a || !a.reviewer) return;
      await this.dispatch.notifyUser(orgId, null, COMM_EVENTS.feedbackSubmitted, {
        userId: a.reviewer.user.id,
        email: a.reviewer.user.email,
        inAppType: 'feedback_submitted',
        inAppLink: '/appraisal',
        context: {
          evaluatorName: a.reviewer.user.fullName ?? 'there',
          employeeName: a.participant.employee.user.fullName ?? a.participant.employee.user.email ?? 'a colleague',
          feedbackCycle: a.participant.cycle.name,
        },
      });
    } catch (error) {
      this.logger.warn(`feedback_submitted confirmation failed for ${assignmentId}: ${(error as Error).message}`);
    }
  }

  /**
   * Persist partial answers without finalising, so a reviewer can leave and
   * resume. Marks the assignment 'in_progress' (never overwrites a submission)
   * and does not recompute scores. Returns how many questions are answered.
   */
  async saveDraft(user: AuthUser, ctx: RequestContext, assignmentId: string, dto: SubmitFeedbackDto): Promise<{ status: string; answered: number }> {
    const assignment = await this.requireWritableAssignment(user, assignmentId);
    if (assignment.status === 'submitted') throw new BadRequestException('Feedback already submitted.');
    await this.assertValidResponses(assignment.cycleId, assignment.sourceId, dto.responses); // F-H4
    const firstTouch = assignment.status !== 'in_progress';
    await this.prisma.$transaction(async (tx) => {
      for (const item of dto.responses) {
        await tx.feedbackResponse.upsert({
          where: { assignment_question: { assignmentId, questionId: item.questionId } },
          update: { ratingValue: item.ratingValue ?? null, textValue: item.textValue ?? null },
          create: { assignmentId, questionId: item.questionId, ratingValue: item.ratingValue ?? null, textValue: item.textValue ?? null },
        });
      }
      if (firstTouch) {
        await tx.reviewerAssignment.update({ where: { id: assignmentId }, data: { status: 'in_progress' } });
      }
    });
    const answered = await this.prisma.feedbackResponse.count({ where: { assignmentId } });
    // First save = evaluation started; subsequent saves = draft saved.
    await this.feedbackAudit.recordForAssignment(firstTouch ? 'evaluation.started' : 'evaluation.saved', assignmentId, {
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorName: user.email,
      newValue: { answered },
      ctx,
    });
    return { status: 'in_progress', answered };
  }

  private async requireReviewer(user: AuthUser, assignmentId: string) {
    const assignment = await this.prisma.reviewerAssignment.findFirst({
      where: { id: assignmentId, organizationId: user.organizationId },
      include: { reviewer: { select: { userId: true } } },
    });
    if (!assignment) throw new NotFoundException('Assignment not found.');
    if (!assignment.reviewer || assignment.reviewer.userId !== user.userId) throw new ForbiddenException('This review is not assigned to you.');
    return assignment;
  }

  /**
   * Reviewer check PLUS an open-cycle check, for the paths that change feedback
   * (F-C5). Reading a form stays allowed on a closed cycle so a reviewer can still
   * see what they submitted; only modifications are blocked once the cycle ends.
   */
  private async requireWritableAssignment(user: AuthUser, assignmentId: string) {
    const assignment = await this.requireReviewer(user, assignmentId);
    await this.cycles.assertOpen(user.organizationId, assignment.cycleId);
    // A nomination that is still awaiting approval — or was rejected — must not be
    // able to contribute feedback (F-H3). Only the reviewer LIST filtered on this
    // before, so a rejected nominee could still open the form, submit, and have
    // their ratings counted in the appraisee's score.
    if (assignment.nominationStatus && assignment.nominationStatus !== 'approved') {
      throw new BadRequestException(
        assignment.nominationStatus === 'rejected'
          ? 'This nomination was not approved, so feedback cannot be submitted.'
          : 'This nomination is still awaiting approval.',
      );
    }
    return assignment;
  }

  /**
   * Validate submitted answers against the cycle's questionnaire and rating scale (F-H4).
   *
   * `FeedbackResponse.questionId` has no foreign key and ratings had no bounds, so a
   * reviewer could post answers for arbitrary question ids, or ratings far outside the
   * scale, and those values were averaged straight into the final score — silently
   * inflating (or destroying) it and desynchronising the score from the competency
   * reports, which only count questions that belong to the template.
   *
   * Answers are therefore restricted to the questions actually on the cycle's
   * questionnaire, and ratings must fall inside the configured scale.
   */
  private async assertValidResponses(
    cycleId: string,
    sourceId: string | null,
    responses: { questionId: string; ratingValue?: number }[],
  ): Promise<void> {
    if (responses.length === 0) return;
    const cycle = await this.prisma.appraisalCycle.findUniqueOrThrow({
      where: { id: cycleId },
      select: { templateId: true, ratingScaleId: true },
    });
    // Answers are checked against the questionnaire this reviewer was actually shown —
    // their quadrant's template if it has one, else the cycle's. Validating against the
    // cycle template alone would reject every answer from a quadrant with its own
    // questionnaire.
    const templateId = await resolveTemplateId(this.prisma, cycleId, sourceId);
    if (!templateId) throw new BadRequestException('This cycle has no questionnaire, so feedback cannot be recorded.');

    const allowed = await templateQuestionIds(this.prisma, templateId);
    const unknown = responses.filter((r) => !allowed.has(r.questionId));
    if (unknown.length > 0) {
      throw new BadRequestException('One or more answers do not belong to this questionnaire.');
    }

    // Rating bounds: prefer the cycle's scale, else the scale attached to the question.
    const rated = responses.filter((r) => typeof r.ratingValue === 'number');
    if (rated.length === 0) return;
    const scaleIds = new Set<string>();
    if (cycle.ratingScaleId) scaleIds.add(cycle.ratingScaleId);
    const questionScales = await this.prisma.question.findMany({
      where: { id: { in: rated.map((r) => r.questionId) } },
      select: { id: true, ratingScaleId: true },
    });
    for (const q of questionScales) if (q.ratingScaleId) scaleIds.add(q.ratingScaleId);
    if (scaleIds.size === 0) return;

    const scales = await this.prisma.ratingScale.findMany({
      where: { id: { in: [...scaleIds] } },
      select: { id: true, minValue: true, maxValue: true },
    });
    const byId = new Map(scales.map((s) => [s.id, s]));
    for (const r of rated) {
      const scaleId = cycle.ratingScaleId ?? questionScales.find((q) => q.id === r.questionId)?.ratingScaleId;
      const scale = scaleId ? byId.get(scaleId) : undefined;
      if (!scale) continue;
      const min = Number(scale.minValue);
      const max = Number(scale.maxValue);
      const value = r.ratingValue as number;
      if (!Number.isFinite(value) || value < min || value > max) {
        throw new BadRequestException(`Ratings must be between ${min} and ${max}.`);
      }
    }
  }

  private async templateQuestions(templateId: string): Promise<{ id: string; text: string; type: string }[]> {
    const sections = await this.prisma.templateSection.findMany({
      where: { templateId },
      orderBy: { sortOrder: 'asc' },
      include: { questions: { orderBy: { sortOrder: 'asc' }, include: { question: { select: { id: true, text: true, type: true } } } } },
    });
    return sections.flatMap((s) => s.questions.map((sq) => sq.question)) as { id: string; text: string; type: string }[];
  }
}
