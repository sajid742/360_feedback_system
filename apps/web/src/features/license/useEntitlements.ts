import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api-client';

/**
 * What this organisation's subscription includes.
 *
 * WHY NOT `useLicense`. That hook reads `GET /license/status`, which requires
 * `configuration.read` — so for an ordinary employee it 403s, the hook swallows the
 * error, and the interface falls back to showing every menu entry including ones the
 * server will refuse. This reads `GET /me/entitlements`, which any signed-in user may
 * read, so the interface can reflect the plan honestly for everybody.
 *
 * FETCHED ONCE PER APP MOUNT AND SHARED. A plan changes a handful of times a year;
 * re-checking on every navigation would put a round trip on every page for an answer
 * that is almost always identical. The server enforces entitlements regardless of what
 * this says — this exists to gate the menu and to explain, not to protect.
 */

export interface CatalogueEntry {
  module: string;
  label: string;
  included: boolean;
  upgradeTo: string | null;
  upgradeToLabel: string | null;
}

export interface EntitlementLimits {
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
  dataRetentionMonths: number | null;
  channels: string[];
  exportFormats: string[];
  branding: string;
}

export interface EntitlementView {
  source: 'subscription' | 'license' | 'development' | 'none';
  plan: string | null;
  planLabel: string | null;
  status: string;
  subscriptionStatus: string | null;
  message: string;
  operational: boolean;
  isDevelopment: boolean;
  daysRemaining: number | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  modules: string[];
  limits: EntitlementLimits;
  catalogue: CatalogueEntry[];
}

export interface LimitUsage {
  key: string;
  label: string;
  used: number;
  limit: number | null;
  percent: number | null;
  warning: boolean;
  exceeded: boolean;
}

export const entitlementsApi = {
  mine: (): Promise<EntitlementView> => apiClient.get('/me/entitlements'),
  usage: (): Promise<{ limits: LimitUsage[] }> => apiClient.get('/me/usage'),
  plans: (): Promise<{ plans: { code: string; label: string; blurb: string; modules: string[]; limits: EntitlementLimits }[] }> =>
    apiClient.get('/me/plans'),
};

/** Shared across every consumer so the app makes one request, not one per component. */
let cached: EntitlementView | null = null;
let inFlight: Promise<EntitlementView> | null = null;
const subscribers = new Set<(v: EntitlementView) => void>();

/** Call after anything that could change the plan, so the menu reflects it without a reload. */
export function refreshEntitlements(): void {
  cached = null;
  inFlight = null;
}

export function useEntitlements(): { entitlements: EntitlementView | null; loading: boolean } {
  const [value, setValue] = useState<EntitlementView | null>(cached);
  const [loading, setLoading] = useState(cached === null);

  useEffect(() => {
    let cancelled = false;
    if (cached) {
      setValue(cached);
      setLoading(false);
      return;
    }
    subscribers.add(setValue);
    inFlight ??= entitlementsApi.mine().then((v) => {
      cached = v;
      subscribers.forEach((fn) => fn(v));
      return v;
    });
    inFlight
      // A failure here must not break the application: the server is the real gate, so
      // an unknown plan simply means nothing extra is hidden.
      .catch(() => null)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      subscribers.delete(setValue);
    };
  }, []);

  return { entitlements: value, loading };
}

/** Convenience: does this organisation have the module? Unknown plan → assume yes. */
export function hasModule(entitlements: EntitlementView | null, module: string): boolean {
  if (!entitlements) return true;
  return entitlements.modules.includes(module);
}
