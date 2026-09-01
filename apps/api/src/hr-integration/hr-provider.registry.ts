import { Injectable } from '@nestjs/common';
import type { HrProvider } from './hr-provider.interface';
import { MockHrProvider } from './providers/mock-hr.provider';
import { BambooHrProvider } from './providers/bamboohr.provider';
import { ZohoPeopleProvider } from './providers/zoho-people.provider';
import { GenericHrProvider } from './providers/generic-hr.provider';
import { CONFIGURABLE_PROVIDERS } from './provider-connection';

/** Available HR provider keys. Add real providers here as they are implemented. */
export interface HrProviderInfo { key: string; name: string; configurable: boolean; maturity: 'stable' | 'beta'; maturityNote?: string }

/**
 * Connector maturity (F7).
 *
 * A connector is only 'stable' once it has been exercised end-to-end against a
 * real endpoint. BambooHR and Zoho People are implemented from vendor
 * documentation and fail gracefully, but have never run against a live vendor
 * tenant — presenting them as finished would overstate what has been proven, so
 * the UI labels them Beta until a sandbox validation is recorded here.
 */
const BETA_PROVIDERS: Record<string, string> = {
  bamboohr: 'Implemented from BambooHR API documentation and not yet validated against a live BambooHR tenant. Run a dry-run sync before relying on it.',
  zoho_people: 'Implemented from Zoho People API documentation and not yet validated against a live Zoho tenant. Run a dry-run sync before relying on it.',
};

/**
 * Per-tenant HR provider selection. Unlike the SIS provider (chosen once by an
 * env var at boot), the HR provider is resolved by key at sync time so different
 * organizations can use different providers. To add a real HR system: implement
 * HrProvider, add it to the constructor + the `byKey` map (and its fields in
 * provider-connection.ts), and it becomes selectable per organization — no other
 * change to the 360 Feedback business logic.
 */
@Injectable()
export class HrProviderRegistry {
  private readonly byKey: Map<string, HrProvider>;

  constructor(
    private readonly mock: MockHrProvider,
    bamboo: BambooHrProvider,
    zoho: ZohoPeopleProvider,
    generic: GenericHrProvider,
  ) {
    this.byKey = new Map<string, HrProvider>([
      ['mock', mock],
      ['bamboohr', bamboo],
      ['zoho_people', zoho],
      ['generic', generic],
    ]);
  }

  /** Resolve a provider by key, falling back to the mock provider. */
  get(key: string | null | undefined): HrProvider {
    return this.byKey.get((key ?? 'mock').toLowerCase()) ?? this.mock;
  }

  /** The providers an administrator can choose from (in registration order). */
  available(): HrProviderInfo[] {
    return [...this.byKey.entries()].map(([key, p]) => ({
      key,
      name: p.name,
      configurable: CONFIGURABLE_PROVIDERS.has(key),
      maturity: BETA_PROVIDERS[key] ? ('beta' as const) : ('stable' as const),
      maturityNote: BETA_PROVIDERS[key],
    }));
  }
}
