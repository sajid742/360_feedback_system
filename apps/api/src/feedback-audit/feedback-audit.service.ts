import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';

/** IP + user-agent for an audit event (device === user-agent). */
export interface AuditCtx {
  ip?: string | null;
  device?: string | null;
}

/** Everything a single feedback-audit event can capture. Only `organizationId`,
 *  `action` and `entityType` are required; the rest are filled where applicable. */
export interface FeedbackAuditInput {
  organizationId: string;
  action: string;
  /** Actor. Omit userId for anonymous (parent) or system (scheduler) events. */
  actorUserId?: string | null;
  actorName?: string | null;
  actorRole?: string | null;
  cycleId?: string | null;
  cycleName?: string | null;
  evaluateeEmployeeId?: string | null;
  evaluateeName?: string | null;
  evaluatorEmployeeId?: string | null;
  evaluatorName?: string | null;
  sourceType?: string | null;
  entityType: string;
  entityId?: string | null;
  previousValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
  ctx?: AuditCtx | null;
}

/** Filters accepted by the admin Audit Trail query. */
export interface FeedbackAuditQuery {
  search?: string;
  from?: string;
  to?: string;
  cycleId?: string;
  evaluateeEmployeeId?: string;
  evaluatorEmployeeId?: string;
  actorUserId?: string;
  /** Name-contains filters (so the UI can filter without loading id lists). */
  evaluatee?: string;
  evaluator?: string;
  actor?: string;
  action?: string;
  sourceType?: string;
  entityType?: string;
  entityId?: string;
  limit?: number;
  offset?: number;
}

/**
 * Writes and reads the dedicated, append-only 360 Feedback Audit Trail
 * (`feedback_audit_events`). Recording NEVER throws — auditing must not break the
 * operation it records — so `record()` swallows and logs its own errors. Reads are
 * used only by the admin controller (gated by `feedback.audit.read`).
 *
 * The service records action + record identifiers, deliberately NOT the sensitive
 * feedback content itself (ratings/comments), per the audit design.
 */
@Injectable()
export class FeedbackAuditService {
  private readonly logger = new Logger(FeedbackAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Append one event. Resolves actor name/role when only a userId is supplied. */
  async record(input: FeedbackAuditInput): Promise<void> {
    try {
      let actorName = input.actorName ?? null;
      let actorRole = input.actorRole ?? null;
      if (input.actorUserId && (!actorName || !actorRole)) {
        const resolved = await this.resolveActor(input.actorUserId);
        actorName = actorName ?? resolved.name;
        actorRole = actorRole ?? resolved.role;
      }
      await this.prisma.feedbackAuditEvent.create({
        data: {
          organizationId: input.organizationId,
          action: input.action,
          actorUserId: input.actorUserId ?? null,
          actorName,
          actorRole,
          cycleId: input.cycleId ?? null,
          cycleName: input.cycleName ?? null,
          evaluateeEmployeeId: input.evaluateeEmployeeId ?? null,
          evaluateeName: input.evaluateeName ?? null,
          evaluatorEmployeeId: input.evaluatorEmployeeId ?? null,
          evaluatorName: input.evaluatorName ?? null,
          sourceType: input.sourceType ?? null,
          entityType: input.entityType,
          entityId: input.entityId ?? null,
          previousValue: this.asJson(input.previousValue),
          newValue: this.asJson(input.newValue),
          reason: input.reason ?? null,
          ip: input.ctx?.ip ?? null,
          userAgent: input.ctx?.device ?? null,
        },
      });
    } catch (error) {
      this.logger.warn(`feedback audit '${input.action}' failed: ${(error as Error).message}`);
    }
  }

  /**
   * Record an event that concerns a reviewer assignment, enriching it with the
   * cycle, evaluatee, evaluator and source automatically. Extra fields override.
   */
  async recordForAssignment(
    action: string,
    assignmentId: string,
    extra: Partial<FeedbackAuditInput> & { organizationId: string },
  ): Promise<void> {
    const ctx = await this.assignmentContext(assignmentId);
    await this.record({
      action,
      entityType: 'reviewer_assignment',
      entityId: assignmentId,
      ...ctx,
      ...extra,
    });
  }

  /** Record an event that concerns an evaluation (parent/secure) link. */
  async recordForLink(
    action: string,
    linkId: string,
    extra: Partial<FeedbackAuditInput> & { organizationId: string },
  ): Promise<void> {
    const ctx = await this.linkContext(linkId);
    await this.record({
      action,
      entityType: 'evaluation_link',
      entityId: linkId,
      ...ctx,
      ...extra,
    });
  }

  /** Cycle name/id for enrichment (best-effort). */
  async cycleContext(cycleId: string): Promise<{ cycleId: string; cycleName: string | null }> {
    try {
      const c = await this.prisma.appraisalCycle.findUnique({ where: { id: cycleId }, select: { name: true } });
      return { cycleId, cycleName: c?.name ?? null };
    } catch {
      return { cycleId, cycleName: null };
    }
  }

  /** Cycle + evaluatee for a participant (best-effort). */
  async participantContext(participantId: string): Promise<Partial<FeedbackAuditInput>> {
    try {
      const p = await this.prisma.appraisalParticipant.findUnique({
        where: { id: participantId },
        select: {
          cycleId: true,
          cycle: { select: { name: true } },
          employee: { select: { id: true, user: { select: { fullName: true, email: true } } } },
        },
      });
      if (!p) return {};
      return {
        cycleId: p.cycleId,
        cycleName: p.cycle?.name ?? null,
        evaluateeEmployeeId: p.employee?.id ?? null,
        evaluateeName: p.employee?.user?.fullName ?? p.employee?.user?.email ?? null,
      };
    } catch {
      return {};
    }
  }

  /** Full context for a reviewer assignment (best-effort). Cycle is reached via
   *  the participant (ReviewerAssignment has no direct cycle relation). */
  private async assignmentContext(assignmentId: string): Promise<Partial<FeedbackAuditInput>> {
    try {
      const a = await this.prisma.reviewerAssignment.findUnique({
        where: { id: assignmentId },
        select: {
          externalName: true,
          reviewer: { select: { id: true, user: { select: { fullName: true, email: true } } } },
          participant: {
            select: {
              cycleId: true,
              cycle: { select: { name: true } },
              employee: { select: { id: true, user: { select: { fullName: true, email: true } } } },
            },
          },
          source: { select: { label: true, code: true } },
        },
      });
      if (!a) return {};
      return {
        cycleId: a.participant?.cycleId ?? null,
        cycleName: a.participant?.cycle?.name ?? null,
        evaluateeEmployeeId: a.participant?.employee?.id ?? null,
        evaluateeName: a.participant?.employee?.user?.fullName ?? a.participant?.employee?.user?.email ?? null,
        evaluatorEmployeeId: a.reviewer?.id ?? null,
        evaluatorName: a.reviewer?.user?.fullName ?? a.reviewer?.user?.email ?? a.externalName ?? null,
        sourceType: a.source?.label ?? a.source?.code ?? null,
      };
    } catch {
      return {};
    }
  }

  /** Context for an evaluation link (only scalar FKs on the model → resolve by id). */
  private async linkContext(linkId: string): Promise<Partial<FeedbackAuditInput>> {
    try {
      const link = await this.prisma.evaluationLink.findUnique({
        where: { id: linkId },
        select: { reviewerAssignmentId: true, cycleId: true, employeeId: true },
      });
      if (!link) return {};
      const base: Partial<FeedbackAuditInput> = { sourceType: 'Parent' };
      if (link.cycleId) {
        const c = await this.prisma.appraisalCycle.findUnique({ where: { id: link.cycleId }, select: { name: true } });
        base.cycleId = link.cycleId;
        base.cycleName = c?.name ?? null;
      }
      if (link.employeeId) {
        const e = await this.prisma.employee.findUnique({ where: { id: link.employeeId }, select: { user: { select: { fullName: true, email: true } } } });
        base.evaluateeEmployeeId = link.employeeId;
        base.evaluateeName = e?.user?.fullName ?? e?.user?.email ?? null;
      }
      if (link.reviewerAssignmentId) {
        const asg = await this.assignmentContext(link.reviewerAssignmentId);
        return { ...asg, ...base };
      }
      return base;
    } catch {
      return {};
    }
  }

  private async resolveActor(userId: string): Promise<{ name: string | null; role: string | null }> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { fullName: true, email: true, userRoles: { select: { role: { select: { name: true } } } } },
      });
      if (!user) return { name: null, role: null };
      const roles = user.userRoles.map((r) => r.role.name).filter(Boolean);
      return { name: user.fullName ?? user.email ?? null, role: roles.length ? roles.join(', ') : null };
    } catch {
      return { name: null, role: null };
    }
  }

  private asJson(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined || value === null) return undefined;
    return value as Prisma.InputJsonValue;
  }

  /* --------------------------- Read side (admin) --------------------------- */

  private where(organizationId: string, q: FeedbackAuditQuery): Prisma.FeedbackAuditEventWhereInput {
    const where: Prisma.FeedbackAuditEventWhereInput = { organizationId };
    if (q.cycleId) where.cycleId = q.cycleId;
    if (q.evaluateeEmployeeId) where.evaluateeEmployeeId = q.evaluateeEmployeeId;
    if (q.evaluatorEmployeeId) where.evaluatorEmployeeId = q.evaluatorEmployeeId;
    if (q.actorUserId) where.actorUserId = q.actorUserId;
    if (q.evaluatee) where.evaluateeName = { contains: q.evaluatee, mode: 'insensitive' };
    if (q.evaluator) where.evaluatorName = { contains: q.evaluator, mode: 'insensitive' };
    if (q.actor) where.actorName = { contains: q.actor, mode: 'insensitive' };
    if (q.action) where.action = q.action;
    if (q.sourceType) where.sourceType = q.sourceType;
    if (q.entityType) where.entityType = q.entityType;
    if (q.entityId) where.entityId = q.entityId;
    if (q.from || q.to) {
      where.createdAt = {};
      if (q.from) (where.createdAt as Prisma.DateTimeFilter).gte = new Date(q.from);
      if (q.to) (where.createdAt as Prisma.DateTimeFilter).lte = new Date(q.to);
    }
    if (q.search) {
      const s = q.search.trim();
      where.OR = [
        { action: { contains: s, mode: 'insensitive' } },
        { actorName: { contains: s, mode: 'insensitive' } },
        { evaluateeName: { contains: s, mode: 'insensitive' } },
        { evaluatorName: { contains: s, mode: 'insensitive' } },
        { cycleName: { contains: s, mode: 'insensitive' } },
        { sourceType: { contains: s, mode: 'insensitive' } },
        { entityId: { contains: s, mode: 'insensitive' } },
      ];
    }
    return where;
  }

  async query(organizationId: string, q: FeedbackAuditQuery): Promise<{ items: unknown[]; total: number }> {
    const where = this.where(organizationId, q);
    const take = Math.min(Math.max(q.limit ?? 100, 1), 500);
    const skip = Math.max(q.offset ?? 0, 0);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.feedbackAuditEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip }),
      this.prisma.feedbackAuditEvent.count({ where }),
    ]);
    return { items: rows, total };
  }

  /** Distinct values for the filter dropdowns (actions, source types). */
  async facets(organizationId: string): Promise<{ actions: string[]; sourceTypes: string[] }> {
    const [actions, sources] = await Promise.all([
      this.prisma.feedbackAuditEvent.findMany({ where: { organizationId }, distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } }),
      this.prisma.feedbackAuditEvent.findMany({ where: { organizationId, sourceType: { not: null } }, distinct: ['sourceType'], select: { sourceType: true }, orderBy: { sourceType: 'asc' } }),
    ]);
    return {
      actions: actions.map((a) => a.action),
      sourceTypes: sources.map((s) => s.sourceType).filter((s): s is string => !!s),
    };
  }

  /** All events for a single affected record, oldest→newest (record history). */
  async history(organizationId: string, entityType: string, entityId: string): Promise<unknown[]> {
    return this.prisma.feedbackAuditEvent.findMany({
      where: { organizationId, entityType, entityId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** CSV export of the current filter (capped). */
  async exportCsv(organizationId: string, q: FeedbackAuditQuery): Promise<string> {
    const where = this.where(organizationId, q);
    const rows = await this.prisma.feedbackAuditEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: 10000 });
    const cols: Array<[string, (r: (typeof rows)[number]) => unknown]> = [
      ['Timestamp', (r) => r.createdAt.toISOString()],
      ['Action', (r) => r.action],
      ['Actor', (r) => r.actorName],
      ['Actor role', (r) => r.actorRole],
      ['Feedback cycle', (r) => r.cycleName],
      ['Evaluatee', (r) => r.evaluateeName],
      ['Evaluator', (r) => r.evaluatorName],
      ['Source/type', (r) => r.sourceType],
      ['Record', (r) => r.entityType],
      ['Record id', (r) => r.entityId],
      ['Previous value', (r) => (r.previousValue == null ? '' : JSON.stringify(r.previousValue))],
      ['New value', (r) => (r.newValue == null ? '' : JSON.stringify(r.newValue))],
      ['Reason', (r) => r.reason],
      ['IP', (r) => r.ip],
      ['Device', (r) => r.userAgent],
    ];
    const esc = (v: unknown): string => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.map((c) => c[0]).join(',')];
    for (const r of rows) lines.push(cols.map((c) => esc(c[1](r))).join(','));
    return lines.join('\n');
  }
}
