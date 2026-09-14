/**
 * Entitlements — what an organisation is allowed, and how much of it.
 *
 * This sits on top of the licence model rather than replacing it. The product has two
 * ways of being paid for and both must keep working:
 *
 *   on-premise  → a signed licence file, verified offline, no network
 *   cloud SaaS  → a subscription row a platform administrator sets
 *
 * `LicenseState` is unchanged so every existing caller keeps compiling; `EntitlementState`
 * adds the plan, the limits and the provenance on top.
 */
import type { PlanCode, PlanLimits } from './plans';
import type { LicenseState } from './license.types';

/** Where the entitlements came from. Shown to an administrator; useful in support. */
export type EntitlementSource = 'subscription' | 'license' | 'development' | 'none';

/**
 * The lifecycle of a cloud subscription.
 *
 * `trialing` is a STATUS, not a plan: a 30-day trial of Professional is
 * `{ planCode: 'professional', status: 'trialing' }`. Modelling trial as a fourth plan
 * would mean making every feature decision twice and turning a conversion into a
 * migration.
 */
export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'grace',
  'expired',
  'suspended',
  'cancelled',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const isSubscriptionStatus = (v: string): v is SubscriptionStatus =>
  (SUBSCRIPTION_STATUSES as readonly string[]).includes(v);

/**
 * Which statuses still permit normal business operations.
 *
 * `expired`, `suspended` and `cancelled` fall back to `ALWAYS_ON_MODULES` exactly as an
 * expired licence does — the tenant can still sign in, read its own data and renew,
 * rather than finding a locked box. Nothing is ever deleted by a status change.
 */
export const OPERATIONAL_STATUSES: SubscriptionStatus[] = ['trialing', 'active', 'past_due', 'grace'];

export interface EntitlementState extends LicenseState {
  source: EntitlementSource;
  planCode: PlanCode | null;
  planLabel: string | null;
  limits: PlanLimits;
  /** Null unless `source === 'subscription'`. */
  subscriptionStatus: SubscriptionStatus | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
}

/** One limit, with what is currently used against it. `limit: null` means unlimited. */
export interface LimitUsage {
  key: string;
  label: string;
  used: number;
  limit: number | null;
  /** 0-100, or null when unlimited. */
  percent: number | null;
  /** True at or above 80% — the point at which the UI warns. */
  warning: boolean;
  /** True at or above the limit — the point at which the server refuses. */
  exceeded: boolean;
}

/** The warning threshold, as a fraction. */
export const LIMIT_WARNING_AT = 0.8;
