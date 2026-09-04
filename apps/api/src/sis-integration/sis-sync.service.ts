import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import type { SisRef, SisStudent, SisTeacher } from '../sis/sis.types';
import { SisConfigService } from './sis-config.service';
import { SisConnectionService } from './sis-connection.service';
import { SisDatasetService } from './sis-dataset.service';
import { SisProviderRegistry } from './sis-provider.registry';
import { SisParseService, type SisParseInput } from './providers/sis-parse.service';
import { buildSnapshot, validateRows, type SisValidationIssue } from './providers/snapshot-builder';
import { emptySnapshot, type SisSnapshot } from './sis-snapshot.types';

const TEACHER_EXTERNAL_TYPE = 'teacher';

export interface SisApplyResult {
  mode: 'dry_run' | 'live';
  provider: string;
  ok: boolean;
  counts: { created: number; updated: number; deactivated: number; autoMapped: number; protected: number };
  entityCounts: { students: number; guardians: number; teachers: number; teachingAssignments: number; enrollments: number };
  deactivate: { code: string; name: string | null }[];
  /** Renames the feed would make to existing students — the change people notice most. */
  rename: { code: string; from: string; to: string }[];
  /** Locally added or locally corrected records the feed was NOT allowed to touch. */
  preserved: { code: string; name: string | null; reason: 'manual' | 'edited'; fields?: string[] }[];
  /**
   * Teacher → 360 employee mappings this run would point at a DIFFERENT employee,
   * because the feed gave an already-mapped teacher another `employee_code`.
   *
   * Feedback already collected is unaffected — every evaluation link stores the
   * `employee_id` it resolved at generation — but from here on, parent feedback for
   * that teacher would score somebody else. That is significant enough to confirm.
   */
  repoint: { code: string; name: string | null; from: string; to: string }[];
  /** True when this run would deactivate, rename, or re-point. A live run needs `confirm`. */
  significant: boolean;
  /** Set when a live run was withheld because `significant` and `confirm` was not sent. */
  requiresConfirmation?: boolean;
  errors: SisValidationIssue[];
  warnings: SisValidationIssue[];
  verify?: Record<string, number>;
  runId?: string;
}

/** A roster record with no `origin` predates local maintenance and came from an import. */
function isManual(row: { origin?: string }): boolean { return row.origin === 'manual'; }

/**
 * Re-apply an incoming record over the stored one while preserving fields an
 * administrator corrected by hand (`localEdits`). This is what makes a local
 * correction survive the next sync instead of being silently undone.
 */
function mergePreservingLocalEdits<T extends Record<string, unknown>>(existing: T, incoming: T): { row: T; kept: string[] } {
  const kept = (existing.localEdits as string[] | undefined) ?? [];
  const row = { ...incoming } as Record<string, unknown>;
  for (const f of kept) row[f] = existing[f];
  if (kept.length > 0) {
    row.localEdits = kept;
    row.updatedLocallyAt = existing.updatedLocallyAt ?? null;
    row.updatedLocallyBy = existing.updatedLocallyBy ?? null;
  }
  row.origin = existing.origin ?? 'sis';
  return { row: row as T, kept };
}

function dedupBy<T>(rows: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>(); const out: T[] = [];
  for (const r of rows) { const k = key(r); if (!seen.has(k)) { seen.add(k); out.push(r); } }
  return out;
}
function refList(names: (string | undefined)[]): SisRef[] {
  return [...new Set(names.filter((n): n is string => !!n && n.trim() !== ''))].map((n) => ({ id: n, code: n, name: n }));
}

@Injectable()
export class SisSyncService {
  private readonly logger = new Logger(SisSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: SisConfigService,
    private readonly connections: SisConnectionService,
    private readonly registry: SisProviderRegistry,
    private readonly dataset: SisDatasetService,
    private readonly parser: SisParseService,
  ) {}

  /**
   * Merge an incoming roster into the existing dataset. Students/teachers absent from
   * the feed are DEACTIVATED and RETAINED (never dropped) so historical parent
   * feedback keeps resolving; a carried-over student's guardians/enrollments are kept
   * too. Incoming rows win on conflict.
   */
  private reconcile(existing: SisSnapshot | null, incoming: SisSnapshot): { merged: SisSnapshot; counts: SisApplyResult['counts']; deactivate: { code: string; name: string | null }[]; rename: SisApplyResult['rename']; preserved: SisApplyResult['preserved'] } {
    const ex = existing ?? emptySnapshot();
    const inStudentIds = new Set(incoming.students.map((s) => s.id));
    const inTeacherIds = new Set(incoming.teachers.map((t) => t.id));
    const exStudentById = new Map(ex.students.map((s) => [s.id, s]));
    const exTeacherById = new Map(ex.teachers.map((t) => [t.id, t]));

    let created = 0, updated = 0, deactivated = 0, guarded = 0;
    const deactivate: { code: string; name: string | null }[] = [];
    const rename: { code: string; from: string; to: string }[] = [];
    const preserved: SisApplyResult['preserved'] = [];

    for (const s of incoming.students) {
      const prev = exStudentById.get(s.id);
      if (!prev) { created++; continue; }
      updated++;
      if (prev.name && s.name && prev.name !== s.name) rename.push({ code: prev.registrationNo || prev.id, from: prev.name, to: s.name });
    }
    for (const t of incoming.teachers) (exTeacherById.has(t.id) ? updated++ : created++);

    // A manually added record is invisible to the external system, so an incoming
    // feed that lacks it means nothing. Take it out of the deactivate-missing
    // calculation entirely rather than deactivating it every single sync.
    const manualStudentIds = new Set(ex.students.filter(isManual).map((s) => s.id));
    const manualTeacherIds = new Set(ex.teachers.filter(isManual).map((t) => t.id));

    // Deactivate-missing is scoped to entity types actually present in this feed
    // (DEF-04): a single-entity upload (e.g. a students-only CSV) must NOT
    // deactivate teachers just because the file contained no teacher rows. A full
    // provider snapshot includes every type, so its behaviour is unchanged.
    const hasIncomingStudents = incoming.students.length > 0;
    const hasIncomingTeachers = incoming.teachers.length > 0;
    const carriedStudents: SisStudent[] = ex.students.filter((s) => !inStudentIds.has(s.id)).map((s) => {
      if (manualStudentIds.has(s.id)) {
        guarded++; preserved.push({ code: s.registrationNo || s.id, name: s.name, reason: 'manual' });
        return s; // added here, not in the SIS — its absence from the feed means nothing
      }
      if (hasIncomingStudents && s.status !== 'inactive') {
        deactivated++; deactivate.push({ code: s.registrationNo || s.id, name: s.name });
        return { ...s, status: 'inactive' };
      }
      return s; // no students in this upload → carry forward unchanged
    });
    const carriedTeachers: SisTeacher[] = ex.teachers.filter((t) => !inTeacherIds.has(t.id)).map((t) => {
      if (manualTeacherIds.has(t.id)) {
        guarded++; preserved.push({ code: t.employeeCode || t.id, name: t.name, reason: 'manual' });
        return t;
      }
      if (hasIncomingTeachers && t.status !== 'inactive') {
        deactivated++; deactivate.push({ code: t.employeeCode || t.id, name: t.name });
        return { ...t, status: 'inactive' };
      }
      return t; // no teachers in this upload → carry forward unchanged
    });

    // Incoming rows still win, EXCEPT on fields an administrator corrected here.
    const mergedIncomingStudents: SisStudent[] = incoming.students.map((s) => {
      const prev = exStudentById.get(s.id);
      if (!prev) return s;
      const { row, kept } = mergePreservingLocalEdits(prev as unknown as Record<string, unknown>, s as unknown as Record<string, unknown>);
      if (kept.length > 0) { guarded++; preserved.push({ code: prev.registrationNo || prev.id, name: prev.name, reason: 'edited', fields: kept }); }
      return row as unknown as SisStudent;
    });
    const mergedIncomingTeachers: SisTeacher[] = incoming.teachers.map((t) => {
      const prev = exTeacherById.get(t.id);
      if (!prev) return t;
      const { row, kept } = mergePreservingLocalEdits(prev as unknown as Record<string, unknown>, t as unknown as Record<string, unknown>);
      if (kept.length > 0) { guarded++; preserved.push({ code: prev.employeeCode || prev.id, name: prev.name, reason: 'edited', fields: kept }); }
      return row as unknown as SisTeacher;
    });

    const students = [...mergedIncomingStudents, ...carriedStudents];
    const teachers = [...mergedIncomingTeachers, ...carriedTeachers];
    // Parents: the feed replaces the guardians of students it carries — except the
    // ones added or corrected here, which are kept and re-attached. Without this a
    // sync would wipe a phone number an administrator had just fixed.
    const exParentById = new Map(ex.parents.map((p) => [p.id, p]));
    const incomingParentIds = new Set(incoming.parents.map((p) => p.id));
    const localParents = ex.parents.filter((p) => inStudentIds.has(p.studentId) && !incomingParentIds.has(p.id) && isManual(p));
    for (const p of localParents) { guarded++; preserved.push({ code: p.id, name: p.name, reason: 'manual' }); }
    const mergedIncomingParents = incoming.parents.map((p) => {
      const prev = exParentById.get(p.id);
      if (!prev) return p;
      const { row, kept } = mergePreservingLocalEdits(prev as unknown as Record<string, unknown>, p as unknown as Record<string, unknown>);
      if (kept.length > 0) { guarded++; preserved.push({ code: prev.id, name: prev.name, reason: 'edited', fields: kept }); }
      return row as unknown as typeof p;
    });
    const parents = [...mergedIncomingParents, ...localParents, ...ex.parents.filter((p) => !inStudentIds.has(p.studentId))];
    let ei = 1;
    // Manually attached teachers survive a sync for the same reason a manual student
    // does: the external system never knew about them, so its silence is not a delete.
    const manualEnrollments = ex.enrollments.filter((e) => isManual(e) && inStudentIds.has(e.studentId));
    const enrollments = dedupBy(
      [...incoming.enrollments, ...manualEnrollments, ...ex.enrollments.filter((e) => !inStudentIds.has(e.studentId))],
      (e) => `${e.studentId}|${e.teachingAssignmentId}`,
    ).map((e) => ({ ...e, id: e.origin === 'manual' ? e.id : `enr-${ei++}` }));
    const teachingAssignments = dedupBy([...incoming.teachingAssignments, ...ex.teachingAssignments], (a) => a.id);
    const subjects = dedupBy([...incoming.subjects, ...ex.subjects], (s) => s.id);

    const merged: SisSnapshot = {
      students, teachers, parents, enrollments, teachingAssignments, subjects,
      campuses: refList([...students.map((s) => s.campus), ...teachingAssignments.map((a) => a.campus)]),
      faculties: refList([...students.map((s) => s.faculty), ...teachers.map((t) => t.faculty)]),
      departments: refList([...students.map((s) => s.department), ...teachers.map((t) => t.department)]),
      programs: refList(students.map((s) => s.program)),
      sessions: refList([...students.map((s) => s.session), ...teachingAssignments.map((a) => a.session)]),
      semesters: refList(students.map((s) => s.semester)),
      classes: refList(students.map((s) => s.currentClass)),
      sections: refList(students.map((s) => s.currentSection)),
    };
    return { merged, counts: { created, updated, deactivated, autoMapped: 0, protected: guarded }, deactivate, rename, preserved };
  }

  /** Auto-link SIS teachers to 360 employees by matching employee_code. Enables parent
   *  feedback with no manual mapping. Returns the number linked. */
  private async autoMapTeachers(orgId: string, snapshot: SisSnapshot, actorUserId: string | null): Promise<number> {
    const codes = snapshot.teachers.map((t) => t.employeeCode).filter((c): c is string => !!c);
    if (codes.length === 0) return 0;
    const emps = await this.prisma.employee.findMany({ where: { organizationId: orgId, employeeCode: { in: codes }, deletedAt: null }, select: { id: true, employeeCode: true } });
    const byCode = new Map(emps.map((e) => [e.employeeCode, e.id]));
    let mapped = 0;
    for (const t of snapshot.teachers) {
      const empId = t.employeeCode ? byCode.get(t.employeeCode) : undefined;
      if (!empId) continue;
      await this.prisma.externalIdentityMap.upsert({
        where: { identity_scope: { organizationId: orgId, externalType: TEACHER_EXTERNAL_TYPE, externalId: t.id } },
        update: { externalCode: t.employeeCode, employeeId: empId, active: t.status === 'active' },
        create: { organizationId: orgId, externalType: TEACHER_EXTERNAL_TYPE, externalId: t.id, externalCode: t.employeeCode ?? null, matchKey: 'employee_code', employeeId: empId, active: t.status === 'active', createdBy: actorUserId },
      });
      mapped++;
    }
    return mapped;
  }

  /**
   * Which teacher→employee mappings `autoMapTeachers` WOULD move to a different
   * employee. Read-only: this runs before the confirmation gate so the preview can
   * itemise the change, and it writes nothing.
   *
   * Only an existing mapping that resolves to a DIFFERENT employee counts. A first
   * mapping is not a re-point, and a teacher whose `employee_code` matches no employee
   * is skipped here exactly as `autoMapTeachers` skips it.
   */
  private async teacherRepoints(orgId: string, snapshot: SisSnapshot): Promise<SisApplyResult['repoint']> {
    const teachers = snapshot.teachers.filter((t) => !!t.employeeCode);
    if (teachers.length === 0) return [];

    const emps = await this.prisma.employee.findMany({
      where: { organizationId: orgId, employeeCode: { in: teachers.map((t) => t.employeeCode) }, deletedAt: null },
      select: { id: true, employeeCode: true },
    });
    const targetByCode = new Map(emps.map((e) => [e.employeeCode, e.id]));

    const existing = await this.prisma.externalIdentityMap.findMany({
      where: { organizationId: orgId, externalType: TEACHER_EXTERNAL_TYPE, externalId: { in: teachers.map((t) => t.id) } },
      select: { externalId: true, employeeId: true },
    });
    const mappedTo = new Map(existing.map((m) => [m.externalId, m.employeeId]));

    const moving: { teacher: SisTeacher; from: string; to: string }[] = [];
    for (const t of teachers) {
      const to = targetByCode.get(t.employeeCode);
      const from = mappedTo.get(t.id);
      if (!to || !from || from === to) continue;
      moving.push({ teacher: t, from, to });
    }
    if (moving.length === 0) return [];

    // Report employee CODES, not UUIDs — an administrator cannot act on a UUID.
    const ids = [...new Set(moving.flatMap((m) => [m.from, m.to]))];
    const named = await this.prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, employeeCode: true } });
    const codeById = new Map(named.map((e) => [e.id, e.employeeCode]));
    return moving.map((m) => ({
      code: m.teacher.employeeCode || m.teacher.id,
      name: m.teacher.name,
      from: codeById.get(m.from) ?? m.from,
      to: codeById.get(m.to) ?? m.to,
    }));
  }

  /** Pull a snapshot from a live provider (mock/generic/oneroster). */
  private async snapshotFromProvider(orgId: string, provider: string, mockScenario: string): Promise<SisSnapshot> {
    const p = this.registry.get(provider);
    if (!p) throw new BadRequestException(`Provider "${provider}" does not support live sync. Use the Excel/CSV import instead.`);
    const connection = await this.connections.get(orgId, provider);
    return p.getSnapshot(orgId, { scenario: mockScenario, connection });
  }

  private async verify(orgId: string): Promise<Record<string, number>> {
    const snap = (await this.dataset.get(orgId)) ?? emptySnapshot();
    const mapped = await this.prisma.externalIdentityMap.count({ where: { organizationId: orgId, externalType: TEACHER_EXTERNAL_TYPE, active: true } });
    return {
      students: snap.students.length,
      activeStudents: snap.students.filter((s) => s.status === 'active').length,
      guardians: snap.parents.length,
      teachers: snap.teachers.length,
      teachersMappedToEmployees: mapped,
      teachingAssignments: snap.teachingAssignments.length,
      enrollments: snap.enrollments.length,
    };
  }

  private async record(orgId: string, actor: { userId: string | null; name: string | null }, provider: string, mode: 'dry_run' | 'live', trigger: 'manual' | 'scheduled', res: SisApplyResult, status: string): Promise<string> {
    const run = await this.prisma.sisSyncRun.create({
      data: {
        organizationId: orgId, provider, mode, trigger, status,
        createdBy: actor.userId, createdByName: actor.name,
        created: res.counts.created, updated: res.counts.updated, deactivated: res.counts.deactivated, failed: 0, warnings: res.warnings.length,
        summary: { counts: res.counts, entityCounts: res.entityCounts, deactivate: res.deactivate, rename: res.rename, repoint: res.repoint, errors: res.errors, warnings: res.warnings, verify: res.verify } as unknown as Prisma.InputJsonValue,
        finishedAt: new Date(),
      },
    });
    return run.id;
  }

  /** Shared apply path for both file-import and provider-sync. */
  private async apply(orgId: string, actor: { userId: string | null; name: string | null }, provider: string, incoming: SisSnapshot, opts: { dryRun: boolean; trigger?: 'manual' | 'scheduled'; confirm?: boolean; errors?: SisValidationIssue[]; warnings?: SisValidationIssue[] }): Promise<SisApplyResult> {
    const existing = await this.dataset.get(orgId);
    const { merged, counts, deactivate, rename, preserved } = this.reconcile(existing, incoming);
    // Computed BEFORE the gate so a re-point can be previewed and confirmed rather
    // than happening silently inside autoMapTeachers after the write.
    const repoint = await this.teacherRepoints(orgId, merged);
    const entityCounts = { students: incoming.students.length, guardians: incoming.parents.length, teachers: incoming.teachers.length, teachingAssignments: incoming.teachingAssignments.length, enrollments: incoming.enrollments.length };
    const res: SisApplyResult = {
      mode: opts.dryRun ? 'dry_run' : 'live', provider, ok: (opts.errors?.length ?? 0) === 0,
      counts, entityCounts, deactivate, rename, preserved, repoint,
      significant: deactivate.length > 0 || rename.length > 0 || repoint.length > 0,
      errors: opts.errors ?? [], warnings: opts.warnings ?? [],
    };
    if (opts.dryRun || !res.ok) {
      res.runId = await this.record(orgId, actor, provider, 'dry_run', opts.trigger ?? 'manual', res, res.ok ? 'completed' : 'failed');
      return res;
    }
    /*
     * The confirmation gate.
     *
     * A feed whose ids happen to overlap the stored roster can rename students and
     * deactivate everything it does not mention — the built-in sample roster
     * (S1001–S1004) against a seeded 120-student roster does exactly that. A
     * destructive run is now withheld and the preview returned instead, so the
     * administrator sees WHAT would change before it changes. A harmless sync — no
     * deactivations, no renames, no re-points — still applies in one step and asks
     * nothing.
     *
     * This gate serves BOTH entry points. The file-import path used to call `apply()`
     * without `confirm`, so `!opts.confirm` was permanently true and any significant
     * import returned the preview forever with no way to complete it.
     */
    if (res.significant && !opts.confirm) {
      res.mode = 'dry_run';
      res.requiresConfirmation = true;
      res.runId = await this.record(orgId, actor, provider, 'dry_run', opts.trigger ?? 'manual', res, 'completed');
      return res;
    }
    await this.dataset.save(orgId, provider, merged, actor.userId);
    res.counts.autoMapped = await this.autoMapTeachers(orgId, merged, actor.userId);
    res.verify = await this.verify(orgId);
    res.runId = await this.record(orgId, actor, provider, 'live', opts.trigger ?? 'manual', res, 'completed');
    await this.config.patch(orgId, { lastSyncAt: new Date().toISOString() });
    if (actor.userId) {
      await this.audit.record({ organizationId: orgId, userId: actor.userId, action: 'organization.sis.sync', entityType: 'sis_sync', entityId: res.runId!, newValue: { provider, counts: res.counts } });
    }
    return res;
  }

  /* ------------------------------ Excel/CSV import ------------------------------ */

  async importFile(orgId: string, actor: { userId: string | null; name: string | null }, input: SisParseInput, dryRun: boolean, confirm = false): Promise<SisApplyResult> {
    const rows = await this.parser.parseAsync(input);
    const validation = validateRows(rows);
    const provider = (await this.config.get(orgId)).provider === 'mock' ? 'csv' : (await this.config.get(orgId)).provider;
    const incoming = buildSnapshot(rows);
    return this.apply(orgId, actor, ['internal', 'csv'].includes(provider) ? provider : 'csv', incoming, { dryRun, confirm, errors: validation.errors, warnings: validation.warnings });
  }

  /* ------------------------------ Provider sync ------------------------------ */

  async sync(orgId: string, actor: { userId: string | null; name: string | null }, dryRun: boolean, trigger: 'manual' | 'scheduled' = 'manual', confirm = false): Promise<SisApplyResult> {
    const cfg = await this.config.get(orgId);
    const incoming = await this.snapshotFromProvider(orgId, cfg.provider, cfg.mockScenario);
    // A SCHEDULED sync never carries a confirmation, so a destructive automatic run
    // stops at the preview and waits for a person. That is the safe default.
    return this.apply(orgId, actor, cfg.provider, incoming, { dryRun, trigger, confirm });
  }

  /** Test a live provider connection with a capped read (no writes). */
  async test(orgId: string): Promise<{ ok: boolean; provider: string; message: string; students?: number; teachers?: number }> {
    const cfg = await this.config.get(orgId);
    try {
      const snap = await this.snapshotFromProvider(orgId, cfg.provider, cfg.mockScenario);
      return { ok: true, provider: cfg.provider, message: `Connected — read ${snap.students.length} student(s) and ${snap.teachers.length} teacher(s).`, students: snap.students.length, teachers: snap.teachers.length };
    } catch (e) {
      return { ok: false, provider: cfg.provider, message: (e as Error).message };
    }
  }

  /* --------------------------------- Read side --------------------------------- */

  async status(orgId: string): Promise<Record<string, unknown>> {
    const cfg = await this.config.get(orgId);
    const meta = await this.dataset.meta(orgId);
    const last = await this.prisma.sisSyncRun.findFirst({ where: { organizationId: orgId, mode: 'live' }, orderBy: { startedAt: 'desc' } });
    const nextSyncAt = cfg.autoSync && cfg.lastSyncAt ? new Date(new Date(cfg.lastSyncAt).getTime() + cfg.intervalHours * 3600_000).toISOString() : null;
    return {
      provider: cfg.provider, providers: this.registry.available(), autoSync: cfg.autoSync, intervalHours: cfg.intervalHours,
      mockScenario: cfg.mockScenario, lastSyncAt: cfg.lastSyncAt, nextSyncAt,
      dataset: meta ? { provider: meta.provider, students: meta.studentCount, teachers: meta.teacherCount, updatedAt: meta.updatedAt } : null,
      lastRun: last ? { id: last.id, status: last.status, created: last.created, updated: last.updated, deactivated: last.deactivated, warnings: last.warnings, at: last.startedAt } : null,
    };
  }

  async history(orgId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.sisSyncRun.findMany({ where: { organizationId: orgId }, orderBy: { startedAt: 'desc' }, take: 50 });
    return rows.map((r) => ({ id: r.id, mode: r.mode, trigger: r.trigger, status: r.status, provider: r.provider, by: r.createdByName, created: r.created, updated: r.updated, deactivated: r.deactivated, warnings: r.warnings, at: r.startedAt }));
  }

  async reportCsv(orgId: string, runId: string): Promise<string> {
    const run = await this.prisma.sisSyncRun.findFirst({ where: { id: runId, organizationId: orgId } });
    if (!run) return 'Severity,Entity,Row,Field,Key,Message\n';
    const s = (run.summary ?? {}) as {
      errors?: SisValidationIssue[];
      warnings?: SisValidationIssue[];
      deactivate?: { code: string; name: string | null }[];
      rename?: { code: string; from: string; to: string }[];
      repoint?: { code: string; name: string | null; from: string; to: string }[];
    };
    const esc = (v: unknown) => { const str = v == null ? '' : String(v); return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str; };
    const lines = ['Severity,Entity,Row,Field,Key,Message'];
    for (const e of s.errors ?? []) lines.push(['error', e.entity, e.row, e.field, e.key, e.message].map(esc).join(','));
    for (const w of s.warnings ?? []) lines.push(['warning', w.entity, w.row, w.field, w.key, w.message].map(esc).join(','));
    for (const d of s.deactivate ?? []) lines.push(['deactivated', '', '', '', d.code, `No longer in SIS — deactivated: ${d.name ?? d.code}`].map(esc).join(','));
    for (const r of s.rename ?? []) lines.push(['renamed', 'students', '', 'name', r.code, `Renamed: ${r.from} → ${r.to}`].map(esc).join(','));
    // Older runs have no `repoint` in their summary; `?? []` keeps their reports valid.
    for (const r of s.repoint ?? []) lines.push(['repointed', 'teachers', '', 'employee_code', r.code, `Teacher ${r.name ?? r.code} re-pointed from employee ${r.from} to ${r.to} — future parent feedback scores the new employee.`].map(esc).join(','));
    return lines.join('\n');
  }

  /* -------------------------------- Scheduler -------------------------------- */

  @Cron(CronExpression.EVERY_HOUR)
  async runScheduled(): Promise<void> {
    let orgs: { organizationId: string }[];
    try { orgs = await this.prisma.configuration.findMany({ where: { module: 'sis_integration', key: 'settings', deletedAt: null }, select: { organizationId: true } }); }
    catch (e) { this.logger.warn(`SIS scheduled sync lookup failed: ${(e as Error).message}`); return; }
    for (const { organizationId } of orgs) {
      try {
        const cfg = await this.config.get(organizationId);
        if (!cfg.autoSync || !this.registry.get(cfg.provider)) continue;
        const due = !cfg.lastSyncAt || Date.now() - new Date(cfg.lastSyncAt).getTime() >= cfg.intervalHours * 3600_000;
        if (!due) continue;
        const res = await this.sync(organizationId, { userId: null, name: 'System (scheduler)' }, false, 'scheduled');
        this.logger.log(`SIS auto-sync for ${organizationId}: +${res.counts.created} ~${res.counts.updated} -${res.counts.deactivated}`);
      } catch (e) { this.logger.warn(`SIS auto-sync failed for ${organizationId}: ${(e as Error).message}`); }
    }
  }
}
