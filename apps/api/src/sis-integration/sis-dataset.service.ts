import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { type SisSnapshot } from './sis-snapshot.types';
import { EntitlementService } from '../license/entitlement.service';

/**
 * One cached, already-parsed snapshot per organization, held for the lifetime of the
 * process and validated against the row's `updated_at` on every read.
 *
 * WHY THIS EXISTS. The roster is a single JSONB document. At 8,120 students it is
 * ~13.8 MB of JSON, and Prisma spends ~460 ms fetching and deserialising it — measured,
 * against a query whose own `EXPLAIN ANALYZE` is 0.027 ms. Every SIS request paid that
 * to do ~0.2 ms of actual filtering. Under a 50-user load test this one statement
 * accounted for 9,053 ms of database time across 85 calls, roughly thirty times every
 * other query combined, while PostgreSQL sat at 1% CPU and the API at 88%.
 *
 * WHY IT IS SAFE. The freshness check is a `SELECT updated_at` on a unique key — a
 * sub-millisecond index lookup — so a snapshot written by ANY process (another API
 * replica, a worker, a manual sync) is picked up on the very next read. That preserves
 * the property the original per-request `requestCached()` was written for: a fresh sync
 * is visible immediately. What it removes is re-parsing 13.8 MB when nothing changed.
 *
 * INVARIANT: callers must treat the returned snapshot as READ-ONLY. It is shared. The
 * existing readers all satisfy this — `StoredSisProvider` only filters/slices, and
 * `SisSyncService.reconcile()` builds new arrays and spreads rather than mutating. A
 * defensive deep clone would cost the very milliseconds this cache exists to save.
 */
interface CachedSnapshot {
  updatedAt: number;
  snapshot: SisSnapshot;
}

/**
 * The persisted per-organization SIS dataset (one row per org, JSON snapshot).
 * `StoredSisProvider` reads it to serve the existing SisProvider interface; the
 * import/sync engine writes it. A missing row means the org has no synced roster
 * yet (the tenant-aware binding then falls back to the legacy provider).
 */
@Injectable()
export class SisDatasetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
  ) {}

  /** Process-local. Not Redis: the cost is Node parsing JSON, and a Redis round-trip
   *  would hand back the same 13.8 MB to parse again. */
  private static readonly cache = new Map<string, CachedSnapshot>();

  /** In-flight reads per org, so a burst of concurrent requests after an import
   *  triggers ONE 460 ms load rather than one per request. */
  private static readonly inflight = new Map<string, Promise<SisSnapshot | null>>();

  async get(organizationId: string): Promise<SisSnapshot | null> {
    const stamp = await this.prisma.sisDataset.findUnique({
      where: { organizationId },
      select: { updatedAt: true },
    });
    if (!stamp) {
      SisDatasetService.cache.delete(organizationId);
      return null;
    }

    const updatedAt = stamp.updatedAt.getTime();
    const hit = SisDatasetService.cache.get(organizationId);
    if (hit && hit.updatedAt === updatedAt) return hit.snapshot;

    const pending = SisDatasetService.inflight.get(organizationId);
    if (pending) return pending;

    const load = (async () => {
      try {
        const row = await this.prisma.sisDataset.findUnique({
          where: { organizationId },
          select: { snapshot: true, updatedAt: true },
        });
        if (!row) { SisDatasetService.cache.delete(organizationId); return null; }
        const snapshot = row.snapshot as unknown as SisSnapshot;
        // Store the timestamp READ BACK WITH THE SNAPSHOT, not the one from the probe
        // above: a write landing between the two reads would otherwise cache new data
        // under an old stamp and go unnoticed until the next write.
        SisDatasetService.cache.set(organizationId, { updatedAt: row.updatedAt.getTime(), snapshot });
        return snapshot;
      } finally {
        SisDatasetService.inflight.delete(organizationId);
      }
    })();
    SisDatasetService.inflight.set(organizationId, load);
    return load;
  }

  /** The dataset row's own id — the audit trail's entity, since `audit_logs.entity_id` is a UUID
   *  and a roster record's id (`S1000`, `PA0-1`) is not one. The record id travels in the value. */
  async id(organizationId: string): Promise<string | null> {
    const row = await this.prisma.sisDataset.findUnique({ where: { organizationId }, select: { id: true } });
    return row?.id ?? null;
  }

  async has(organizationId: string): Promise<boolean> {
    return (await this.prisma.sisDataset.count({ where: { organizationId } })) > 0;
  }

  async meta(organizationId: string): Promise<{ provider: string; studentCount: number; teacherCount: number; updatedAt: Date } | null> {
    const row = await this.prisma.sisDataset.findUnique({ where: { organizationId }, select: { provider: true, studentCount: true, teacherCount: true, updatedAt: true } });
    return row ?? null;
  }

  async save(organizationId: string, provider: string, snapshot: SisSnapshot, userId: string | null): Promise<void> {
    /*
     * The student cap, checked at the ONE place the roster is written.
     *
     * The roster is a snapshot rather than a table of rows, so there is no per-student
     * creation point to guard; every import, sync and roster edit funnels through here.
     * The whole snapshot is measured, not the delta, because a sync replaces the roster
     * outright — counting the difference would let a tenant stay over the cap for ever
     * by re-syncing the same oversized file.
     */
    await this.entitlements.assertStudentCount(organizationId, snapshot.students.length);
    const value = snapshot as unknown as Prisma.InputJsonValue;
    const data = { provider, snapshot: value, studentCount: snapshot.students.length, teacherCount: snapshot.teachers.length, updatedBy: userId };
    const row = await this.prisma.sisDataset.upsert({
      where: { organizationId },
      update: data,
      create: { organizationId, ...data },
      select: { updatedAt: true },
    });
    // Seed the cache from the object we just wrote. The writer already holds the
    // parsed snapshot, so the next reader on THIS process skips the 460 ms reload
    // entirely; other processes pick it up via the updated_at check in get().
    SisDatasetService.cache.set(organizationId, { updatedAt: row.updatedAt.getTime(), snapshot });
  }

  /** Drop the cached snapshot for an organization. For tests and for any future path
   *  that mutates the row outside `save()`. */
  static invalidate(organizationId?: string): void {
    if (organizationId) SisDatasetService.cache.delete(organizationId);
    else SisDatasetService.cache.clear();
  }
}
