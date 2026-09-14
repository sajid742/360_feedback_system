import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { CurrentUser, ReqContext, type AuthUser, type RequestContext } from '../common/auth/current-user';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformService } from './platform.service';
import { CreateTenantDto, UpdateSubscriptionDto } from './platform.dto';
import { PLANS, PLAN_CODES } from '../license/plans';
import { MODULE_LABELS } from '../license/license.types';

/**
 * Platform administration — one level above any tenant.
 *
 * Guarded ONLY by `PlatformAdminGuard`. No tenant permission appears here, and none
 * would help: the two authorisation systems are deliberately disjoint, so a customer's
 * Super Admin cannot reach these routes however their roles are configured.
 */
@Controller('platform')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  /* ---------------------------------------------------------- catalogue */

  /** The plan catalogue and module labels — what the operator screen renders from. */
  @Get('catalogue')
  catalogue(): Record<string, unknown> {
    return {
      plans: PLAN_CODES.map((code) => ({
        code,
        label: PLANS[code].label,
        blurb: PLANS[code].blurb,
        modules: PLANS[code].modules,
        limits: PLANS[code].limits,
      })),
      modules: Object.entries(MODULE_LABELS).map(([code, label]) => ({ code, label })),
      statuses: this.platform.statuses(),
    };
  }

  @Get('stats')
  stats(): Promise<Record<string, unknown>> {
    return this.platform.stats();
  }

  /* ------------------------------------------------------ organisations */

  @Get('organizations')
  organizations(): Promise<Record<string, unknown>[]> {
    return this.platform.organizations();
  }

  @Get('organizations/:id')
  organization(@Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    return this.platform.organization(id);
  }

  @Post('organizations')
  createTenant(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Body() dto: CreateTenantDto,
  ): Promise<Record<string, unknown>> {
    return this.platform.createTenant(user, ctx, dto);
  }

  /* -------------------------------------------------------- subscription */

  @Put('organizations/:id/subscription')
  setSubscription(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSubscriptionDto,
  ): Promise<Record<string, unknown>> {
    return this.platform.setSubscription(user, ctx, id, dto);
  }

  @Post('organizations/:id/suspend')
  @HttpCode(200)
  suspend(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    return this.platform.setSuspended(user, ctx, id, true);
  }

  @Post('organizations/:id/restore')
  @HttpCode(200)
  restore(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    return this.platform.setSuspended(user, ctx, id, false);
  }

  /* ------------------------------------------------------------ operators */

  /**
   * Who the platform administrators are. Read-only on purpose: adding one is a
   * deliberate act performed with `npm run -w apps/api db:platform-admin`, which needs
   * database access. An operator surface that can mint more operators over HTTP is one
   * compromised session away from a permanent foothold.
   */
  @Get('admins')
  admins(): Promise<Record<string, unknown>[]> {
    return this.platform.admins();
  }
}
