import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../common/auth/permissions.guard';
import { RequirePermissions } from '../common/auth/require-permissions.decorator';
import { CurrentUser, type AuthUser } from '../common/auth/current-user';
import { FEEDBACK_AUDIT_PERMISSIONS } from './feedback-audit.permissions';
import { FeedbackAuditService, type FeedbackAuditQuery } from './feedback-audit.service';

/**
 * Administrator-only 360 Feedback Audit Trail. Gated by `feedback.audit.read`
 * (held by Super Admin). Read-only by construction — there is no create/update/
 * delete endpoint; the trail is written only by the lifecycle services and is
 * append-only at the database layer.
 */
@Controller('feedback-audit')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(FEEDBACK_AUDIT_PERMISSIONS.read)
export class FeedbackAuditController {
  constructor(private readonly audit: FeedbackAuditService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: Record<string, string>) {
    return this.audit.query(user.organizationId, this.parse(q));
  }

  @Get('facets')
  facets(@CurrentUser() user: AuthUser) {
    return this.audit.facets(user.organizationId);
  }

  @Get('history')
  history(@CurrentUser() user: AuthUser, @Query('entityType') entityType: string, @Query('entityId') entityId: string) {
    return this.audit.history(user.organizationId, entityType, entityId);
  }

  /** CSV download — streams raw bytes (bypasses the JSON envelope interceptor). */
  @Get('export')
  async export(@CurrentUser() user: AuthUser, @Res() res: Response, @Query() q: Record<string, string>): Promise<void> {
    const csv = await this.audit.exportCsv(user.organizationId, this.parse(q));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="feedback-audit-trail.csv"');
    res.send(csv);
  }

  private parse(q: Record<string, string>): FeedbackAuditQuery {
    return {
      search: q.search || undefined,
      from: q.from || undefined,
      to: q.to || undefined,
      cycleId: q.cycleId || undefined,
      evaluateeEmployeeId: q.evaluateeEmployeeId || undefined,
      evaluatorEmployeeId: q.evaluatorEmployeeId || undefined,
      actorUserId: q.actorUserId || undefined,
      evaluatee: q.evaluatee || undefined,
      evaluator: q.evaluator || undefined,
      actor: q.actor || undefined,
      action: q.action || undefined,
      sourceType: q.sourceType || undefined,
      entityType: q.entityType || undefined,
      entityId: q.entityId || undefined,
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    };
  }
}
