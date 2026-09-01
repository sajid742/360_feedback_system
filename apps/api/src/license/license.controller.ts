import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../common/auth/permissions.guard';
import { RequirePermissions } from '../common/auth/require-permissions.decorator';
import { CurrentUser, ReqContext, type AuthUser, type RequestContext } from '../common/auth/current-user';
import { AuditService } from '../common/audit/audit.service';
import { CONFIG_PERMISSIONS } from '../config/config.permissions';
import { LicenseService } from './license.service';
import { MODULE_LABELS, type LicensedModule } from './license.types';

export class InstallLicenseDto {
  @IsString() @MinLength(20) licenseKey!: string;
}

/**
 * Licence administration.
 *
 * PERMISSIONS reuse the existing catalogue rather than adding to it:
 *   - viewing needs `configuration.read`  (Super Admin and HR/Admin)
 *   - installing needs `configuration.manage` (Super Admin only)
 * That split already existed and matches who should be doing each job, so no new
 * permission rows and no role changes were required.
 */
@Controller('license')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class LicenseController {
  constructor(
    private readonly license: LicenseService,
    private readonly audit: AuditService,
  ) {}

  /** Everything the administration screen needs, in one call. */
  @Get()
  @RequirePermissions(CONFIG_PERMISSIONS.read)
  async get(@CurrentUser() user: AuthUser): Promise<Record<string, unknown>> {
    const [state, usage] = await Promise.all([
      this.license.getState(user.organizationId),
      this.license.getUsage(user.organizationId),
    ]);
    return { ...publicView(state), usage };
  }

  /**
   * The lightweight version the app shell polls for its banner. Same permission, but
   * deliberately a separate, cheap endpoint so a status badge never drags the usage
   * counts (two COUNT queries) along with it.
   */
  @Get('status')
  @RequirePermissions(CONFIG_PERMISSIONS.read)
  async status(@CurrentUser() user: AuthUser): Promise<Record<string, unknown>> {
    return publicView(await this.license.getState(user.organizationId));
  }

  @Get('usage')
  @RequirePermissions(CONFIG_PERMISSIONS.read)
  async usage(@CurrentUser() user: AuthUser): Promise<Record<string, unknown>> {
    return { ...(await this.license.getUsage(user.organizationId)) };
  }

  @Post('install')
  @RequirePermissions(CONFIG_PERMISSIONS.manage)
  async install(
    @CurrentUser() user: AuthUser,
    @Body() dto: InstallLicenseDto,
    @ReqContext() ctx: RequestContext,
  ): Promise<Record<string, unknown>> {
    const before = await this.license.getState(user.organizationId);
    const state = await this.license.install(user.organizationId, user.userId, dto.licenseKey);

    // Recorded in the EXISTING audit trail rather than a licensing-specific log. Note
    // what is stored: identifiers and dates, never the licence string itself.
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: before.payload && !before.isDevelopment ? 'license.replaced' : 'license.installed',
      entityType: 'license',
      entityId: user.organizationId,
      previousValue: before.payload ? { licenseId: before.payload.licenseId, expiresAt: before.payload.expiresAt } : null,
      newValue: state.payload
        ? { licenseId: state.payload.licenseId, edition: state.payload.edition, expiresAt: state.payload.expiresAt, maxEmployees: state.payload.maxEmployees }
        : null,
      ip: ctx?.ip ?? null,
      device: ctx?.device ?? null,
    });
    return publicView(state);
  }
}

/**
 * What leaves the server. The signed licence string is NOT included: it is a bearer
 * credential for this installation, and an administration screen has no use for it.
 */
function publicView(state: {
  status: string; message: string; daysRemaining: number | null; operational: boolean; isDevelopment: boolean;
  modules: LicensedModule[]; maxEmployees: number; maxUsers: number | null; graceDays: number;
  payload: { licenseId: string; organizationName: string; edition: string; issuedAt: string; startsAt: string; expiresAt: string; notes?: string } | null;
}): Record<string, unknown> {
  return {
    status: state.status,
    message: state.message,
    daysRemaining: state.daysRemaining,
    operational: state.operational,
    isDevelopment: state.isDevelopment,
    graceDays: state.graceDays,
    maxEmployees: state.maxEmployees,
    maxUsers: state.maxUsers,
    modules: state.modules.map((m) => ({ key: m, label: MODULE_LABELS[m] })),
    license: state.payload
      ? {
          licenseId: state.payload.licenseId,
          organizationName: state.payload.organizationName,
          edition: state.payload.edition,
          issuedAt: state.payload.issuedAt,
          startsAt: state.payload.startsAt,
          expiresAt: state.payload.expiresAt,
          notes: state.payload.notes ?? '',
        }
      : null,
  };
}
