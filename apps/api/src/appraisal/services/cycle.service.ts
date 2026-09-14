import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { submissionDeadlinePassed } from '../../common/dates/submission-deadline';
import { AuditService } from '../../common/audit/audit.service';
import { FeedbackAuditService } from '../../feedback-audit/feedback-audit.service';
import { WebhookService } from '../../integration/services/webhook.service';
import { DispatchService } from '../../communication/services/dispatch.service';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';
import type { CreateCycleDto, UpdateCycleDto } from '../appraisal.dto';
import { EntitlementService } from '../../license/entitlement.service';

@Injectable()
export class CycleService {
  private readonly logger = new Logger(CycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementService,
    private readonly feedbackAudit: FeedbackAuditService,
    private readonly webhooks: WebhookService,
    private readonly dispatch: DispatchService,
  ) {}

  async list(user: AuthUser): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.appraisalCycle.findMany({
      where: { organizationId: user.organizationId, deletedAt: null },
      orderBy: { startDate: 'desc' },
      include: { _count: { select: { participants: true, sources: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      startDate: r.startDate,
      endDate: r.endDate,
      // Surfaced in the list, not just the detail, because the deadline is what silently
      // stops feedback being accepted — an administrator should be able to see it on the
      // cycle card rather than discover it from a parent who could not submit.
      submissionDeadline: r.submissionDeadline,
      participants: r._count.participants,
      sources: r._count.sources,
    }));
  }

  async get(user: AuthUser, id: string): Promise<Record<string, unknown>> {
    const row = await this.getOwned(user.organizationId, id);
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      startDate: row.startDate,
      endDate: row.endDate,
      submissionDeadline: row.submissionDeadline,
      templateId: row.templateId,
      ratingScaleId: row.ratingScaleId,
    };
  }

  async create(user: AuthUser, ctx: RequestContext, dto: CreateCycleDto): Promise<{ id: string }> {
    if (new Date(dto.endDate) < new Date(dto.startDate)) {
      throw new BadRequestException('End date must be after start date.');
    }
    // Plan limits are checked before anything is written, so a refusal never leaves a
    // half-created cycle behind.
    await this.entitlements.assertWithinLimit(user.organizationId, 'maxCyclesPerYear', 1);
    const row = await this.prisma.appraisalCycle.create({
      data: {
        organizationId: user.organizationId,
        name: dto.name,
        startDate: new Date(dto.startDate),
        endDate: new Date(dto.endDate),
        submissionDeadline: dto.submissionDeadline ? new Date(dto.submissionDeadline) : null,
        templateId: dto.templateId ?? null,
        ratingScaleId: dto.ratingScaleId ?? null,
        createdBy: user.userId,
        updatedBy: user.userId,
      },
    });
    await this.record(user, ctx, 'appraisal.cycle.create', row.id, dto);
    await this.feedbackAudit.record({
      organizationId: user.organizationId,
      action: 'cycle.created',
      actorUserId: user.userId,
      actorName: user.email,
      cycleId: row.id,
      cycleName: dto.name,
      entityType: 'appraisal_cycle',
      entityId: row.id,
      newValue: { name: dto.name, startDate: dto.startDate, endDate: dto.endDate, submissionDeadline: dto.submissionDeadline ?? null },
      ctx,
    });
    return { id: row.id };
  }

  async setStatus(user: AuthUser, ctx: RequestContext, id: string, status: 'active' | 'closed' | 'archived'): Promise<{ id: string; status: string }> {
    const existing = await this.getOwned(user.organizationId, id);
    // The active-cycle cap belongs here rather than at creation: a cycle is created as
    // a draft, and drafts cost nothing. Re-activating counts the same as a first
    // activation, and a cycle that is already active is not counted twice.
    if (status === 'active' && existing.status !== 'active') {
      await this.entitlements.assertWithinLimit(user.organizationId, 'maxActiveCycles', 1);
    }
    await this.prisma.appraisalCycle.update({ where: { id }, data: { status, updatedBy: user.userId } });
    await this.record(user, ctx, `appraisal.cycle.${status}`, id, null);
    // Semantic feedback-trail action: re-activating a closed/archived cycle is a
    // "reopened", first activation is "started".
    const wasInactive = existing.status === 'closed' || existing.status === 'archived';
    const feedbackAction = status === 'active' ? (wasInactive ? 'cycle.reopened' : 'cycle.started') : `cycle.${status}`;
    await this.feedbackAudit.record({
      organizationId: user.organizationId,
      action: feedbackAction,
      actorUserId: user.userId,
      actorName: user.email,
      cycleId: id,
      cycleName: existing.name,
      entityType: 'appraisal_cycle',
      entityId: id,
      previousValue: { status: existing.status },
      newValue: { status },
      ctx,
    });
    // Emit a domain event to any subscribed outbound webhooks (fire-and-forget).
    await this.webhooks.dispatch(user.organizationId, `appraisal.cycle.${status}`, { cycleId: id, status });
    // Communication v2: on activation auto-notify every assigned evaluator; on
    // close notify participants. The dispatcher never throws, so a delivery
    // problem cannot roll back the status change.
    // Fan-out is queued, not awaited (F-P1). Activating a large cycle notifies every
    // assigned evaluator; awaiting that made the HTTP request scale with the number of
    // assignments (thousands on a bulk-generated cycle) and time out — leaving the
    // admin unsure whether the cycle had started. The status change is already
    // committed above, and the dispatcher is documented never to throw, so delivery
    // proceeds in the background and failures are logged rather than lost.
    if (status === 'active') {
      void this.dispatch
        .notifyCycleStarted(user.organizationId, user.userId, id)
        .catch((e: Error) => this.logger.warn(`Cycle-start notification failed for ${id}: ${e.message}`));
    } else if (status === 'closed') {
      void this.dispatch
        .notifyCycleClosed(user.organizationId, user.userId, id)
        .catch((e: Error) => this.logger.warn(`Cycle-close notification failed for ${id}: ${e.message}`));
    }
    return { id, status };
  }

  /** Duplicate a cycle and its feedback sources into a fresh draft (HV-5). */
  async clone(user: AuthUser, ctx: RequestContext, id: string): Promise<{ id: string }> {
    const source = await this.getOwned(user.organizationId, id);
    const sources = await this.prisma.feedbackSource.findMany({ where: { cycleId: id } });
    const created = await this.prisma.$transaction(async (tx) => {
      const cycle = await tx.appraisalCycle.create({
        data: {
          organizationId: user.organizationId,
          name: `${source.name} (copy)`,
          startDate: source.startDate,
          endDate: source.endDate,
          submissionDeadline: source.submissionDeadline,
          status: 'draft',
          templateId: source.templateId,
          ratingScaleId: source.ratingScaleId,
          createdBy: user.userId,
          updatedBy: user.userId,
        },
      });
      if (sources.length > 0) {
        await tx.feedbackSource.createMany({
          data: sources.map((s) => ({
            cycleId: cycle.id,
            code: s.code,
            label: s.label,
            weight: s.weight,
            requiredCount: s.requiredCount,
            isAnonymous: s.isAnonymous,
            isActive: s.isActive,
            // A quadrant's own questionnaire is part of its configuration, so the clone
            // must carry it. Omitting it silently reverted the clone to inheriting the
            // cycle questionnaire — changing what reviewers are asked and turning every
            // quadrant-specific competency into a shared one, with nothing to show for it.
            templateId: s.templateId,
          })),
        });
      }
      return cycle;
    });
    await this.record(user, ctx, 'appraisal.cycle.clone', created.id, { from: id });
    await this.feedbackAudit.record({
      organizationId: user.organizationId,
      action: 'cycle.cloned',
      actorUserId: user.userId,
      actorName: user.email,
      cycleId: created.id,
      cycleName: `${source.name} (copy)`,
      entityType: 'appraisal_cycle',
      entityId: created.id,
      newValue: { clonedFromCycleId: id, clonedFromName: source.name },
      ctx,
    });
    return { id: created.id };
  }

  async getOwned(organizationId: string, id: string) {
    const row = await this.prisma.appraisalCycle.findFirst({ where: { id, organizationId, deletedAt: null } });
    if (!row) throw new NotFoundException('Appraisal cycle not found.');
    return row;
  }

  /**
   * Guard for SUBMITTING feedback (F-C5).
   *
   * Previously nothing checked the cycle's status, so feedback could still be
   * submitted into a *closed* cycle and the submissionDeadline was purely
   * decorative — published results kept moving after the cycle ended, and a late
   * submission could silently overwrite a calibrated score.
   *
   * Feedback is accepted only while the cycle is `active` and on/before its deadline.
   */
  async assertOpen(organizationId: string, cycleId: string): Promise<void> {
    const cycle = await this.getOwned(organizationId, cycleId);
    if (cycle.status !== 'active') {
      throw new BadRequestException(
        cycle.status === 'draft'
          ? 'This feedback cycle has not been activated yet.'
          : `This feedback cycle is ${cycle.status} and no longer accepts feedback.`,
      );
    }
    if (submissionDeadlinePassed(cycle.submissionDeadline)) {
      throw new BadRequestException('The submission deadline for this feedback cycle has passed.');
    }
  }

  /**
   * Edit a cycle in place (F-C5 follow-up).
   *
   * Until now a cycle could be created, activated, closed and cloned but never
   * edited, so a submission deadline set wrongly could only be corrected with SQL
   * against the live database — and `clone()` copies `submissionDeadline` from its
   * source, so cloning did not help either. Extending a deadline on a running cycle
   * is an ordinary administrative act and should not require a DBA.
   *
   * Only `draft` and `active` cycles are editable. Re-dating a closed or archived
   * cycle would silently change which feedback its published results were allowed to
   * contain; re-activating first makes that an explicit, audited decision.
   */
  async update(user: AuthUser, ctx: RequestContext, id: string, dto: UpdateCycleDto): Promise<Record<string, unknown>> {
    const existing = await this.getOwned(user.organizationId, id);
    if (existing.status !== 'draft' && existing.status !== 'active') {
      throw new BadRequestException(
        `This cycle is ${existing.status} and cannot be edited. Re-activate it first if you genuinely intend to change a finished cycle.`,
      );
    }

    const startDate = dto.startDate ? new Date(dto.startDate) : existing.startDate;
    const endDate = dto.endDate ? new Date(dto.endDate) : existing.endDate;
    if (endDate < startDate) throw new BadRequestException('End date must be after start date.');

    const data: Prisma.AppraisalCycleUpdateInput = { updatedBy: user.userId };
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.startDate !== undefined) data.startDate = startDate;
    if (dto.endDate !== undefined) data.endDate = endDate;
    // `in` rather than `!== undefined`: an explicit null CLEARS the deadline, which is
    // the documented way to say "this cycle runs until it is closed by hand". Omitting
    // the key leaves whatever is stored alone.
    if ('submissionDeadline' in dto) {
      data.submissionDeadline = dto.submissionDeadline ? new Date(dto.submissionDeadline) : null;
    }
    if (dto.templateId !== undefined) data.templateId = dto.templateId;
    if (dto.ratingScaleId !== undefined) data.ratingScaleId = dto.ratingScaleId;

    const row = await this.prisma.appraisalCycle.update({ where: { id }, data });

    await this.record(user, ctx, 'appraisal.cycle.update', id, dto);
    // The feedback trail gets the BEFORE and AFTER of the dates specifically: a moved
    // deadline changes which responses a cycle was allowed to accept, so anyone reading
    // an old result later needs to see that it moved, when, and who moved it.
    await this.feedbackAudit.record({
      organizationId: user.organizationId,
      action: 'cycle.updated',
      actorUserId: user.userId,
      actorName: user.email,
      cycleId: id,
      cycleName: row.name,
      entityType: 'appraisal_cycle',
      entityId: id,
      previousValue: {
        name: existing.name,
        startDate: existing.startDate,
        endDate: existing.endDate,
        submissionDeadline: existing.submissionDeadline,
      },
      newValue: {
        name: row.name,
        startDate: row.startDate,
        endDate: row.endDate,
        submissionDeadline: row.submissionDeadline,
      },
      ctx,
    });

    return {
      id: row.id,
      name: row.name,
      status: row.status,
      startDate: row.startDate,
      endDate: row.endDate,
      submissionDeadline: row.submissionDeadline,
      templateId: row.templateId,
      ratingScaleId: row.ratingScaleId,
    };
  }

  /**
   * Guard for STRUCTURAL changes — adding participants or reviewer assignments (F-C5).
   * Deliberately more permissive than `assertOpen`: setup legitimately happens while
   * a cycle is still `draft` (bulk generation builds the whole cycle before
   * activating it), and evaluators may be added to a running cycle. What must never
   * happen is changing the roster of a cycle that has already been closed/archived.
   */
  async assertNotFinalized(organizationId: string, cycleId: string): Promise<void> {
    const cycle = await this.getOwned(organizationId, cycleId);
    if (cycle.status === 'closed' || cycle.status === 'archived') {
      throw new BadRequestException(`This feedback cycle is ${cycle.status} and can no longer be changed.`);
    }
  }

  private async record(user: AuthUser, ctx: RequestContext, action: string, entityId: string, newValue: unknown): Promise<void> {
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action,
      entityType: 'appraisal_cycle',
      entityId,
      newValue: newValue ?? undefined,
      ip: ctx.ip,
      device: ctx.device,
    });
  }
}
