import { Controller, Get, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { CurrentUser, type AuthUser } from '../common/auth/current-user';
import { PermissionsGuard } from '../common/auth/permissions.guard';
import { RequirePermissions } from '../common/auth/require-permissions.decorator';
import { ReportsService } from '../reports/services/reports.service';
import { ApiKeyGuard } from './api-key.guard';
import { EtagInterceptor } from './etag.interceptor';
import { REPORTS_API_SCOPE, reportsApiDoc } from './reports-api.scopes';

/**
 * External read-only Reports API (v1) for external dashboards (Power BI, Looker, a
 * custom app, …). Authenticated ONLY by `X-Api-Key` (never JWT), rate-limited per key,
 * and gated by API scopes. Every handler simply delegates to the EXISTING
 * `ReportsService` with the API key's `organizationId` — so tenant isolation, RBAC
 * scopes, anonymity/minimum-response suppression and all reporting calculations are
 * inherited unchanged. No reporting SQL is duplicated and no internal endpoint is
 * touched. GET-only by design.
 *
 * Guard order matters: ApiKeyGuard authenticates and sets the principal first, then
 * ThrottlerGuard (keyed per-key), then PermissionsGuard (checks the endpoint's scope).
 */
@Controller('integration/v1/reports')
@UseGuards(ApiKeyGuard, ThrottlerGuard, PermissionsGuard)
@UseInterceptors(EtagInterceptor)
export class ReportsApiController {
  constructor(private readonly reports: ReportsService) {}

  /** Discovery: any valid key can list the available endpoints (no specific scope). */
  @Get()
  index() {
    return reportsApiDoc();
  }

  @Get('executive')
  @RequirePermissions(REPORTS_API_SCOPE.executive)
  executive(@CurrentUser() user: AuthUser, @Query('cycleId') cycleId?: string) {
    return this.reports.executive(user.organizationId, cycleId || undefined);
  }

  @Get('hr')
  @RequirePermissions(REPORTS_API_SCOPE.hr)
  hr(@CurrentUser() user: AuthUser, @Query('cycleId') cycleId?: string) {
    return this.reports.hr(user.organizationId, cycleId || undefined);
  }

  /**
   * Organisation-wide aggregates. `topPerformers`/`bottomPerformers` are stripped
   * here (F-C8): this surface is documented as aggregate-only, but it was returning
   * named employees with their exact scores to any holder of a static API key.
   */
  @Get('institutional')
  @RequirePermissions(REPORTS_API_SCOPE.institutional)
  async institutional(@CurrentUser() user: AuthUser, @Query('cycleId') cycleId?: string) {
    const report = await this.reports.institutional(user.organizationId, cycleId || undefined);
    return { ...report, topPerformers: [], bottomPerformers: [] };
  }

  @Get('departmental')
  @RequirePermissions(REPORTS_API_SCOPE.departmental)
  departmental(@CurrentUser() user: AuthUser, @Query('cycleId') cycleId?: string) {
    return this.reports.departmental(user.organizationId, cycleId || undefined);
  }

  @Get('campus')
  @RequirePermissions(REPORTS_API_SCOPE.campus)
  campus(@CurrentUser() user: AuthUser, @Query('cycleId') cycleId?: string) {
    return this.reports.campus(user.organizationId, cycleId || undefined);
  }

  @Get('trend')
  @RequirePermissions(REPORTS_API_SCOPE.trend)
  trend(@CurrentUser() user: AuthUser) {
    return this.reports.trend(user.organizationId);
  }

  /**
   * Nine-box talent grid as per-cell COUNTS (F-C8).
   *
   * The internal equivalent is restricted to executive/HR viewers because it names
   * individuals with their performance and potential ratings. The external key-based
   * surface previously returned that same named roster — including employee ids and
   * un-released results — so it is aggregated to counts here. Consumers still get the
   * distribution; they no longer get a named talent list.
   */
  @Get('nine-box')
  @RequirePermissions(REPORTS_API_SCOPE.ninebox)
  async nineBox(@CurrentUser() user: AuthUser, @Query('cycleId') cycleId?: string) {
    const grid = (await this.reports.nineBox(user.organizationId, cycleId || undefined)) as unknown as {
      scaleMax: number;
      employees: { performance: number; potential: number }[];
    };
    const employees = grid.employees ?? [];
    const cells = new Map<string, number>();
    for (const e of employees) {
      const key = `${this.box(e.performance, grid.scaleMax)}-${this.box(e.potential, grid.scaleMax)}`;
      cells.set(key, (cells.get(key) ?? 0) + 1);
    }
    return {
      scaleMax: grid.scaleMax,
      total: employees.length,
      cells: [...cells.entries()].map(([box, count]) => ({ box, count })).sort((a, b) => a.box.localeCompare(b.box)),
    };
  }

  /** Bucket a 1..scaleMax rating into the 1/2/3 band used by the nine-box grid. */
  private box(value: number, scaleMax: number): number {
    const max = scaleMax || 5;
    const third = max / 3;
    if (value <= third) return 1;
    if (value <= third * 2) return 2;
    return 3;
  }

  @Get('heatmap')
  @RequirePermissions(REPORTS_API_SCOPE.heatmap)
  heatmap(@CurrentUser() user: AuthUser, @Query('cycleId') cycleId?: string) {
    return this.reports.heatmap(user.organizationId, cycleId || undefined);
  }
}
