import { Injectable } from '@nestjs/common';
import type { SisSnapshotProvider } from './providers/sis-snapshot-provider';
import { MockSisSnapshotProvider } from './providers/mock-sis-snapshot.provider';
import { GenericSisProvider } from './providers/generic-sis.provider';
import { OneRosterSisProvider } from './providers/oneroster-sis.provider';
import { SIS_CONFIGURABLE_PROVIDERS, SIS_SYNC_PROVIDERS } from './provider-connection';

export interface SisProviderInfo {
  key: string; name: string; kind: 'import' | 'sync'; configurable: boolean;
  maturity: 'stable' | 'beta'; maturityNote?: string;
}

/** Connector maturity (F7) — see the HR registry for the rationale. */
const BETA_PROVIDERS: Record<string, string> = {
  oneroster: 'OneRoster v1.1 support is implemented to the specification but has not yet been validated against a live PowerSchool / Infinite Campus / Clever / ClassLink tenant. Run a dry-run sync and check the preview before your first live sync.',
};

/**
 * Registry of SIS snapshot providers (the sources that can pull a roster). Mirrors the
 * HR provider registry. `internal` and `csv` are populated by the Excel/CSV import
 * wizard (no snapshot provider); `mock`/`generic`/`oneroster` pull a snapshot on Sync.
 * Add a standard SIS (Clever, ClassLink, PowerSchool, Ellucian) by implementing
 * SisSnapshotProvider + one entry here — no 360 business-logic change.
 */
@Injectable()
export class SisProviderRegistry {
  private readonly byKey: Map<string, SisSnapshotProvider>;

  constructor(mock: MockSisSnapshotProvider, generic: GenericSisProvider, oneroster: OneRosterSisProvider) {
    this.byKey = new Map<string, SisSnapshotProvider>([
      ['mock', mock],
      ['generic', generic],
      ['oneroster', oneroster],
    ]);
  }

  /** A snapshot-pulling provider by key, or undefined for import-only providers. */
  get(key: string | null | undefined): SisSnapshotProvider | undefined {
    return this.byKey.get((key ?? '').toLowerCase());
  }

  available(): SisProviderInfo[] {
    const names: Record<string, string> = {
      internal: 'Internal (maintained in this application)',
      csv: 'Excel / CSV',
      mock: this.byKey.get('mock')!.name,
      generic: this.byKey.get('generic')!.name,
      oneroster: this.byKey.get('oneroster')!.name,
    };
    return (['internal', 'mock', 'csv', 'generic', 'oneroster'] as const).map((key) => ({
      key,
      name: names[key],
      kind: SIS_SYNC_PROVIDERS.has(key) ? 'sync' : 'import',
      configurable: SIS_CONFIGURABLE_PROVIDERS.has(key),
      maturity: BETA_PROVIDERS[key] ? ('beta' as const) : ('stable' as const),
      maturityNote: BETA_PROVIDERS[key],
    }));
  }
}
