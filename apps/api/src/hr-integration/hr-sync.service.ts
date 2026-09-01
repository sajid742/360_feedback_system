import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { ResolverService } from '../org-import/services/resolver.service';
import { ValidationService } from '../org-import/services/validation.service';
import { ImportService } from '../org-import/services/import.service';
import type { ImportDataset } from '../org-import/org-import.types';
import { HrProviderRegistry } from './hr-provider.registry';
import { HrConfigService } from './hr-config.service';
import { HrConnectionService } from './hr-connection.service';
import type { HrSnapshot } from './hr-provider.interface';

const HR_EXTERNAL_TYPE = 'hr_employee';

/**
 * Blast-radius limits for deactivate-missing (F-C9). A sync may deactivate at most
 * this share of the active workforce in one run; small orgs get a flat allowance so
 * normal leaver volumes still process. Anything larger almost always means a
 * truncated feed rather than a real mass departure, so the sync aborts untouched.
 */
const MAX_DEACTIVATION_PERCENT = 20;
const MIN_DEACTIVATION_ALLOWANCE = 5;

export interface SyncResult {
  mode: 'dry_run' | 'live';
  provider: string;
  canSync: boolean;
  counts: { created: number; updated: number; deactivated: number; skipped: number; failed: number };
  perEntity: unknown[];
  deactivate: { employeeCode: string; name: string | null }[];
  internalOnly: number;
  errors: unknown[];
  warnings: unknown[];
  verify?: Record<string, number>;
  runId?: string;
}

/**
 * External HR synchronization. Reuses the Organization Import reconcile engine
 * (ValidationService + ImportService, mode='update' upsert) to mirror an HR
 * snapshot into the EXISTING internal model — no parallel data. Adds the two
 * sync-specific behaviours the importer doesn't: external-id identity mapping and
 * deactivate-missing (never delete, so historical feedback stays intact).
 */
@Injectable()
export class HrSyncService {
  private readonly logger = new Logger(HrSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly registry: HrProviderRegistry,
    private readonly config: HrConfigService,
    private readonly connections: HrConnectionService,
    private readonly resolver: ResolverService,
    private readonly validation: ValidationService,
    private readonly importer: ImportService,
  ) {}

  /** Build the provider options for a tenant: mock scenario + decrypted connection. */
  private async snapshotOptions(orgId: string, provider: string, mockScenario: string, extra?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const connection = await this.connections.get(orgId, provider);
    return { scenario: mockScenario, connection, ...(extra ?? {}) };
  }

  /** Verify a provider's connection by pulling a small, capped snapshot (no writes). */
  async test(orgId: string): Promise<{ ok: boolean; provider: string; message: string; employees?: number; departments?: number; sample?: string[] }> {
    const cfg = await this.config.get(orgId);
    const provider = this.registry.get(cfg.provider);
    try {
      const opts = await this.snapshotOptions(orgId, cfg.provider, cfg.mockScenario, { limit: 25 });
      const snap = await provider.getSnapshot(orgId, opts);
      return {
        ok: true, provider: provider.name,
        message: `Connected — read ${snap.employees.length} employee record(s) and ${snap.departments.length} department(s).`,
        employees: snap.employees.length, departments: snap.departments.length,
        sample: snap.employees.slice(0, 5).map((e) => `${e.employeeCode} · ${e.fullName}`),
      };
    } catch (e) {
      return { ok: false, provider: provider.name, message: (e as Error).message };
    }
  }

  /** Convert an HR snapshot into the importer's normalized dataset (names/codes). */
  private toDataset(snapshot: HrSnapshot): ImportDataset {
    const campusName = new Map(snapshot.campuses.map((c) => [c.externalId, c.name]));
    const deptName = new Map(snapshot.departments.map((d) => [d.externalId, d.name]));
    const desigName = new Map(snapshot.designations.map((d) => [d.externalId, d.name]));
    const empCode = new Map(snapshot.employees.map((e) => [e.externalId, e.employeeCode]));
    let r = 1;
    return {
      organization: snapshot.organization ? { name: snapshot.organization.name } : null,
      campuses: snapshot.campuses.map((c) => ({ name: c.name, _row: r++ })),
      departments: snapshot.departments.map((d) => ({
        name: d.name,
        parent: d.parentExternalId ? deptName.get(d.parentExternalId) : undefined,
        campus: d.campusExternalId ? campusName.get(d.campusExternalId) : undefined,
        unitType: d.unitType ?? undefined,
        _row: r++,
      })),
      designations: snapshot.designations.map((d) => ({
        name: d.name,
        level: d.level ?? undefined,
        promotesTo: d.promotesToExternalId ? desigName.get(d.promotesToExternalId) : undefined,
        _row: r++,
      })),
      employees: snapshot.employees.map((e) => ({
        employeeCode: e.employeeCode,
        fullName: e.fullName,
        email: e.email,
        department: e.departmentExternalId ? deptName.get(e.departmentExternalId) : undefined,
        designation: e.designationExternalId ? desigName.get(e.designationExternalId) : undefined,
        campus: e.campusExternalId ? campusName.get(e.campusExternalId) : undefined,
        managerCode: e.managerExternalId ? empCode.get(e.managerExternalId) : undefined,
        status: e.status ?? undefined,
        joinDate: e.joinDate ?? undefined,
        _row: r++,
      })),
      competencies: [], // competencies are not sourced from HR
    };
  }

  /** Employees currently mapped from HR whose external id is absent from the feed. */
  private async computeDeactivations(orgId: string, feedExternalIds: Set<string>): Promise<{ employeeId: string; userId: string; employeeCode: string; name: string | null; mapId: string }[]> {
    const maps = await this.prisma.externalIdentityMap.findMany({
      where: { organizationId: orgId, externalType: HR_EXTERNAL_TYPE, active: true },
      select: { id: true, externalId: true, employee: { select: { id: true, employeeCode: true, userId: true, deletedAt: true, status: true, user: { select: { fullName: true, email: true } } } } },
    });
    return maps
      .filter((m) => !feedExternalIds.has(m.externalId) && m.employee && m.employee.deletedAt === null && m.employee.status !== 'inactive')
      .map((m) => ({ employeeId: m.employee!.id, userId: m.employee!.userId, employeeCode: m.employee!.employeeCode, name: m.employee!.user?.fullName ?? m.employee!.user?.email ?? null, mapId: m.id }));
  }

  /** Dry-run: compute the diff without writing anything. */
  async preview(orgId: string, actor: { userId: string | null; name: string | null }, trigger: 'manual' | 'scheduled' = 'manual'): Promise<SyncResult> {
    const cfg = await this.config.get(orgId);
    const provider = this.registry.get(cfg.provider);
    const snapshot = await provider.getSnapshot(orgId, await this.snapshotOptions(orgId, cfg.provider, cfg.mockScenario));
    const dataset = this.toDataset(snapshot);
    const existing = await this.resolver.loadExisting(orgId);
    const result = this.validation.build(dataset, existing, 'update');
    const feedIds = new Set(snapshot.employees.map((e) => e.externalId));
    const deactivate = await this.computeDeactivations(orgId, feedIds);
    const totals = (entity: 'toCreate' | 'toUpdate' | 'toSkip') => result.counts.reduce((s, c) => s + c[entity], 0);
    // employees with no HR mapping and not in the feed → left untouched (informational).
    const feedCodes = new Set(snapshot.employees.map((e) => e.employeeCode.trim()));
    const internalOnly = [...existing.employeesByCode.keys()].filter((code) => !feedCodes.has(code) && !deactivate.some((d) => d.employeeCode === code)).length;

    const res: SyncResult = {
      mode: 'dry_run', provider: provider.name, canSync: result.canImport,
      counts: { created: totals('toCreate'), updated: totals('toUpdate'), deactivated: deactivate.length, skipped: totals('toSkip'), failed: 0 },
      perEntity: result.counts, deactivate: deactivate.map((d) => ({ employeeCode: d.employeeCode, name: d.name })), internalOnly,
      errors: result.errors, warnings: result.warnings,
    };
    const run = await this.record(orgId, actor, provider.name, 'dry_run', trigger, res, result.canImport ? 'completed' : 'failed');
    res.runId = run;
    return res;
  }

  /** Live sync: reconcile the snapshot into the internal model, then map + deactivate. */
  async sync(orgId: string, actor: { userId: string | null; name: string | null }, trigger: 'manual' | 'scheduled' = 'manual'): Promise<SyncResult> {
    const cfg = await this.config.get(orgId);
    if (cfg.mode !== 'external_hr') throw new BadRequestException('This organization is in Internal mode. Switch the data source to External HR before syncing.');
    const provider = this.registry.get(cfg.provider);
    const snapshot = await provider.getSnapshot(orgId, await this.snapshotOptions(orgId, cfg.provider, cfg.mockScenario));
    const dataset = this.toDataset(snapshot);
    const existing = await this.resolver.loadExisting(orgId);
    const check = this.validation.build(dataset, existing, 'update');
    if (!check.canImport) {
      const res: SyncResult = {
        mode: 'live', provider: provider.name, canSync: false,
        counts: { created: 0, updated: 0, deactivated: 0, skipped: 0, failed: 0 },
        perEntity: check.counts, deactivate: [], internalOnly: 0, errors: check.errors, warnings: check.warnings,
      };
      await this.record(orgId, actor, provider.name, 'live', trigger, res, 'failed');
      throw new BadRequestException('The HR data has validation errors and was not applied. Run a Dry Run to see the details.');
    }

    // 0) Blast-radius guard (F-C9) — evaluated BEFORE anything is written.
    //
    // Deactivation sets the employee inactive, disables their login and revokes
    // their sessions. A truncated or empty feed — a provider that silently returns
    // only page 1, a vendor outage returning an empty 200, a mis-scoped export —
    // would therefore lock out most or all of the workforce, unattended, on the
    // hourly cron. Nothing previously bounded this. Abort and let an administrator
    // review a dry run instead.
    const feedIds = new Set(snapshot.employees.map((e) => e.externalId));
    const deactivate = await this.computeDeactivations(orgId, feedIds);
    const activeEmployees = await this.prisma.employee.count({
      where: { organizationId: orgId, deletedAt: null, status: 'active' },
    });
    const allowedDeactivations = Math.max(
      MIN_DEACTIVATION_ALLOWANCE,
      Math.floor((activeEmployees * MAX_DEACTIVATION_PERCENT) / 100),
    );
    if (activeEmployees > 0 && snapshot.employees.length === 0) {
      await this.abortSync(orgId, actor, provider.name, trigger, check, deactivate,
        'The HR feed returned no employees, so the sync was aborted before anyone was deactivated.');
    }
    if (deactivate.length > allowedDeactivations) {
      await this.abortSync(orgId, actor, provider.name, trigger, check, deactivate,
        `Sync aborted: this would deactivate ${deactivate.length} of ${activeEmployees} active employees ` +
        `(limit ${allowedDeactivations}). This usually means the HR feed was incomplete. ` +
        'Run a Dry Run to review the change, and re-run only if it is correct.');
    }

    // 1) Reconcile org structure + employees (create/update) via the shared engine.
    const summary = await this.importer.run(orgId, actor.userId, dataset, { mode: 'update' });

    // 2) Refresh the external→internal identity map for every employee in the feed.
    const codeToId = new Map(
      (await this.prisma.employee.findMany({ where: { organizationId: orgId, employeeCode: { in: snapshot.employees.map((e) => e.employeeCode) } }, select: { id: true, employeeCode: true } }))
        .map((e) => [e.employeeCode, e.id]),
    );
    for (const e of snapshot.employees) {
      const empId = codeToId.get(e.employeeCode);
      if (!empId) continue;
      await this.prisma.externalIdentityMap.upsert({
        where: { identity_scope: { organizationId: orgId, externalType: HR_EXTERNAL_TYPE, externalId: e.externalId } },
        update: { externalCode: e.employeeCode, employeeId: empId, active: true },
        create: { organizationId: orgId, externalType: HR_EXTERNAL_TYPE, externalId: e.externalId, externalCode: e.employeeCode, matchKey: 'employee_code', employeeId: empId, active: true, createdBy: actor.userId },
      });
    }

    // 3) Deactivate employees removed from HR (NEVER delete — feedback stays intact).
    // `deactivate` was computed and bounds-checked in step 0 above (F-C9).
    for (const d of deactivate) {
      await this.prisma.$transaction([
        this.prisma.employee.update({ where: { id: d.employeeId }, data: { status: 'inactive', updatedBy: actor.userId } }),
        this.prisma.user.update({ where: { id: d.userId }, data: { status: 'disabled' } }),
        this.prisma.refreshToken.updateMany({ where: { userId: d.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
        this.prisma.externalIdentityMap.update({ where: { id: d.mapId }, data: { active: false } }),
      ]);
    }

    const emp = summary.perEntity.find((s) => s.entity === 'employees');
    const created = summary.perEntity.reduce((s, e) => s + e.created, 0);
    const updated = summary.perEntity.reduce((s, e) => s + e.updated, 0);
    const failed = summary.perEntity.reduce((s, e) => s + e.failed, 0);
    const verify = await this.verify(orgId);

    const res: SyncResult = {
      mode: 'live', provider: provider.name, canSync: true,
      counts: { created, updated, deactivated: deactivate.length, skipped: emp?.skipped ?? 0, failed },
      perEntity: summary.perEntity, deactivate: deactivate.map((d) => ({ employeeCode: d.employeeCode, name: d.name })), internalOnly: 0,
      errors: [], warnings: check.warnings, verify,
    };
    const runId = await this.record(orgId, actor, provider.name, 'live', trigger, res, 'completed');
    res.runId = runId;
    await this.config.patch(orgId, { lastSyncAt: new Date().toISOString() });
    // Generic audit log requires a user; scheduled (system) runs are captured by the HrSyncRun row instead.
    if (actor.userId) {
      await this.audit.record({ organizationId: orgId, userId: actor.userId, action: 'organization.hr.sync', entityType: 'hr_sync', entityId: runId, newValue: res.counts });
    }
    return res;
  }

  private async verify(orgId: string): Promise<Record<string, number>> {
    const [employees, active, withManager, mapped] = await Promise.all([
      this.prisma.employee.count({ where: { organizationId: orgId, deletedAt: null } }),
      this.prisma.employee.count({ where: { organizationId: orgId, deletedAt: null, status: 'active' } }),
      this.prisma.employee.count({ where: { organizationId: orgId, deletedAt: null, lineManagerId: { not: null } } }),
      this.prisma.externalIdentityMap.count({ where: { organizationId: orgId, externalType: HR_EXTERNAL_TYPE, active: true } }),
    ]);
    return { employees, active, withManager, hrMapped: mapped };
  }

  /**
   * Record an aborted sync and stop (F-C9). Nothing has been written at this point,
   * so the run is logged as 'aborted' with the deactivation list that WOULD have been
   * applied — giving the administrator the evidence they need in the run history.
   */
  private async abortSync(
    orgId: string,
    actor: { userId: string | null; name: string | null },
    provider: string,
    trigger: 'manual' | 'scheduled',
    check: { counts: unknown[]; errors: unknown[]; warnings: unknown[] },
    deactivate: { employeeCode: string; name: string | null }[],
    message: string,
  ): Promise<never> {
    const res: SyncResult = {
      mode: 'live',
      provider,
      canSync: false,
      counts: { created: 0, updated: 0, deactivated: 0, skipped: 0, failed: 0 },
      perEntity: check.counts,
      deactivate: deactivate.map((d) => ({ employeeCode: d.employeeCode, name: d.name })),
      internalOnly: 0,
      errors: [...(check.errors as never[]), { entity: 'employees', row: 0, field: null, key: null, severity: 'error', message } as never],
      warnings: check.warnings as never[],
    };
    await this.record(orgId, actor, provider, 'live', trigger, res, 'aborted');
    this.logger.error(`HR sync aborted for org ${orgId}: ${message}`);
    throw new BadRequestException(message);
  }

  private async record(orgId: string, actor: { userId: string | null; name: string | null }, provider: string, mode: 'dry_run' | 'live', trigger: 'manual' | 'scheduled', res: SyncResult, status: string): Promise<string> {
    const run = await this.prisma.hrSyncRun.create({
      data: {
        organizationId: orgId, provider, mode, trigger, status,
        createdBy: actor.userId, createdByName: actor.name,
        created: res.counts.created, updated: res.counts.updated, deactivated: res.counts.deactivated, failed: res.counts.failed,
        warnings: res.warnings.length,
        summary: { counts: res.counts, perEntity: res.perEntity, deactivate: res.deactivate, internalOnly: res.internalOnly, errors: res.errors, warnings: res.warnings, verify: res.verify } as unknown as Prisma.InputJsonValue,
        finishedAt: new Date(),
      },
    });
    return run.id;
  }

  /* -------------------------------- Read side -------------------------------- */

  async status(orgId: string): Promise<Record<string, unknown>> {
    const cfg = await this.config.get(orgId);
    const last = await this.prisma.hrSyncRun.findFirst({ where: { organizationId: orgId, mode: 'live' }, orderBy: { startedAt: 'desc' } });
    const nextSyncAt = cfg.mode === 'external_hr' && cfg.autoSync
      ? new Date((cfg.lastSyncAt ? new Date(cfg.lastSyncAt).getTime() : Date.now()) + cfg.intervalHours * 3600_000).toISOString()
      : null;
    return {
      mode: cfg.mode, provider: cfg.provider, providers: this.registry.available(),
      autoSync: cfg.autoSync, intervalHours: cfg.intervalHours, mockScenario: cfg.mockScenario,
      lastSyncAt: cfg.lastSyncAt, nextSyncAt,
      lastRun: last ? { id: last.id, status: last.status, created: last.created, updated: last.updated, deactivated: last.deactivated, failed: last.failed, warnings: last.warnings, at: last.startedAt } : null,
    };
  }

  async history(orgId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.hrSyncRun.findMany({ where: { organizationId: orgId }, orderBy: { startedAt: 'desc' }, take: 50 });
    return rows.map((r) => ({ id: r.id, mode: r.mode, trigger: r.trigger, status: r.status, provider: r.provider, by: r.createdByName, created: r.created, updated: r.updated, deactivated: r.deactivated, failed: r.failed, warnings: r.warnings, at: r.startedAt }));
  }

  async reportCsv(orgId: string, runId: string): Promise<string> {
    const run = await this.prisma.hrSyncRun.findFirst({ where: { id: runId, organizationId: orgId } });
    if (!run) return 'Severity,Entity,Row,Field,Key,Message\n';
    const s = (run.summary ?? {}) as { errors?: unknown[]; warnings?: unknown[]; deactivate?: { employeeCode: string; name: string | null }[] };
    const esc = (v: unknown) => { const str = v == null ? '' : String(v); return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str; };
    const lines = ['Severity,Entity,Row,Field,Key,Message'];
    for (const e of (s.errors ?? []) as Array<Record<string, unknown>>) lines.push(['error', e.entity, e.row, e.field, e.key, e.message].map(esc).join(','));
    for (const w of (s.warnings ?? []) as Array<Record<string, unknown>>) lines.push(['warning', w.entity, w.row, w.field, w.key, w.message].map(esc).join(','));
    for (const d of s.deactivate ?? []) lines.push(['deactivated', 'employees', '', '', d.employeeCode, `Removed from HR — deactivated: ${d.name ?? d.employeeCode}`].map(esc).join(','));
    return lines.join('\n');
  }

  /* ------------------------------- Scheduler -------------------------------- */

  /** Hourly tick: run a live sync for external-mode orgs whose interval has elapsed. */
  @Cron(CronExpression.EVERY_HOUR)
  async runScheduled(): Promise<void> {
    let orgs: { organizationId: string }[];
    try {
      orgs = await this.prisma.configuration.findMany({ where: { module: 'hr_integration', key: 'settings', deletedAt: null }, select: { organizationId: true } });
    } catch (e) { this.logger.warn(`HR scheduled sync lookup failed: ${(e as Error).message}`); return; }
    for (const { organizationId } of orgs) {
      try {
        const cfg = await this.config.get(organizationId);
        if (cfg.mode !== 'external_hr' || !cfg.autoSync) continue;
        const due = !cfg.lastSyncAt || Date.now() - new Date(cfg.lastSyncAt).getTime() >= cfg.intervalHours * 3600_000;
        if (!due) continue;
        const res = await this.sync(organizationId, { userId: null, name: 'System (scheduler)' }, 'scheduled');
        this.logger.log(`HR auto-sync for ${organizationId}: +${res.counts.created} ~${res.counts.updated} -${res.counts.deactivated}`);
      } catch (e) { this.logger.warn(`HR auto-sync failed for ${organizationId}: ${(e as Error).message}`); }
    }
  }
}
