import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { CurrentUser, type AuthUser } from '../common/auth/current-user';
import { EntitlementService } from './entitlement.service';
import { MODULE_LABELS, type LicensedModule } from './license.types';
import { PLANS, PLAN_CODES, lowestPlanWith } from './plans';

/**
 * What this organisation is entitled to — for the signed-in user, whoever they are.
 *
 * DELIBERATELY UNGATED BY PERMISSION. The existing `GET /license/status` requires
 * `configuration.read`, so an ordinary employee gets a 403 and the SPA silently falls
 * back to showing every menu entry — the interface then offers features the server
 * will refuse. Every user needs to know their organisation's plan in order for the
 * interface to reflect it honestly, and none of this is sensitive: it is what the
 * organisation bought, not who may use it.
 *
 * Authentication is still required: an anonymous caller would otherwise be able to
 * enumerate which tenants hold which plan.
 */
@Controller('me')
@UseGuards(JwtAuthGuard)
export class EntitlementsController {
  constructor(private readonly entitlements: EntitlementService) {}

  @Get('entitlements')
  async mine(@CurrentUser() user: AuthUser): Promise<Record<string, unknown>> {
    const state = await this.entitlements.get(user.organizationId);
    const held = new Set(state.modules);

    return {
      source: state.source,
      plan: state.planCode,
      planLabel: state.planLabel,
      status: state.status,
      subscriptionStatus: state.subscriptionStatus,
      message: state.message,
      operational: state.operational,
      isDevelopment: state.isDevelopment,
      daysRemaining: state.daysRemaining,
      trialEndsAt: state.trialEndsAt,
      currentPeriodEnd: state.currentPeriodEnd,
      modules: state.modules,
      limits: state.limits,
      /**
       * Every module with whether this organisation has it and, if not, the cheapest
       * plan that does. The interface uses this to show a locked entry with a real
       * answer — "available from Professional" — instead of hiding the feature and
       * leaving the customer unaware it exists.
       */
      catalogue: (Object.keys(MODULE_LABELS) as LicensedModule[]).map((module) => {
        const upgradeTo = held.has(module) ? null : lowestPlanWith(module);
        return {
          module,
          label: MODULE_LABELS[module],
          included: held.has(module),
          upgradeTo,
          upgradeToLabel: upgradeTo ? PLANS[upgradeTo].label : null,
        };
      }),
    };
  }

  /** Current usage against every countable limit — drives the banners. */
  @Get('usage')
  async usage(@CurrentUser() user: AuthUser): Promise<Record<string, unknown>> {
    return { limits: await this.entitlements.usage(user.organizationId) };
  }

  /**
   * The public plan catalogue, for the upgrade page. Contains no tenant data, but is
   * still behind authentication so the pricing surface stays under your control.
   */
  @Get('plans')
  plans(): Record<string, unknown> {
    return {
      plans: PLAN_CODES.map((code) => ({
        code,
        label: PLANS[code].label,
        blurb: PLANS[code].blurb,
        modules: PLANS[code].modules,
        limits: PLANS[code].limits,
      })),
    };
  }
}
