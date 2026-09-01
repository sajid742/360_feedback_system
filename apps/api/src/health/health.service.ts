import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

export type CheckStatus = 'up' | 'down' | 'skipped';

/**
 * Schema version this build of the API expects (F-H7). Bump together with the
 * matching INSERT at the bottom of `database/001_reconcile.sql`. Surfacing a
 * mismatch here is what turns "we ran the upgrade script" into something an
 * operator can actually verify.
 */
export const EXPECTED_SCHEMA_VERSION = '2026.08.21-01';

export interface ReadinessResult {
  status: 'ok' | 'degraded' | 'error';
  ready: boolean;
  checks: {
    database: { status: CheckStatus; latencyMs?: number; error?: string };
    redis: { status: CheckStatus; latencyMs?: number; detail?: string };
    schema: { status: 'ok' | 'outdated' | 'unknown'; expected: string; applied?: string | null };
  };
  uptimeSeconds: number;
  timestamp: string;
}

export interface LivenessResult {
  status: 'ok';
  uptimeSeconds: number;
  timestamp: string;
}

/**
 * Health/readiness checks (F18). Liveness reports the process is up; readiness
 * probes the dependencies an orchestrator / load balancer needs before routing
 * traffic. Dependency-free (no @nestjs/terminus) to match the project's style and
 * to reuse the existing Prisma client + the F4 Redis-reachability approach.
 *
 * Readiness policy: the **database is the hard gate** — if it's unreachable the
 * service is NOT ready (HTTP 503). Redis is treated as optional because delivery
 * degrades to inline sending without it (F4): a configured-but-unreachable Redis
 * is reported as `down` and marks the overall status `degraded`, but does not fail
 * readiness; an unset REDIS_HOST is reported as `skipped`.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  liveness(): LivenessResult {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()), timestamp: new Date().toISOString() };
  }

  async readiness(): Promise<ReadinessResult> {
    const database = await this.checkDatabase();
    const redis = await this.checkRedis();
    const schema = database.status === 'up' ? await this.checkSchema() : { status: 'unknown' as const, expected: EXPECTED_SCHEMA_VERSION };

    // The database is the hard gate. An out-of-date schema is reported as degraded
    // (not a hard failure) so an operator sees it clearly without the service being
    // pulled out of the load balancer mid-upgrade.
    const ready = database.status === 'up';
    const status: ReadinessResult['status'] = !ready
      ? 'error'
      : redis.status === 'down' || schema.status === 'outdated'
        ? 'degraded'
        : 'ok';

    return {
      status,
      ready,
      checks: { database, redis, schema },
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  /** Compare the applied schema version with the one this build expects (F-H7). */
  private async checkSchema(): Promise<ReadinessResult['checks']['schema']> {
    try {
      const rows = await this.prisma.$queryRaw<{ version: string }[]>`
        SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1`;
      const applied = rows[0]?.version ?? null;
      if (applied === EXPECTED_SCHEMA_VERSION) return { status: 'ok', expected: EXPECTED_SCHEMA_VERSION, applied };
      this.logger.warn(
        `Schema version mismatch: database is at ${applied ?? 'unknown'}, this build expects ${EXPECTED_SCHEMA_VERSION}. Apply database/001_reconcile.sql.`,
      );
      return { status: 'outdated', expected: EXPECTED_SCHEMA_VERSION, applied };
    } catch {
      // Table absent = a database that predates version tracking.
      return { status: 'unknown', expected: EXPECTED_SCHEMA_VERSION, applied: null };
    }
  }

  private async checkDatabase(): Promise<ReadinessResult['checks']['database']> {
    const started = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'up', latencyMs: Date.now() - started };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'database unreachable';
      this.logger.warn(`Readiness: database check failed — ${message}`);
      return { status: 'down', latencyMs: Date.now() - started, error: message };
    }
  }

  private async checkRedis(): Promise<ReadinessResult['checks']['redis']> {
    const host = process.env.REDIS_HOST;
    if (!host) return { status: 'skipped', detail: 'REDIS_HOST not configured — inline delivery in use' };
    const port = Number(process.env.REDIS_PORT ?? 6379);
    const started = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const IORedisModule = require('ioredis');
    const IORedis = (IORedisModule.default ?? IORedisModule) as new (opts: Record<string, unknown>) => {
      connect(): Promise<void>; ping(): Promise<string>; disconnect(): void; on(ev: string, cb: (e: unknown) => void): void;
    };
    const client = new IORedis({ host, port, lazyConnect: true, connectTimeout: 1500, maxRetriesPerRequest: 1, retryStrategy: () => null });
    client.on('error', () => { /* swallow probe errors — handled by try/catch */ });
    try {
      await client.connect();
      await client.ping();
      return { status: 'up', latencyMs: Date.now() - started };
    } catch {
      return { status: 'down', latencyMs: Date.now() - started, detail: `Redis at ${host}:${port} unreachable — delivery falls back to inline` };
    } finally {
      client.disconnect();
    }
  }
}
