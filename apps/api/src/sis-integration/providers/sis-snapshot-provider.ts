import type { SisSnapshot } from '../sis-snapshot.types';

/**
 * A SIS source that can produce a full roster snapshot. Mirrors the HR provider
 * contract. The import/sync engine turns the snapshot into the persisted per-org
 * dataset; `StoredSisProvider` then serves it through the existing `SisProvider`
 * interface, so the 360 business logic never depends on this.
 */
export interface SisSnapshotProvider {
  readonly name: string;
  /** `options` carries the decrypted connection, mock scenario, and an optional row cap. */
  getSnapshot(organizationId: string, options?: Record<string, unknown>): Promise<SisSnapshot>;
}
