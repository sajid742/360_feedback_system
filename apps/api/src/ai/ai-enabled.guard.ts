import { CanActivate, type ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { FeatureFlagService } from '../config/services/feature-flag.service';
import type { AuthUser } from '../common/auth/current-user';

/** The flag key and default shared with the frontend's RECOGNISED_FLAGS list. */
export const AI_INSIGHTS_FLAG = 'ai_insights';
const AI_INSIGHTS_DEFAULT = true;

/**
 * Enforces the `ai_insights` feature flag on the server (F27).
 *
 * Turning the flag off used to hide only the menu item — the `/ai` route and every
 * AI endpoint still answered to anyone who typed the URL, so an administrator who
 * deliberately hid an early-stage feature had not actually hidden it. A disabled
 * module responds 404, the same as any route that does not exist, rather than 403,
 * which would confirm the feature is there but withheld.
 */
@Injectable()
export class AiEnabledGuard implements CanActivate {
  constructor(private readonly flags: FeatureFlagService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (!user?.organizationId) return true; // auth guards handle unauthenticated callers
    const enabled = await this.flags.isEnabled(user.organizationId, AI_INSIGHTS_FLAG, AI_INSIGHTS_DEFAULT);
    if (!enabled) throw new NotFoundException('AI Insights is not enabled for this organization.');
    return true;
  }
}
