/**
 * The licence model.
 *
 * A licence is a signed statement by the vendor about one customer installation:
 * who it is for, until when, how many employees, and which modules. It is verified
 * entirely locally — there is no licensing server and no network call — because this
 * product is deployed on-premise and must keep working without internet access.
 */

/** Editions are labels for a bundle of limits; the limits themselves live in the licence. */
export type LicenseEdition = 'trial' | 'demo' | 'standard' | 'professional' | 'enterprise';

/**
 * The modules a licence can switch on.
 *
 * DELIBERATELY COARSE. These are things a customer buys, not things a user is permitted
 * to do — RBAC already answers the second question. Splitting a licence down to
 * individual screens would duplicate the permission catalogue and leave two systems to
 * keep in step.
 */
export const LICENSED_MODULES = [
  'feedback',         // 360 cycles, questionnaires, competencies — the core, always on
  'organization',     // employees, departments, org chart — always on
  'reports',          // individual, departmental and participation reporting
  'reports_advanced', // executive dashboard, 9-box, heatmap, trend, layout, digests
  'exports',          // CSV / XLSX / PDF export of reports
  'communication',    // email / SMS / WhatsApp delivery
  'parent_feedback',  // external parent evaluation
  'sis_integration',  // student information system
  'hr_integration',   // HR master-data sync
  'bulk_generation',  // bulk cycle generation from a roster
  'workflows',        // approval definitions, instances, task inbox
  'audit_trail',      // the 360 feedback audit trail and its export
  'ai_insights',      // AI narrative insights
  'api_access',       // outbound integration API and webhooks
] as const;
export type LicensedModule = (typeof LICENSED_MODULES)[number];

/** Human labels for the administration screen. */
export const MODULE_LABELS: Record<LicensedModule, string> = {
  feedback: '360 Feedback',
  organization: 'Organization Management',
  reports: 'Reports',
  reports_advanced: 'Advanced Reporting & Dashboards',
  exports: 'Report Exports',
  communication: 'Communication',
  parent_feedback: 'Parent Feedback',
  sis_integration: 'Student Integration',
  hr_integration: 'HR Integration',
  bulk_generation: 'Bulk Cycle Generation',
  workflows: 'Approval Workflows',
  audit_trail: 'Feedback Audit Trail',
  ai_insights: 'AI Insights',
  api_access: 'API Integration',
};

/**
 * The core cannot be licensed away. Selling a 360 feedback product whose 360 feedback
 * can be switched off would only produce support calls, and an expired licence must
 * still let an administrator in to renew it.
 */
export const ALWAYS_ON_MODULES: LicensedModule[] = ['feedback', 'organization'];

/** What the vendor signs. Every field is data — no behaviour is encoded here. */
export interface LicensePayload {
  /** Format version, so a future change can be detected rather than guessed at. */
  v: 1;
  /** Vendor-facing identifier printed on the licence, e.g. CARE-360-2026-0001. */
  licenseId: string;
  /** Display name of the licensed organisation. */
  organizationName: string;
  /**
   * The tenant this licence is for — the organisation SLUG, not its UUID. See
   * `LicenseService.validate` for why the slug is the binding key.
   */
  organizationSlug: string;
  /** Recorded for reference and cross-checked with a warning, never enforced. */
  organizationId?: string;
  edition: LicenseEdition;
  /** ISO dates. `startsAt` lets a renewal be issued before it takes effect. */
  issuedAt: string;
  startsAt: string;
  expiresAt: string;
  /** Maximum ACTIVE employees. 0 or absent means unlimited. */
  maxEmployees: number;
  /** Maximum active user accounts. Absent means not enforced. */
  maxUsers?: number;
  modules: LicensedModule[];
  /** Days after expiry during which the installation keeps working, read-only-ish. */
  graceDays?: number;
  notes?: string;
}

/**
 * The states an administrator can see. Kept to the ones that change what happens —
 * anything finer would be a distinction without a consequence.
 */
export type LicenseStatus =
  | 'ACTIVE'
  | 'EXPIRING'        // valid, but inside the warning window
  | 'GRACE_PERIOD'    // past expiry, still usable, loudly flagged
  | 'EXPIRED'         // past grace: restricted
  | 'NOT_STARTED'     // installed ahead of its start date
  | 'SUSPENDED'       // explicitly revoked by the vendor
  | 'INVALID'         // signature, format or tenant mismatch
  | 'NONE';           // nothing installed

/** How many days before expiry the UI starts warning. */
export const EXPIRY_WARNING_DAYS = 30;
/** Used when a licence does not state its own. */
export const DEFAULT_GRACE_DAYS = 7;

/** The resolved view every caller works with. */
export interface LicenseState {
  status: LicenseStatus;
  /** Present unless the licence is absent or unreadable. */
  payload: LicensePayload | null;
  /** Plain-English explanation, safe to show an administrator. */
  message: string;
  /** Negative once expired. */
  daysRemaining: number | null;
  /** True while normal business operations are permitted. */
  operational: boolean;
  /** True when this is the built-in development licence rather than an installed one. */
  isDevelopment: boolean;
  modules: LicensedModule[];
  maxEmployees: number;
  maxUsers: number | null;
  graceDays: number;
}

/** Usage counters shown on the administration screen. */
export interface LicenseUsage {
  employees: number;
  maxEmployees: number;
  employeePercent: number;
  users: number;
  maxUsers: number | null;
}
