import { Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { LicensedFeatureGuard, RequiresLicensedModule } from '../license/licensed-feature.guard';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../common/auth/permissions.guard';
import { RequirePermissions } from '../common/auth/require-permissions.decorator';
import { CurrentUser, type AuthUser } from '../common/auth/current-user';
import { InsightsService } from './services/insights.service';
import { AI_PERMISSIONS as P } from './ai.permissions';
import { ScopeService } from '../rbac/scope.service';
import { ReportsService } from '../reports/services/reports.service';
import { REPORTS_PERMISSIONS } from '../reports/reports.permissions';
import { AiEnabledGuard } from './ai-enabled.guard';

@RequiresLicensedModule('ai_insights')
@Controller('ai')
@UseGuards(JwtAuthGuard, PermissionsGuard, AiEnabledGuard, LicensedFeatureGuard)
@RequirePermissions(P.read)
export class AiController {
  constructor(
    private readonly insightsService: InsightsService,
    private readonly scope: ScopeService,
    private readonly reports: ReportsService,
  ) {}

  /** Whether an LLM provider is configured for this tenant (drives the UI badge). */
  @Get('status')
  status(@CurrentUser() user: AuthUser) {
    return this.insightsService.providerStatus(user.organizationId);
  }

  /** Org-level AI overview: at-risk employees, readiness distribution, sentiment, top gaps. */
  @Get('overview')
  @RequirePermissions(REPORTS_PERMISSIONS.executive)
  overview(@CurrentUser() user: AuthUser, @Query('cycleId') cycleId?: string) {
    return this.insightsService.overview(user.organizationId, cycleId);
  }

  /**
   * Full per-employee insight: blind spots, recommendations, readiness, summary.
   *
   * This endpoint reads an individual's 360 results — including sentiment derived
   * from free-text comments — so it is held to exactly the same protections as the
   * equivalent report (F-C8). Previously it had neither, so any holder of `ai.read`
   * (including the read-only Viewer role) could pull any employee's insights, before
   * HR had released them.
   */
  @Get('insights/:employeeId')
  async insights(
    @CurrentUser() user: AuthUser,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query('cycleId') cycleId?: string,
  ) {
    // 1) Data scope: you may only look at people you are entitled to see.
    await this.scope.assertCanAccessEmployee(user, employeeId);
    // 2) Release gating: non-privileged viewers wait until results are released.
    if (!(user.permissions ?? []).includes(REPORTS_PERMISSIONS.executive)) {
      const released = await this.reports.hasReleasedResults(user.organizationId, employeeId, cycleId);
      if (!released) throw new ForbiddenException('These results have not been released yet.');
    }
    return this.insightsService.individual(user.organizationId, employeeId, cycleId);
  }
}
