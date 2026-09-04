import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { LicensedFeatureGuard, RequiresLicensedModule } from '../license/licensed-feature.guard';
import type { Response } from 'express';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../common/auth/permissions.guard';
import { RequirePermissions } from '../common/auth/require-permissions.decorator';
import { CurrentUser, type AuthUser } from '../common/auth/current-user';
import { SIS_INTEGRATION_PERMISSIONS } from './sis-integration.permissions';
import { SisConfigService } from './sis-config.service';
import { SisConnectionService } from './sis-connection.service';
import { SisSyncService } from './sis-sync.service';
import { SisParseService } from './providers/sis-parse.service';
import { SisImportDto, SisSyncDto, UpdateSisConfigDto, UpdateSisConnectionDto } from './sis-integration.dto';

/**
 * Student/SIS Integration administration — gated by `organization.sis.manage`
 * (Super Admin + HR/Admin). Configures the per-org student data source, runs the
 * Excel/CSV import wizard and provider sync. All roster data is served back through
 * the existing SisProvider interface, so parent feedback / identity mapping / bulk
 * generation consume it unchanged.
 */
@RequiresLicensedModule('sis_integration')
@Controller('sis-integration')
@UseGuards(JwtAuthGuard, PermissionsGuard, LicensedFeatureGuard)
@RequirePermissions(SIS_INTEGRATION_PERMISSIONS.manage)
export class SisIntegrationController {
  constructor(
    private readonly config: SisConfigService,
    private readonly connections: SisConnectionService,
    private readonly sync: SisSyncService,
    private readonly parser: SisParseService,
  ) {}

  @Get('status')
  status(@CurrentUser() user: AuthUser) { return this.sync.status(user.organizationId); }

  @Get('history')
  history(@CurrentUser() user: AuthUser) { return this.sync.history(user.organizationId); }

  @Put('config')
  updateConfig(@CurrentUser() user: AuthUser, @Body() dto: UpdateSisConfigDto) { return this.config.patch(user.organizationId, dto); }

  @Get('connection')
  async connection(@CurrentUser() user: AuthUser, @Query('provider') provider?: string) {
    const key = provider || (await this.config.get(user.organizationId)).provider;
    return this.connections.redacted(user.organizationId, key);
  }

  @Put('connection')
  saveConnection(@CurrentUser() user: AuthUser, @Body() dto: UpdateSisConnectionDto) {
    return this.connections.save(user.organizationId, dto.provider, dto.settings);
  }

  /** Test the current live provider's connection (capped read, no writes). */
  @Post('test')
  test(@CurrentUser() user: AuthUser) { return this.sync.test(user.organizationId); }

  /**
   * Excel/CSV import — dry-run by default; live when `{ dryRun:false }`.
   * A live import that would deactivate or rename records, or re-point a teacher to a
   * different 360 employee, returns the PREVIEW with `requiresConfirmation: true`
   * instead of writing; re-send it with `{ confirm:true }` to apply. A harmless
   * import applies immediately.
   */
  @Post('import')
  import(@CurrentUser() user: AuthUser, @Body() dto: SisImportDto) {
    const actor = { userId: user.userId, name: user.email };
    return this.sync.importFile(
      user.organizationId,
      actor,
      { filename: dto.filename, base64: dto.base64, entity: dto.entity },
      dto.dryRun !== false,
      dto.confirm === true,
    );
  }

  /**
   * Provider sync (mock/generic/oneroster) — dry-run by default; live when `{ live:true }`.
   * A live run that would deactivate or rename records returns the PREVIEW with
   * `requiresConfirmation: true` instead of writing; re-send it with `{ confirm:true }`
   * to apply. A harmless run applies immediately.
   */
  @Post('sync')
  syncNow(@CurrentUser() user: AuthUser, @Body() dto: SisSyncDto) {
    const actor = { userId: user.userId, name: user.email };
    return this.sync.sync(user.organizationId, actor, !dto.live, 'manual', dto.confirm === true);
  }

  /** Download the multi-sheet .xlsx import template. */
  @Get('template')
  async template(@Res() res: Response): Promise<void> {
    const buf = await this.parser.template();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="sis-import-template.xlsx"');
    res.send(buf);
  }

  /** CSV report (errors/warnings/deactivations) for a run. */
  @Get(':runId/report')
  async report(@CurrentUser() user: AuthUser, @Res() res: Response, @Param('runId', ParseUUIDPipe) runId: string): Promise<void> {
    const csv = await this.sync.reportCsv(user.organizationId, runId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sis-sync-report.csv"');
    res.send(csv);
  }
}
