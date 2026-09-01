import { Body, Controller, Delete, ForbiddenException, Get, Param, ParseUUIDPipe, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../common/auth/permissions.guard';
import { RequirePermissions } from '../common/auth/require-permissions.decorator';
import { CurrentUser, ReqContext, type AuthUser, type RequestContext } from '../common/auth/current-user';
import { ReportsService } from './services/reports.service';
import { ReportExportService, type ExportFormat, type ExportType } from './services/report-export.service';
import { DashboardLayoutService, type DashboardLayout } from './services/dashboard-layout.service';
import { REPORTS_PERMISSIONS as P } from './reports.permissions';
import { UpdateFeedbackRulesDto } from './reports.dto';
import { ScopeService } from '../rbac/scope.service';
import { FeedbackAuditService } from '../feedback-audit/feedback-audit.service';

@Controller('reports')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(P.read)
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly exports: ReportExportService,
    private readonly scope: ScopeService,
    private readonly feedbackAudit: FeedbackAuditService,
    private readonly layouts: DashboardLayoutService,
  ) {}

  /* ---- Feedback rules: anonymity threshold + target score (F-C4) ---- */

  /**
   * Read the org's feedback rules. Available to any report viewer so the UI can
   * explain the anonymity threshold that governs what they can see.
   */
  @Get('feedback-rules')
  getFeedbackRules(@CurrentUser() user: AuthUser) {
    return this.reports.getFeedbackRules(user.organizationId);
  }

  /** Update the feedback rules. Same gate as other programme-level configuration. */
  @Put('feedback-rules')
  @RequirePermissions(P.dashboardConfigure)
  setFeedbackRules(@CurrentUser() user: AuthUser, @Body() dto: UpdateFeedbackRulesDto) {
    return this.reports.setFeedbackRules(user.organizationId, user.userId, dto);
  }

  /* ---- Configurable dashboard layouts (Executive / HR) ---- */

  /** Read the saved layout for a dashboard (null = default). Any dashboard viewer. */
  @Get('dashboard-layout/:type')
  @RequirePermissions(P.executive)
  getLayout(@CurrentUser() user: AuthUser, @Param('type') type: string) {
    return this.layouts.get(user.organizationId, type).then((layout) => ({ type, layout }));
  }

  /** Publish a customized layout. Requires the dashboard-configure permission. */
  @Put('dashboard-layout/:type')
  @RequirePermissions(P.dashboardConfigure)
  saveLayout(@CurrentUser() user: AuthUser, @Param('type') type: string, @Body() body: DashboardLayout) {
    return this.layouts.save(user.organizationId, type, body).then((layout) => ({ type, layout }));
  }

  /** Reset a dashboard to its default layout (deletes the saved row). */
  @Delete('dashboard-layout/:type')
  @RequirePermissions(P.dashboardConfigure)
  async resetLayout(@CurrentUser() user: AuthUser, @Param('type') type: string) {
    await this.layouts.reset(user.organizationId, type);
    return { type, layout: null };
  }

  /**
   * Download a report as CSV or Excel. Streams raw bytes (bypasses the JSON envelope).
   * Gated to executive/HR viewers (F-C8): the institutional export contains named
   * top/bottom performers, which must not be downloadable by peers or subordinates.
   */
  @Get('export')
  @RequirePermissions(P.executive)
  async export(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Res() res: Response,
    @Query('type') type: ExportType = 'departmental',
    @Query('format') format: ExportFormat = 'xlsx',
    @Query('cycleId') cycleId?: string,
  ): Promise<void> {
    const result = await this.exports.export(user.organizationId, type, format, cycleId);
    await this.feedbackAudit.record({
      organizationId: user.organizationId,
      action: 'results.exported',
      actorUserId: user.userId,
      actorName: user.email,
      ...(cycleId ? await this.feedbackAudit.cycleContext(cycleId) : {}),
      entityType: 'report_export',
      entityId: type,
      newValue: { type, format },
      ctx,
    });
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.buffer);
  }

  /**
   * Organisation-wide participation/score aggregates.
   *
   * The aggregates themselves are fine for any report viewer, but the payload also
   * carries `topPerformers` / `bottomPerformers` — named individuals with their exact
   * scores. Those are stripped for non-executive callers (F-C8) so a peer or
   * subordinate cannot pull a named "lowest performers in the organisation" list,
   * while managers keep the legitimate aggregate view.
   */
  @Get('institutional')
  async institutional(@CurrentUser() user: AuthUser, @Query('cycleId') cycleId?: string) {
    await this.reports.assertAggregateVisible(user);
    const report = await this.reports.institutional(user.organizationId, cycleId);
    if ((user.permissions ?? []).includes(P.executive)) return report;
    return { ...report, topPerformers: [], bottomPerformers: [] };
  }

  @Get('my-team')
  myTeam(@CurrentUser() user: AuthUser, @Query('cycleId') cycleId?: string) {
    return this.reports.myTeam(user.organizationId, user.userId, cycleId);
  }

  // Person-identifying talent grid — an executive/HR view, not for peers/subordinates. (DEF-02)
  @Get('nine-box')
  @RequirePermissions(P.executive)
  nineBox(@CurrentUser() user: AuthUser, @Query('cycleId') cycleId?: string) {
    return this.reports.nineBox(user.organizationId, cycleId);
  }

  @Get('campus')
  async campus(@CurrentUser() user: AuthUser, @Query('cycleId') cycleId?: string) {
    await this.reports.assertAggregateVisible(user);
    return this.reports.campus(user.organizationId, cycleId);
  }

  /** Executive dashboard bundle — gated by a dedicated permission. */
  @Get('executive')
  @RequirePermissions(P.executive)
  executive(@CurrentUser() user: AuthUser, @Query('cycleId') cycleId?: string) {
    return this.reports.executive(user.organizationId, cycleId);
  }

  /** HR dashboard bundle — operational HR view, gated like the executive one. */
  @Get('hr')
  @RequirePermissions(P.executive)
  hr(@CurrentUser() user: AuthUser, @Query('cycleId') cycleId?: string) {
    return this.reports.hr(user.organizationId, cycleId);
  }

  @Get('departmental')
  async departmental(@CurrentUser() user: AuthUser, @Query('cycleId') cycleId?: string) {
    await this.reports.assertAggregateVisible(user);
    return this.reports.departmental(user.organizationId, cycleId);
  }

  /* Dashboard drill-down — underlying records behind a clicked element. These list
   * named participants org-wide, so they are gated to executive/HR dashboard viewers
   * (reports.executive) rather than every reports.read holder. (DEF-02) */
  @Get('drilldown/participants')
  @RequirePermissions(P.executive)
  drilldownParticipants(
    @CurrentUser() user: AuthUser,
    @Query('cycleId') cycleId?: string,
    @Query('department') department?: string,
    @Query('campus') campus?: string,
    @Query('band') band?: string,
  ) {
    return this.reports.drilldownParticipants(user.organizationId, { cycleId, department, campus, band });
  }

  @Get('drilldown/pending')
  @RequirePermissions(P.executive)
  drilldownPending(@CurrentUser() user: AuthUser, @Query('cycleId') cycleId?: string, @Query('department') department?: string) {
    return this.reports.drilldownPending(user.organizationId, { cycleId, department });
  }

  @Get('drilldown/competency')
  @RequirePermissions(P.executive)
  drilldownCompetency(
    @CurrentUser() user: AuthUser,
    @Query('cycleId') cycleId?: string,
    @Query('competency') competency?: string,
    @Query('belowTarget') belowTarget?: string,
  ) {
    return this.reports.drilldownCompetency(user.organizationId, { cycleId, competency, belowTarget: belowTarget === '1' || belowTarget === 'true' });
  }

  @Get('trend')
  async trend(@CurrentUser() user: AuthUser) {
    await this.reports.assertAggregateVisible(user);
    return this.reports.trend(user.organizationId);
  }

  @Get('heatmap')
  async heatmap(@CurrentUser() user: AuthUser, @Query('cycleId') cycleId?: string) {
    await this.reports.assertAggregateVisible(user);
    return this.reports.heatmap(user.organizationId, cycleId);
  }

  @Get('individual/:employeeId')
  async individual(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query('cycleId') cycleId?: string,
  ) {
    await this.scope.assertCanAccessEmployee(user, employeeId);
    await this.assertReleasedForNonPrivileged(user, employeeId, cycleId);
    const report = await this.reports.individual(user.organizationId, employeeId, cycleId, this.canSeeConfidential(user));
    await this.recordView(user, ctx, 'individual', employeeId, cycleId);
    return report;
  }

  @Get('radar/:employeeId')
  async radar(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query('cycleId') cycleId?: string,
  ) {
    await this.scope.assertCanAccessEmployee(user, employeeId);
    await this.assertReleasedForNonPrivileged(user, employeeId, cycleId);
    const report = await this.reports.radar(user.organizationId, employeeId, cycleId, this.canSeeConfidential(user));
    await this.recordView(user, ctx, 'radar', employeeId, cycleId);
    return report;
  }

  /**
   * Employee 360 drill-down supplement: cross-cycle score history + per-quadrant
   * reviewer coverage. Carries exactly the same guards as the individual report —
   * data scope, release gating and a `results.viewed` audit entry — because it is
   * the same class of person-level data, reached from the Executive Dashboard
   * instead of the reports screen.
   */
  @Get('employee-360/:employeeId')
  async employee360(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query('cycleId') cycleId?: string,
  ) {
    await this.scope.assertCanAccessEmployee(user, employeeId);
    await this.assertReleasedForNonPrivileged(user, employeeId, cycleId);
    const report = await this.reports.employeeDrilldown(user.organizationId, employeeId, cycleId);
    await this.recordView(user, ctx, 'employee-360', employeeId, cycleId);
    return report;
  }

  /**
   * Shared-competency comparison for one employee: how each evaluator group sees the same
   * competency, with blind-spot / consensus / divergence findings. Same guards as the
   * individual report — data scope, release gating, audit — because it is the same class
   * of person-level data.
   */
  @Get('shared-competencies/:employeeId')
  async sharedCompetencies(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query('cycleId') cycleId?: string,
  ) {
    await this.scope.assertCanAccessEmployee(user, employeeId);
    await this.assertReleasedForNonPrivileged(user, employeeId, cycleId);
    const report = await this.reports.sharedCompetencies(user.organizationId, employeeId, cycleId, this.canSeeConfidential(user));
    await this.recordView(user, ctx, 'shared-competencies', employeeId, cycleId);
    return report;
  }

  @Get('gap/:employeeId')
  async gap(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query('cycleId') cycleId?: string,
  ) {
    await this.scope.assertCanAccessEmployee(user, employeeId);
    await this.assertReleasedForNonPrivileged(user, employeeId, cycleId);
    const report = await this.reports.gap(user.organizationId, employeeId, cycleId);
    await this.recordView(user, ctx, 'gap', employeeId, cycleId);
    return report;
  }

  /**
   * Release gating (DEF-01): a self/subordinate viewer (own or reporting scope,
   * reports.read only) may see an appraisee's results only after they are released.
   * HR/admin/executive viewers (reports.executive) retain pre-release visibility for
   * calibration. Bypassed entirely for privileged viewers.
   */
  /**
   * Whether this caller may see rater-source breakdowns that sit below the
   * minimum-response threshold (`reports.confidential.view`).
   *
   * The threshold protects the APPRAISEE from inferring who said what. It is not a
   * shield against the people who run the programme, so HR/Admin — and a Manager
   * inside their own reporting line, which `assertCanAccessEmployee` already
   * enforces — hold this permission. It changes nothing else: no reviewer identity
   * is returned, the threshold and the stored data are untouched, and any caller
   * without the permission sees exactly what they saw before.
   */
  private canSeeConfidential(user: AuthUser): boolean {
    return (user.permissions ?? []).includes(P.confidentialView);
  }

  private async assertReleasedForNonPrivileged(user: AuthUser, employeeId: string, cycleId?: string): Promise<void> {
    if ((user.permissions ?? []).includes(P.executive)) return;
    const released = await this.reports.hasReleasedResults(user.organizationId, employeeId, cycleId);
    if (!released) throw new ForbiddenException('These results have not been released yet.');
  }

  /**
   * Audit a per-employee results view (individual/radar/gap).
   *
   * `confidential` records whether the caller saw sub-threshold quadrants, so an
   * elevated view is distinguishable from an ordinary one in the audit trail.
   */
  private async recordView(user: AuthUser, ctx: RequestContext, report: string, employeeId: string, cycleId?: string): Promise<void> {
    await this.feedbackAudit.record({
      organizationId: user.organizationId,
      action: 'results.viewed',
      actorUserId: user.userId,
      actorName: user.email,
      evaluateeEmployeeId: employeeId,
      ...(cycleId ? await this.feedbackAudit.cycleContext(cycleId) : {}),
      entityType: 'report',
      entityId: employeeId,
      newValue: { report, confidential: this.canSeeConfidential(user) },
      ctx,
    });
  }
}
