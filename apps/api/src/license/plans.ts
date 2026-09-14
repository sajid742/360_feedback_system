/**
 * The subscription plan catalogue.
 *
 * WHY PLANS LIVE IN CODE. A plan definition is a product decision that must be
 * reviewed and shipped atomically with the guards that enforce it. A database-driven
 * plan table invites someone to grant a module that has no guard behind it, and leaves
 * no way to see in the repository what "Professional" actually includes.
 *
 * WHERE THE FLEXIBILITY IS. Per-tenant deviation lives on the subscription row
 * (`limit_overrides`, `module_overrides`), which a platform administrator edits. So
 * raising one customer's employee cap to 750, or adding a module as part of a deal, is
 * a field edit that takes effect on the next cache expiry — no release, no redesign.
 *
 * UNLIMITED IS `null`, NOT `0`. The legacy licence payload uses `maxEmployees: 0` to
 * mean unlimited, which cannot express "zero API keys on Starter". This object uses
 * `null` for unlimited and `0` for genuinely none; the translation from a signed
 * licence happens once, at the boundary in `license.service.ts`.
 */
import type { LicensedModule } from './license.types';

export const PLAN_CODES = ['starter', 'professional', 'enterprise'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

/** Delivery channels a plan may use. Expressed as a list rather than three modules. */
export type Channel = 'email' | 'sms' | 'whatsapp';
/** Report export formats a plan may produce. */
export type ExportFormat = 'csv' | 'xlsx' | 'pdf';
/**
 * How far white-labelling goes. `logo` is a real commercial position — the customer's
 * logo and colours on our product name — so this is three states, not a boolean.
 */
export type BrandingLevel = 'none' | 'logo' | 'full';

/**
 * Every countable limit. `null` means unlimited.
 *
 * Each numeric key is counted from a table that already exists — employees, users,
 * departments, campuses, cycles, `notifications` by channel and month, and
 * `evaluation_links` by month — so no metering table is needed.
 */
export interface PlanLimits {
  maxEmployees: number | null;
  maxUsers: number | null;
  maxActiveCycles: number | null;
  maxCyclesPerYear: number | null;
  maxDepartments: number | null;
  maxCampuses: number | null;
  maxStudents: number | null;
  maxParentLinksPerMonth: number | null;
  maxEmailsPerMonth: number | null;
  maxSmsPerMonth: number | null;
  maxWhatsAppPerMonth: number | null;
  maxImportRowsPerFile: number | null;
  maxScheduledReports: number | null;
  maxApiKeys: number | null;
  maxWebhooks: number | null;
  /** Policy only for now — nothing is deleted automatically. */
  dataRetentionMonths: number | null;
  channels: Channel[];
  exportFormats: ExportFormat[];
  branding: BrandingLevel;
}

export type NumericLimitKey = {
  [K in keyof PlanLimits]: PlanLimits[K] extends number | null ? K : never;
}[keyof PlanLimits];

export interface PlanDefinition {
  code: PlanCode;
  label: string;
  /** One line for the upgrade page. */
  blurb: string;
  modules: LicensedModule[];
  limits: PlanLimits;
}

/* ------------------------------------------------------------------ */

/** Shared by every plan — the core nobody can be sold without. */
const CORE: LicensedModule[] = ['feedback', 'organization', 'reports'];

export const PLANS: Record<PlanCode, PlanDefinition> = {
  starter: {
    code: 'starter',
    label: 'Starter',
    blurb: 'A complete 360 cycle for a small team, with email invitations and standard reports.',
    // A working product, not a crippled demo: a small school can run a real cycle,
    // invite reviewers and read individual and departmental reports. What it lacks is
    // scale and the analytics that make the data valuable — which is the pressure that
    // converts, rather than a wall that stops anyone evaluating the product at all.
    modules: [...CORE, 'communication'],
    limits: {
      maxEmployees: 25,
      maxUsers: 25,
      maxActiveCycles: 1,
      maxCyclesPerYear: 2,
      maxDepartments: 10,
      maxCampuses: 1,
      maxStudents: 0,
      maxParentLinksPerMonth: 0,
      maxEmailsPerMonth: 500,
      maxSmsPerMonth: 0,
      maxWhatsAppPerMonth: 0,
      maxImportRowsPerFile: 200,
      maxScheduledReports: 0,
      maxApiKeys: 0,
      maxWebhooks: 0,
      dataRetentionMonths: 12,
      channels: ['email'],
      exportFormats: [],
      branding: 'none',
    },
  },

  professional: {
    code: 'professional',
    label: 'Professional',
    blurb: 'Regular 360 cycles for a whole organisation: parent feedback, student roster, advanced reporting and exports.',
    // Parent feedback and the student roster both sit here rather than in Enterprise.
    // They are what makes this product different from a generic 360 tool, and the
    // segment most likely to buy is exactly the one that needs them.
    modules: [
      ...CORE,
      'communication',
      'reports_advanced',
      'exports',
      'parent_feedback',
      'sis_integration',
      'bulk_generation',
      'audit_trail',
    ],
    limits: {
      maxEmployees: 500,
      maxUsers: 500,
      maxActiveCycles: 10,
      maxCyclesPerYear: null,
      maxDepartments: 100,
      maxCampuses: 5,
      maxStudents: 2000,
      maxParentLinksPerMonth: 500,
      maxEmailsPerMonth: 10_000,
      maxSmsPerMonth: 1_000,
      maxWhatsAppPerMonth: 1_000,
      maxImportRowsPerFile: 5_000,
      maxScheduledReports: 5,
      maxApiKeys: 0,
      maxWebhooks: 0,
      dataRetentionMonths: 36,
      channels: ['email', 'sms', 'whatsapp'],
      exportFormats: ['csv', 'xlsx'],
      branding: 'logo',
    },
  },

  enterprise: {
    code: 'enterprise',
    label: 'Enterprise',
    blurb: 'Everything, with HR synchronisation, the integration API, approval workflows, AI insights and no usage caps.',
    // What is left once parent feedback and SIS move down: the integrations that cost
    // implementation time, governance, AI, and unlimited scale. That is what a
    // services-shaped price is for.
    modules: [
      ...CORE,
      'communication',
      'reports_advanced',
      'exports',
      'parent_feedback',
      'sis_integration',
      'bulk_generation',
      'audit_trail',
      'workflows',
      'ai_insights',
      'hr_integration',
      'api_access',
    ],
    limits: {
      maxEmployees: null,
      maxUsers: null,
      maxActiveCycles: null,
      maxCyclesPerYear: null,
      maxDepartments: null,
      maxCampuses: null,
      maxStudents: null,
      maxParentLinksPerMonth: null,
      maxEmailsPerMonth: 100_000,
      maxSmsPerMonth: 20_000,
      maxWhatsAppPerMonth: 20_000,
      maxImportRowsPerFile: 50_000,
      maxScheduledReports: 50,
      maxApiKeys: 10,
      maxWebhooks: 20,
      dataRetentionMonths: null,
      channels: ['email', 'sms', 'whatsapp'],
      exportFormats: ['csv', 'xlsx', 'pdf'],
      branding: 'full',
    },
  },
};

export const isPlanCode = (v: string): v is PlanCode => (PLAN_CODES as readonly string[]).includes(v);

/** The plan a tenant falls back to when nothing else resolves. */
export const DEFAULT_PLAN: PlanCode = 'starter';

/**
 * The cheapest plan that includes a module — what an upgrade prompt should name.
 * Derived from the catalogue rather than hard-coded, so moving a module between plans
 * updates every prompt automatically.
 */
export function lowestPlanWith(module: LicensedModule): PlanCode | null {
  for (const code of PLAN_CODES) if (PLANS[code].modules.includes(module)) return code;
  return null;
}

/** The cheapest plan whose limit is higher than `current` — for a "you have hit the cap" prompt. */
export function lowestPlanWithLimit(key: NumericLimitKey, current: number | null): PlanCode | null {
  for (const code of PLAN_CODES) {
    const value = PLANS[code].limits[key];
    if (value === null) return code;
    if (current !== null && value > current) return code;
  }
  return null;
}
