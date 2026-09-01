import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Post, Query, Res, UseGuards } from '@nestjs/common';
import { LicensedFeatureGuard, RequiresLicensedModule } from '../license/licensed-feature.guard';
import type { Response } from 'express';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../common/auth/permissions.guard';
import { RequirePermissions } from '../common/auth/require-permissions.decorator';
import { CurrentUser, type AuthUser } from '../common/auth/current-user';
import { HR_INTEGRATION_PERMISSIONS } from './hr-integration.permissions';
import { HrConfigService } from './hr-config.service';
import { HrConnectionService } from './hr-connection.service';
import { HrSyncService } from './hr-sync.service';
import { SyncDto, UpdateHrConfigDto, UpdateHrConnectionDto } from './hr-integration.dto';

/**
 * External HR Integration administration — gated by `organization.hr.manage`
 * (Super Admin + HR/Admin). Configures the per-org data source and runs
 * synchronization. All sync work reuses the Organization Import reconcile engine.
 */
@RequiresLicensedModule('hr_integration')
@Controller('hr-integration')
@UseGuards(JwtAuthGuard, PermissionsGuard, LicensedFeatureGuard)
@RequirePermissions(HR_INTEGRATION_PERMISSIONS.manage)
export class HrIntegrationController {
  constructor(
    private readonly config: HrConfigService,
    private readonly connections: HrConnectionService,
    private readonly sync: HrSyncService,
  ) {}

  /** Current mode, provider, schedule, last/next sync and last-run counts. */
  @Get('status')
  status(@CurrentUser() user: AuthUser) {
    return this.sync.status(user.organizationId);
  }

  /** Redacted connection settings for a provider (secrets never returned). */
  @Get('connection')
  async connection(@CurrentUser() user: AuthUser, @Query('provider') provider?: string) {
    const key = provider || (await this.config.get(user.organizationId)).provider;
    return this.connections.redacted(user.organizationId, key);
  }

  /** Save a provider's connection settings (secrets are encrypted at rest). */
  @Put('connection')
  saveConnection(@CurrentUser() user: AuthUser, @Body() dto: UpdateHrConnectionDto) {
    return this.connections.save(user.organizationId, dto.provider, dto.settings);
  }

  /** Test the current provider's connection (capped read, no writes). */
  @Post('test')
  test(@CurrentUser() user: AuthUser) {
    return this.sync.test(user.organizationId);
  }

  @Get('history')
  history(@CurrentUser() user: AuthUser) {
    return this.sync.history(user.organizationId);
  }

  /** Update the data source, provider and schedule. */
  @Put('config')
  async updateConfig(@CurrentUser() user: AuthUser, @Body() dto: UpdateHrConfigDto) {
    return this.config.patch(user.organizationId, dto);
  }

  /** Dry-run (preview) by default; live sync when `{ live: true }`. */
  @Post('sync')
  run(@CurrentUser() user: AuthUser, @Body() dto: SyncDto) {
    const actor = { userId: user.userId, name: user.email };
    return dto.live ? this.sync.sync(user.organizationId, actor, 'manual') : this.sync.preview(user.organizationId, actor, 'manual');
  }

  /** CSV report (errors/warnings/deactivations) for a run. */
  @Get(':runId/report')
  async report(@CurrentUser() user: AuthUser, @Res() res: Response, @Param('runId', ParseUUIDPipe) runId: string): Promise<void> {
    const csv = await this.sync.reportCsv(user.organizationId, runId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="hr-sync-report.csv"');
    res.send(csv);
  }
}
