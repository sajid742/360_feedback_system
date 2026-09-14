import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { LicenseService } from './license.service';
import {
  ALWAYS_ON_MODULES,
  LICENSED_MODULES,
  MODULE_LABELS,
  type LicenseState,
  type LicenseStatus,
  type LicensedModule,
} from './license.types';
import {
  DEFAULT_PLAN,
  PLANS,
  isPlanCode,
  lowestPlanWith,
  lowestPlanWithLimit,
  type BrandingLevel,
  type ExportFormat,
  type NumericLimitKey,
  type PlanCode,
  type PlanLimits,
} from './plans';
import {
  LIMIT_WARNING_AT,
  OPERATIONAL_STATUSES,
  isSubscriptionStatus,
  type EntitlementSource,
  type EntitlementState,
  type LimitUsage,
  type SubscriptionStatus,
} from './entitlements.types';

/** Human labels for the limits an administrator sees. */
const LIMIT_LABELS: Record<NumericLimitKey, string> = {
  maxEmployees: 'Employees',
  maxUsers: 'User accounts',
  maxActiveCycles: 'Active feedback cycles',
  maxCyclesPerYear: 'Cycles this year',
  maxDepartments: 'Departments',
  maxCampuses: 'Campuses',
  maxStudents: 'Students',
  maxParentLinksPerMonth: 'Parent links this month',
  maxEmailsPerMonth: 'Emails this month',
  maxSmsPerMonth: 'SMS this month',
  maxWhatsAppPerMonth: 'WhatsApp messages this month',
  maxImportRowsPerFile: 'Rows per import file',
  maxScheduledReports: 'Scheduled report digests',
  maxApiKeys: 'API keys',
  maxWebhooks: 'Webhooks',
  dataRetentionMonths: 'Data retention (months)',
};

/**
 * Carry an already-issued licence forward onto the wider module list.
 *
 * THE PROBLEM THIS SOLVES. Splitting `reports` into `reports` + `reports_advanced` +
 * `exports`, and putting a gate on bulk generation, workflows and the audit trail, adds
 * five module names that no licence signed before today can possibly contain. Filtering
 * a customer's licence against the new list would therefore switch off five features
 * they have been using and have already paid for — a silent downgrade delivered by an
 * upgrade, which is about the worst thing a release can do.
 *
 * The rule is "what could they do yesterday?":
 *   - bulk generation, workflows and the audit trail were never licensable at all, so
 *     every licence keeps them;
 *   - the advanced dashboards and exports lived inside `reports`, so a licence carrying
 *     `reports` keeps them too.
 *
 * Applied ONLY to an installed licence. A subscription is written against the current
 * catalogue and needs no translation, and the development licence already holds
 * everything.
 */
export function expandLegacyLicenceModules(modules: LicensedModule[]): LicensedModule[] {
  const out = new Set<LicensedModule>(modules);
  for (const m of ['bulk_generation', 'workflows', 'audit_trail'] as LicensedModule[]) out.add(m);
  if (out.has('reports')) {
    out.add('reports_advanced');
    out.add('exports');
  }
  return [...out];
}

/**
 * What an organisation is entitled to, and how much of it.
 *
 * THE COMPOSITION POINT. `LicenseService` is untouched and still answers the on-premise
 * question ("is there a valid signed licence file?"). This service sits in front of it
 * and answers the commercial one, resolving in a fixed order:
 *
 *   1. a subscription row          → the cloud SaaS path
 *   2. an installed licence        → the existing on-premise path, verbatim
 *   3. the development licence     → internal builds only
 *   4. nothing                     → core modules, NONE status
 *
 * An existing on-premise customer never gets a subscription row, so branch 2 runs
 * exactly the code that runs today. That is what makes this safe to ship alongside
 * current installations.
 *
 * ENTITLEMENTS ARE NOT PERMISSIONS. RBAC answers "may THIS USER do it?"; entitlements
 * answer "did this ORGANISATION buy it?". Both must say yes. Nothing here is ever
 * seeded into the `permissions` table or assignable to a role — so an HR Admin on
 * Starter keeps `reports.executive` in their role and simply starts being able to use
 * it the moment the organisation upgrades, with no role change.
 */
@Injectable()
export class EntitlementService {
  private readonly log = new Logger(EntitlementService.name);
  /** Same short per-organisation cache as the licence: these sit on hot paths. */
  private cache = new Map<string, { at: number; state: EntitlementState }>();
  private static readonly CACHE_MS = 30_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly license: LicenseService,
  ) {}

  /* ------------------------------------------------------------------ read */

  async get(orgId: string): Promise<EntitlementState> {
    const hit = this.cache.get(orgId);
    if (hit && Date.now() - hit.at < EntitlementService.CACHE_MS) return hit.state;
    const state = await this.resolve(orgId);
    this.cache.set(orgId, { at: Date.now(), state });
    return state;
  }

  /** Call after any change to a subscription row. */
  invalidate(orgId: string): void {
    this.cache.delete(orgId);
  }

  private async resolve(orgId: string): Promise<EntitlementState> {
    const row = await this.prisma.subscription.findFirst({
      where: { organizationId: orgId, deletedAt: null },
    });

    if (row) return this.fromSubscription(orgId, row);

    // No subscription: fall through to the licence path, unchanged. The plan fields are
    // null because there is no plan — an on-premise licence is not a subscription, and
    // pretending otherwise would put a fictional plan name on their screen.
    const licenceState = await this.license.getState(orgId);
    const source: EntitlementSource = licenceState.isDevelopment
      ? 'development'
      : licenceState.payload
        ? 'license'
        : 'none';
    return {
      ...licenceState,
      modules: source === 'license' ? expandLegacyLicenceModules(licenceState.modules) : licenceState.modules,
      source,
      planCode: null,
      planLabel: null,
      limits: this.limitsFromLicence(licenceState),
      subscriptionStatus: null,
      trialEndsAt: null,
      currentPeriodEnd: null,
    };
  }

  /**
   * Translate an installed licence into the limits shape.
   *
   * The legacy payload only carries `maxEmployees` and `maxUsers`, and uses `0` to mean
   * unlimited. Everything else is left unlimited rather than invented: an existing
   * customer bought a licence with no notion of a campus cap, and must not acquire one
   * on upgrade.
   */
  private limitsFromLicence(state: LicenseState): PlanLimits {
    const unlimited: PlanLimits = {
      ...PLANS.enterprise.limits,
      maxEmailsPerMonth: null,
      maxSmsPerMonth: null,
      maxWhatsAppPerMonth: null,
      maxImportRowsPerFile: null,
      maxScheduledReports: null,
      maxApiKeys: null,
      maxWebhooks: null,
    };
    return {
      ...unlimited,
      maxEmployees: state.maxEmployees && state.maxEmployees > 0 ? state.maxEmployees : null,
      maxUsers: state.maxUsers ?? null,
    };
  }

  private fromSubscription(
    orgId: string,
    row: {
      planCode: string;
      status: string;
      trialEndsAt: Date | null;
      currentPeriodEnd: Date | null;
      graceDays: number;
      limitOverrides: unknown;
      moduleOverrides: unknown;
    },
  ): EntitlementState {
    const planCode: PlanCode = isPlanCode(row.planCode) ? row.planCode : DEFAULT_PLAN;
    if (!isPlanCode(row.planCode)) {
      this.log.warn(`Organisation ${orgId} has unknown plan "${row.planCode}" — falling back to ${DEFAULT_PLAN}.`);
    }
    const plan = PLANS[planCode];
    const status: SubscriptionStatus = isSubscriptionStatus(row.status) ? row.status : 'active';
    const operational = OPERATIONAL_STATUSES.includes(status);

    const modules = operational
      ? this.applyModuleOverrides(plan.modules, row.moduleOverrides)
      : [...ALWAYS_ON_MODULES];
    const limits = this.applyLimitOverrides(plan.limits, row.limitOverrides);

    const { licenseStatus, message, daysRemaining } = this.describe(status, plan.label, row);

    return {
      status: licenseStatus,
      payload: null,
      message,
      daysRemaining,
      operational,
      isDevelopment: false,
      modules,
      // Kept in sync so the existing licence screen and usage endpoint keep working.
      maxEmployees: limits.maxEmployees ?? 0,
      maxUsers: limits.maxUsers,
      graceDays: row.graceDays,
      source: 'subscription' as EntitlementSource,
      planCode,
      planLabel: plan.label,
      limits,
      subscriptionStatus: status,
      trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
      currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
    };
  }

  /** Overrides are operator input, so every value is validated rather than trusted. */
  private applyModuleOverrides(base: LicensedModule[], raw: unknown): LicensedModule[] {
    const o = (raw ?? {}) as { add?: unknown; remove?: unknown };
    const valid = (v: unknown): v is LicensedModule =>
      typeof v === 'string' && (LICENSED_MODULES as readonly string[]).includes(v);
    const add = Array.isArray(o.add) ? o.add.filter(valid) : [];
    const remove = Array.isArray(o.remove) ? o.remove.filter(valid) : [];
    const set = new Set<LicensedModule>([...base, ...add]);
    for (const m of remove) if (!ALWAYS_ON_MODULES.includes(m)) set.delete(m);
    for (const m of ALWAYS_ON_MODULES) set.add(m);
    return [...set];
  }

  private applyLimitOverrides(base: PlanLimits, raw: unknown): PlanLimits {
    const o = (raw ?? {}) as Record<string, unknown>;
    const out = { ...base } as unknown as Record<string, unknown>;
    const baseAny = base as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(o)) {
      if (!(key in baseAny)) continue;
      const current = baseAny[key];
      if (typeof current === 'number' || current === null) {
        if (value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)) out[key] = value;
      } else if (Array.isArray(current) && Array.isArray(value)) {
        out[key] = value.filter((v) => typeof v === 'string');
      } else if (typeof current === 'string' && typeof value === 'string') {
        out[key] = value;
      }
    }
    return out as unknown as PlanLimits;
  }

  /** One place where a subscription status becomes something an administrator reads. */
  private describe(
    status: SubscriptionStatus,
    planLabel: string,
    row: { trialEndsAt: Date | null; currentPeriodEnd: Date | null; graceDays: number },
  ): { licenseStatus: LicenseStatus; message: string; daysRemaining: number | null } {
    const day = 86_400_000;
    const daysTo = (d: Date | null): number | null => (d ? Math.ceil((d.getTime() - Date.now()) / day) : null);
    const on = (l: LicenseStatus, m: string, n: number | null = null) => ({ licenseStatus: l, message: m, daysRemaining: n });

    switch (status) {
      case 'trialing': {
        const left = daysTo(row.trialEndsAt);
        return on(
          'EXPIRING',
          left === null
            ? `${planLabel} trial.`
            : `${planLabel} trial — ${left} day${left === 1 ? '' : 's'} remaining.`,
          left,
        );
      }
      case 'active': {
        const left = daysTo(row.currentPeriodEnd);
        return on('ACTIVE', `Subscribed to ${planLabel}.`, left);
      }
      case 'past_due':
        return on('EXPIRING', `Your ${planLabel} subscription is past due. Please settle the invoice to avoid interruption.`, daysTo(row.currentPeriodEnd));
      case 'grace': {
        const left = daysTo(row.currentPeriodEnd);
        return on(
          'GRACE_PERIOD',
          `Your ${planLabel} subscription has lapsed. You are in a ${row.graceDays}-day grace period — please renew to avoid losing access.`,
          left,
        );
      }
      case 'expired':
        return on('EXPIRED', 'Your subscription has expired. Your data is untouched and you can still sign in and renew, but new records cannot be added.');
      case 'suspended':
        return on('SUSPENDED', 'This organisation has been suspended. Please contact support.');
      case 'cancelled':
        return on('EXPIRED', 'Your subscription has been cancelled. Your data is retained and you can still sign in, export it and resubscribe.');
    }
  }

  /* -------------------------------------------------------------- modules */

  async hasModule(orgId: string, module: LicensedModule): Promise<boolean> {
    const state = await this.get(orgId);
    if (ALWAYS_ON_MODULES.includes(module)) return true;
    if (!state.operational) return false;
    return state.modules.includes(module);
  }

  /**
   * Refuse a module the organisation has not bought.
   *
   * 404, not 403, matching `LicensedFeatureGuard`: a module you have not bought should
   * look absent rather than withheld, and 403 would confirm it is there.
   */
  async assertModule(orgId: string, module: LicensedModule): Promise<void> {
    if (await this.hasModule(orgId, module)) return;
    const plan = lowestPlanWith(module);
    throw new NotFoundException(
      plan
        ? `${MODULE_LABELS[module]} is not included in your plan. It is available from ${PLANS[plan].label}.`
        : `${MODULE_LABELS[module]} is not included in your plan.`,
    );
  }

  /* --------------------------------------------------------------- limits */

  async limits(orgId: string): Promise<PlanLimits> {
    return (await this.get(orgId)).limits;
  }

  /**
   * Refuse an addition that would take the organisation past its limit.
   *
   * Generalises the existing `assertCanAddEmployees`, which stays as the employee-facing
   * wrapper so its two call sites are untouched.
   */
  async assertWithinLimit(orgId: string, key: NumericLimitKey, adding = 1): Promise<void> {
    const limit = (await this.limits(orgId))[key];
    if (limit === null) return;
    const used = await this.count(orgId, key);
    if (used + adding <= limit) return;
    const next = lowestPlanWithLimit(key, limit);
    const suffix = next ? ` ${PLANS[next].label} raises this limit.` : '';
    throw new ForbiddenException(
      limit === 0
        ? `${LIMIT_LABELS[key]} are not included in your plan.${suffix}`
        : `Your plan allows ${limit} ${LIMIT_LABELS[key].toLowerCase()} and ${used} ${used === 1 ? 'is' : 'are'} already in use.${suffix}`,
    );
  }

  /**
   * Current usage for one limit.
   *
   * Every counter reads a table that already exists, which is why no metering table was
   * needed: employees, users, departments, campuses and cycles are direct counts, and
   * the monthly figures are `notifications` / `evaluation_links` rows filtered by month.
   */
  async count(orgId: string, key: NumericLimitKey): Promise<number> {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const yearStart = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));

    switch (key) {
      case 'maxEmployees':
        return this.prisma.employee.count({ where: { organizationId: orgId, status: 'active', deletedAt: null } });
      case 'maxUsers':
        return this.prisma.user.count({ where: { organizationId: orgId, status: 'active', deletedAt: null } });
      case 'maxActiveCycles':
        return this.prisma.appraisalCycle.count({ where: { organizationId: orgId, status: 'active', deletedAt: null } });
      case 'maxCyclesPerYear':
        return this.prisma.appraisalCycle.count({ where: { organizationId: orgId, deletedAt: null, createdAt: { gte: yearStart } } });
      case 'maxDepartments':
        return this.prisma.department.count({ where: { organizationId: orgId, deletedAt: null } });
      case 'maxCampuses':
        return this.prisma.organization.count({ where: { parentOrgId: orgId, orgType: 'campus', deletedAt: null } });
      case 'maxStudents': {
        // The roster is a snapshot, not a table of rows — read its recorded count.
        const ds = await this.prisma.sisDataset.findFirst({
          where: { organizationId: orgId },
          orderBy: { createdAt: 'desc' },
          select: { studentCount: true },
        });
        return ds?.studentCount ?? 0;
      }
      case 'maxParentLinksPerMonth':
        return this.prisma.evaluationLink.count({ where: { organizationId: orgId, createdAt: { gte: monthStart } } });
      case 'maxEmailsPerMonth':
        return this.prisma.notification.count({ where: { organizationId: orgId, channel: 'email', createdAt: { gte: monthStart } } });
      case 'maxSmsPerMonth':
        return this.prisma.notification.count({ where: { organizationId: orgId, channel: 'sms', createdAt: { gte: monthStart } } });
      case 'maxWhatsAppPerMonth':
        return this.prisma.notification.count({ where: { organizationId: orgId, channel: 'whatsapp', createdAt: { gte: monthStart } } });
      case 'maxScheduledReports':
        return this.prisma.reportSchedule.count({ where: { organizationId: orgId } });
      case 'maxApiKeys':
        return this.prisma.apiKey.count({ where: { organizationId: orgId, revokedAt: null } });
      case 'maxWebhooks':
        return this.prisma.webhookEndpoint.count({ where: { organizationId: orgId } });
      // Not a stock: it bounds a single request, so there is nothing to count.
      case 'maxImportRowsPerFile':
      case 'dataRetentionMonths':
        return 0;
    }
  }

  /** Every countable limit with its current usage — for the tenant banner and the platform screen. */
  async usage(orgId: string): Promise<LimitUsage[]> {
    const limits = await this.limits(orgId);
    const keys = (Object.keys(LIMIT_LABELS) as NumericLimitKey[]).filter(
      // Neither of these is a stock: one bounds a single request and the other is a
      // policy statement, so there is nothing to show a usage bar for.
      (k) => k !== 'maxImportRowsPerFile' && k !== 'dataRetentionMonths',
      );
    const rows = await Promise.all(
      keys.map(async (key) => {
        const limit = limits[key];
        const used = await this.count(orgId, key);
        const percent = limit === null || limit === 0 ? null : Math.round((used / limit) * 100);
        /*
         * A limit of ZERO means the feature is not included, not that the tenant has
         * exhausted it. Reporting `0 of 0` as exceeded made every Starter tenant open
         * a red "you have reached your plan limit of 0" banner on first sign-in, for
         * seven limits at once, before doing anything at all. The locked navigation
         * entry already says the feature is not included; this is about capacity.
         */
        const notIncluded = limit === 0;
        return {
          key,
          label: LIMIT_LABELS[key],
          used,
          limit,
          percent,
          warning: !notIncluded && percent !== null && percent >= LIMIT_WARNING_AT * 100,
          exceeded: !notIncluded && limit !== null && used >= limit,
        } satisfies LimitUsage;
      }),
    );
    return rows;
  }

  /* ---------------------------------------------------------- value gates */

  async assertExportFormat(orgId: string, format: ExportFormat): Promise<void> {
    const { exportFormats } = await this.limits(orgId);
    if (exportFormats.includes(format)) return;
    const next = (Object.keys(PLANS) as PlanCode[]).find((p) => PLANS[p].limits.exportFormats.includes(format));
    throw new ForbiddenException(
      `Your plan does not include ${format.toUpperCase()} export.` + (next ? ` It is available from ${PLANS[next].label}.` : ''),
    );
  }

  private static readonly BRANDING_RANK: Record<BrandingLevel, number> = { none: 0, logo: 1, full: 2 };

  async assertBrandingLevel(orgId: string, required: BrandingLevel): Promise<void> {
    const { branding } = await this.limits(orgId);
    if (EntitlementService.BRANDING_RANK[branding] >= EntitlementService.BRANDING_RANK[required]) return;
    throw new ForbiddenException('Your plan does not include this level of branding customisation.');
  }

  /**
   * The student cap. Takes the whole roster size rather than a delta, because a sync
   * replaces the snapshot outright — see the call site in `sis-dataset.service.ts`.
   */
  async assertStudentCount(orgId: string, students: number): Promise<void> {
    const limit = (await this.limits(orgId)).maxStudents;
    if (limit === null || students <= limit) return;
    const next = lowestPlanWithLimit('maxStudents', limit);
    const suffix = next ? ` ${PLANS[next].label} raises this limit.` : '';
    throw new ForbiddenException(
      limit === 0
        ? `Your plan does not include the student roster.${suffix}`
        : `This roster has ${students} students and your plan allows ${limit}.${suffix}`,
    );
  }

  /** Bounds one request rather than a stock, so it is checked inline at validation. */
  async assertImportRows(orgId: string, rows: number): Promise<void> {
    const limit = (await this.limits(orgId)).maxImportRowsPerFile;
    if (limit === null || rows <= limit) return;
    const next = lowestPlanWithLimit('maxImportRowsPerFile', limit);
    throw new BadRequestException(
      `This file has ${rows} rows and your plan allows ${limit} per import.` +
        (next ? ` ${PLANS[next].label} raises this limit.` : ''),
    );
  }
}
