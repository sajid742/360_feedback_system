import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../common/prisma/prisma.service';
import type {
  SisEnrollment, SisParent, SisStudent, SisTeacher, SisTeacherOfStudent, SisTeachingAssignment,
} from '../sis/sis.types';
import { SisDatasetService } from './sis-dataset.service';
import { emptySnapshot, type SisSnapshot, type SisSnapshotEnrollment } from './sis-snapshot.types';

/**
 * Roster maintenance — browse and correct the imported SIS data from inside the
 * application.
 *
 * WHY IT LIVES HERE AND NOT IN A NEW MODULE: the roster is already one JSON
 * document per organization (`sis_datasets.snapshot`), already written by the
 * import/sync engine through `SisDatasetService`, and already read by
 * `StoredSisProvider` to serve the `SisProvider` interface that parent feedback,
 * bulk generation and teacher mapping consume. Editing is therefore a *write*
 * against that same document. No new table, no second model, and every consumer
 * picks up an edit on its next request with no change of its own.
 *
 * PROVENANCE (see `SisLocalMeta`): a record an administrator creates is marked
 * `origin: 'manual'`; a field an administrator corrects on an imported record is
 * recorded in `localEdits`. `SisSyncService.reconcile()` reads both, so a
 * correction is not silently undone by the next sync.
 */

/** Fields of a student an administrator may correct. Anything else is derived. */
const STUDENT_FIELDS = [
  'name', 'registrationNo', 'rollNo', 'gender', 'status', 'campus', 'currentClass', 'currentSection',
  'program', 'faculty', 'department', 'session', 'semester', 'dateOfBirth', 'admissionDate',
] as const;

const PARENT_FIELDS = ['name', 'relationship', 'mobile', 'whatsapp', 'email', 'preferredLanguage', 'active'] as const;

export interface StudentListQuery {
  search?: string;
  status?: string;
  campus?: string;
  origin?: 'sis' | 'manual';
  page?: number;
  pageSize?: number;
}

export interface StudentListResult {
  items: (SisStudent & { guardianCount: number; teacherCount: number })[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface StudentDetail {
  student: SisStudent;
  parents: SisParent[];
  teachers: SisTeacherOfStudent[];
  enrollments: SisEnrollment[];
}

type Actor = { userId: string | null; name: string | null };

function clean(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

/** A record with no `origin` predates this feature and came from an import. */
function originOf(row: { origin?: string }): 'sis' | 'manual' {
  return row.origin === 'manual' ? 'manual' : 'sis';
}

@Injectable()
export class SisMaintenanceService {
  constructor(
    private readonly datasets: SisDatasetService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /* ------------------------------------------------------------------ read */

  private async snapshot(orgId: string): Promise<SisSnapshot> {
    return (await this.datasets.get(orgId)) ?? emptySnapshot();
  }

  /**
   * Paginated, searchable student list.
   *
   * This exists because the SIS browse endpoint returns a plain array with only
   * `limit`/`offset` and no total, which is what let the Parent Evaluations
   * picker silently show 50 of 120 students. Here the caller always learns the
   * real total, so a truncated page is visible rather than invisible.
   */
  async listStudents(orgId: string, q: StudentListQuery): Promise<StudentListResult> {
    const snap = await this.snapshot(orgId);
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(5, Number(q.pageSize) || 25));
    const needle = (q.search ?? '').trim().toLowerCase();

    let rows = snap.students;
    if (needle) {
      rows = rows.filter((s) =>
        s.name?.toLowerCase().includes(needle) ||
        s.registrationNo?.toLowerCase().includes(needle) ||
        s.rollNo?.toLowerCase().includes(needle) ||
        s.id?.toLowerCase().includes(needle));
    }
    if (q.status) rows = rows.filter((s) => (s.status ?? 'active') === q.status);
    if (q.campus) rows = rows.filter((s) => s.campus === q.campus);
    if (q.origin) rows = rows.filter((s) => originOf(s) === q.origin);

    const total = rows.length;
    const sorted = [...rows].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    const slice = sorted.slice((page - 1) * pageSize, page * pageSize);

    // Counts come from the same snapshot, so the list can never disagree with the
    // detail drawer that opens from it.
    const parentsByStudent = new Map<string, number>();
    for (const p of snap.parents) parentsByStudent.set(p.studentId, (parentsByStudent.get(p.studentId) ?? 0) + 1);
    const asgById = new Map(snap.teachingAssignments.map((a) => [a.id, a]));
    const teachersByStudent = new Map<string, Set<string>>();
    for (const e of snap.enrollments) {
      const a = asgById.get(e.teachingAssignmentId);
      if (!a) continue;
      if (!teachersByStudent.has(e.studentId)) teachersByStudent.set(e.studentId, new Set());
      teachersByStudent.get(e.studentId)!.add(a.teacherId);
    }

    return {
      items: slice.map((s) => ({
        ...s,
        origin: originOf(s),
        guardianCount: parentsByStudent.get(s.id) ?? 0,
        teacherCount: teachersByStudent.get(s.id)?.size ?? 0,
      })),
      page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async studentDetail(orgId: string, studentId: string): Promise<StudentDetail> {
    const snap = await this.snapshot(orgId);
    const student = snap.students.find((s) => s.id === studentId || s.registrationNo === studentId);
    if (!student) throw new NotFoundException('Student not found in the roster.');
    const asgById = new Map(snap.teachingAssignments.map((a) => [a.id, a]));
    const mine = snap.enrollments.filter((e) => e.studentId === student.id);
    return {
      student: { ...student, origin: originOf(student) },
      parents: snap.parents.filter((p) => p.studentId === student.id).map((p) => ({ ...p, origin: originOf(p) })),
      teachers: mine.flatMap((e) => {
        const a = asgById.get(e.teachingAssignmentId);
        return a ? [{ teacherId: a.teacherId, teacher: a.teacher, subjectId: a.subjectId, subject: a.subject, teachingAssignmentId: a.id, section: a.section }] : [];
      }),
      enrollments: mine.map(({ studentId: _omit, ...rest }) => rest),
    };
  }

  /** Reference lists the maintenance UI needs for its pickers. */
  async options(orgId: string): Promise<Record<string, unknown>> {
    const snap = await this.snapshot(orgId);
    return {
      campuses: snap.campuses.map((c) => c.name),
      classes: snap.classes.map((c) => c.name),
      sections: snap.sections.map((c) => c.name),
      sessions: snap.sessions.map((c) => c.name),
      semesters: snap.semesters.map((c) => c.name),
      programs: snap.programs.map((c) => c.name),
      faculties: snap.faculties.map((c) => c.name),
      departments: snap.departments.map((c) => c.name),
      counts: {
        students: snap.students.length,
        manualStudents: snap.students.filter((s) => originOf(s) === 'manual').length,
        editedStudents: snap.students.filter((s) => (s.localEdits?.length ?? 0) > 0).length,
        guardians: snap.parents.length,
        manualGuardians: snap.parents.filter((p) => originOf(p) === 'manual').length,
        teachers: snap.teachers.length,
        teachingAssignments: snap.teachingAssignments.length,
        enrollments: snap.enrollments.length,
      },
    };
  }

  /** Teaching assignments, for the "which teachers does this student have" editor. */
  async teachingAssignments(orgId: string, search?: string): Promise<SisTeachingAssignment[]> {
    const snap = await this.snapshot(orgId);
    const needle = (search ?? '').trim().toLowerCase();
    const rows = needle
      ? snap.teachingAssignments.filter((a) =>
        a.teacher?.toLowerCase().includes(needle) ||
        a.subject?.toLowerCase().includes(needle) ||
        a.section?.toLowerCase().includes(needle) ||
        a.gradeClass?.toLowerCase().includes(needle))
      : snap.teachingAssignments;
    return rows.slice(0, 300);
  }

  async teachers(orgId: string): Promise<SisTeacher[]> {
    return (await this.snapshot(orgId)).teachers;
  }

  /* ----------------------------------------------------------------- write */

  private async commit(orgId: string, snap: SisSnapshot, actor: Actor, action: string, entityId: string, previous: unknown, next: unknown): Promise<void> {
    const meta = await this.datasets.meta(orgId);
    // Keep the recorded provider: a manual correction does not change where the
    // roster came from. A first-ever edit on an org with no dataset records
    // 'internal', which is the provider key for a hand-maintained roster.
    await this.datasets.save(orgId, meta?.provider ?? 'internal', snap, actor.userId);
    // `audit_logs.entity_id` is a UUID column, and a roster record's id is not a UUID
    // (`S1000`, `PA0-1`, `M-S121`). The audited entity is therefore the dataset row —
    // which is what actually changed — and the record id travels inside the value,
    // exactly as the sync engine audits against its run id.
    const datasetId = await this.datasets.id(orgId);
    if (actor.userId && datasetId) {
      await this.audit.record({
        organizationId: orgId, userId: actor.userId, action,
        entityType: 'sis_roster', entityId: datasetId,
        previousValue: (previous === null || previous === undefined ? undefined : { recordId: entityId, record: previous }) as never,
        newValue: (next === null || next === undefined ? { recordId: entityId, deleted: true } : { recordId: entityId, record: next }) as never,
      });
    }
  }

  /** Merge a patch into a record and remember which fields were touched locally. */
  private applyPatch<T extends Record<string, unknown>>(row: T, patch: Record<string, unknown>, allowed: readonly string[], actor: Actor): { next: T; changed: string[] } {
    const changed: string[] = [];
    const next = { ...row } as Record<string, unknown>;
    for (const field of allowed) {
      if (!(field in patch)) continue;
      const incoming = patch[field];
      if (incoming === undefined) continue;
      const value = typeof incoming === 'boolean' ? incoming : clean(incoming) ?? null;
      if (value === (row[field] ?? null)) continue;
      next[field] = value;
      changed.push(field);
    }
    if (changed.length > 0) {
      // Only IMPORTED records need field-level protection. A manual record is
      // protected wholesale, so tracking individual fields on it would be noise.
      if (originOf(row as { origin?: string }) === 'sis') {
        next.localEdits = [...new Set([...(row.localEdits as string[] | undefined ?? []), ...changed])];
      }
      next.updatedLocallyAt = new Date().toISOString();
      next.updatedLocallyBy = actor.name ?? null;
    }
    return { next: next as T, changed };
  }

  /* --------------------------------------------------------------- students */

  async createStudent(orgId: string, actor: Actor, body: Record<string, unknown>): Promise<SisStudent> {
    const snap = await this.snapshot(orgId);
    const name = clean(body.name);
    const registrationNo = clean(body.registrationNo);
    if (!name) throw new BadRequestException('Student name is required.');
    if (!registrationNo) throw new BadRequestException('Registration number is required.');

    const id = clean(body.id) ?? this.nextStudentId(snap);
    if (snap.students.some((s) => s.id.toLowerCase() === id.toLowerCase())) {
      throw new BadRequestException(`Student ID "${id}" already exists in this roster.`);
    }
    if (snap.students.some((s) => (s.registrationNo ?? '').toLowerCase() === registrationNo.toLowerCase())) {
      throw new BadRequestException(`Registration number "${registrationNo}" already belongs to another student.`);
    }
    const rollNo = clean(body.rollNo);
    if (rollNo && snap.students.some((s) => (s.rollNo ?? '').toLowerCase() === rollNo.toLowerCase() && (s.currentSection ?? '') === (clean(body.currentSection) ?? ''))) {
      throw new BadRequestException(`Roll number "${rollNo}" is already used in that section.`);
    }

    const student: SisStudent = {
      id, registrationNo, rollNo: rollNo ?? '', name,
      gender: clean(body.gender) ?? 'unspecified',
      status: clean(body.status) ?? 'active',
      campus: clean(body.campus), program: clean(body.program), faculty: clean(body.faculty),
      department: clean(body.department), currentClass: clean(body.currentClass),
      currentSection: clean(body.currentSection), session: clean(body.session), semester: clean(body.semester),
      dateOfBirth: clean(body.dateOfBirth) ?? null, admissionDate: clean(body.admissionDate) ?? null,
      origin: 'manual', updatedLocallyAt: new Date().toISOString(), updatedLocallyBy: actor.name ?? null,
    };
    snap.students = [...snap.students, student];
    this.refreshRefs(snap);
    await this.commit(orgId, snap, actor, 'organization.sis.student.create', id, null, student);
    return student;
  }

  async updateStudent(orgId: string, actor: Actor, studentId: string, body: Record<string, unknown>): Promise<SisStudent> {
    const snap = await this.snapshot(orgId);
    const idx = snap.students.findIndex((s) => s.id === studentId);
    if (idx < 0) throw new NotFoundException('Student not found in the roster.');
    const before = snap.students[idx];

    const reg = clean(body.registrationNo);
    if (reg && snap.students.some((s, i) => i !== idx && (s.registrationNo ?? '').toLowerCase() === reg.toLowerCase())) {
      throw new BadRequestException(`Registration number "${reg}" already belongs to another student.`);
    }
    const { next, changed } = this.applyPatch(before as unknown as Record<string, unknown>, body, STUDENT_FIELDS as unknown as string[], actor);
    if (changed.length === 0) return { ...before, origin: originOf(before) };

    snap.students = snap.students.map((s, i) => (i === idx ? (next as unknown as SisStudent) : s));
    this.refreshRefs(snap);
    await this.commit(orgId, snap, actor, 'organization.sis.student.update', studentId, before, next);
    return next as unknown as SisStudent;
  }

  /**
   * Activate or deactivate. Deliberately NOT a delete: historical parent feedback
   * references the student by id, and the import engine has always deactivated
   * rather than removed for the same reason.
   */
  async setStudentStatus(orgId: string, actor: Actor, studentId: string, status: string): Promise<SisStudent> {
    if (!['active', 'inactive'].includes(status)) throw new BadRequestException('Status must be active or inactive.');
    return this.updateStudent(orgId, actor, studentId, { status });
  }

  private nextStudentId(snap: SisSnapshot): string {
    // Manual ids carry an M- prefix so they can never collide with a provider's
    // own numbering (which is exactly how S1001 from the built-in sample roster
    // could otherwise land on top of a seeded S1001).
    let n = snap.students.length + 1;
    let id = `M-S${n}`;
    const taken = new Set(snap.students.map((s) => s.id));
    while (taken.has(id)) { n += 1; id = `M-S${n}`; }
    return id;
  }

  /* ---------------------------------------------------------------- parents */

  async createParent(orgId: string, actor: Actor, studentId: string, body: Record<string, unknown>): Promise<SisParent> {
    const snap = await this.snapshot(orgId);
    if (!snap.students.some((s) => s.id === studentId)) throw new NotFoundException('Student not found in the roster.');
    const name = clean(body.name);
    if (!name) throw new BadRequestException('Guardian name is required.');
    const mobile = clean(body.mobile);
    const email = clean(body.email);
    if (!mobile && !clean(body.whatsapp) && !email) {
      throw new BadRequestException('A guardian needs at least one contact: mobile, WhatsApp or email — otherwise no evaluation link can ever be delivered.');
    }
    const id = clean(body.id) ?? this.nextParentId(snap, studentId);
    if (snap.parents.some((p) => p.id === id)) throw new BadRequestException(`Guardian ID "${id}" already exists.`);

    const parent: SisParent = {
      id, studentId, name,
      relationship: clean(body.relationship) ?? 'guardian',
      mobile: mobile ?? null, whatsapp: clean(body.whatsapp) ?? mobile ?? null, email: email ?? null,
      preferredLanguage: clean(body.preferredLanguage) ?? 'en',
      active: body.active === undefined ? true : Boolean(body.active),
      origin: 'manual', updatedLocallyAt: new Date().toISOString(), updatedLocallyBy: actor.name ?? null,
    };
    snap.parents = [...snap.parents, parent];
    await this.commit(orgId, snap, actor, 'organization.sis.guardian.create', id, null, parent);
    return parent;
  }

  async updateParent(orgId: string, actor: Actor, parentId: string, body: Record<string, unknown>): Promise<SisParent> {
    const snap = await this.snapshot(orgId);
    const idx = snap.parents.findIndex((p) => p.id === parentId);
    if (idx < 0) throw new NotFoundException('Guardian not found in the roster.');
    const before = snap.parents[idx];
    const { next, changed } = this.applyPatch(before as unknown as Record<string, unknown>, body, PARENT_FIELDS as unknown as string[], actor);
    if (changed.length === 0) return { ...before, origin: originOf(before) };
    snap.parents = snap.parents.map((p, i) => (i === idx ? (next as unknown as SisParent) : p));
    await this.commit(orgId, snap, actor, 'organization.sis.guardian.update', parentId, before, next);
    return next as unknown as SisParent;
  }

  /**
   * Deactivate a guardian, or remove one entirely when nothing references it.
   *
   * A guardian that has already been sent an evaluation link is NEVER removed:
   * `evaluation_links.parent_id` records who was asked, and deleting the roster
   * row would leave that history pointing at nothing. Deactivating keeps the
   * record readable and simply stops it being offered for new links.
   */
  async removeParent(orgId: string, actor: Actor, parentId: string): Promise<{ removed: boolean; deactivated: boolean; reason?: string }> {
    const snap = await this.snapshot(orgId);
    const before = snap.parents.find((p) => p.id === parentId);
    if (!before) throw new NotFoundException('Guardian not found in the roster.');

    const used = await this.prisma.evaluationLink.count({ where: { organizationId: orgId, parentId } });
    if (used > 0 || originOf(before) === 'sis') {
      const next = await this.updateParent(orgId, actor, parentId, { active: false });
      return {
        removed: false, deactivated: true,
        reason: used > 0
          ? `Deactivated rather than deleted: ${used} evaluation link(s) record this guardian, and that history must stay readable.`
          : 'Deactivated rather than deleted: this guardian came from the SIS, so a sync would recreate it. It is now excluded from new evaluation links.',
        ...(next ? {} : {}),
      };
    }
    snap.parents = snap.parents.filter((p) => p.id !== parentId);
    await this.commit(orgId, snap, actor, 'organization.sis.guardian.delete', parentId, before, null);
    return { removed: true, deactivated: false };
  }

  private nextParentId(snap: SisSnapshot, studentId: string): string {
    const taken = new Set(snap.parents.map((p) => p.id));
    let n = snap.parents.filter((p) => p.studentId === studentId).length + 1;
    let id = `M-${studentId}-G${n}`;
    while (taken.has(id)) { n += 1; id = `M-${studentId}-G${n}`; }
    return id;
  }

  /* ------------------------------------------------------------ enrollments */

  /**
   * Correct which teachers a student is taught by.
   *
   * This edits ENROLLMENTS — the existing relationship — rather than inventing a
   * student↔teacher table. A teaching assignment already carries the teacher,
   * subject, class and section, so attaching a student to one is the whole job,
   * and `getTeachersOfStudent()` (which parent feedback uses) picks it up with no
   * change of its own.
   */
  async addEnrollment(orgId: string, actor: Actor, studentId: string, teachingAssignmentId: string): Promise<SisEnrollment> {
    const snap = await this.snapshot(orgId);
    if (!snap.students.some((s) => s.id === studentId)) throw new NotFoundException('Student not found in the roster.');
    const a = snap.teachingAssignments.find((x) => x.id === teachingAssignmentId);
    if (!a) throw new NotFoundException('Teaching assignment not found in the roster.');
    if (snap.enrollments.some((e) => e.studentId === studentId && e.teachingAssignmentId === teachingAssignmentId)) {
      throw new BadRequestException(`${a.teacher} — ${a.subject} is already on this student.`);
    }
    const row: SisSnapshotEnrollment = {
      id: `enr-m-${studentId}-${teachingAssignmentId}`,
      studentId, teachingAssignmentId,
      teacher: a.teacher, subject: a.subject, subjectCode: a.subjectCode,
      gradeClass: a.gradeClass, section: a.section, session: a.session,
      enrollmentDate: new Date().toISOString().slice(0, 10), status: 'active',
      origin: 'manual', updatedLocallyAt: new Date().toISOString(), updatedLocallyBy: actor.name ?? null,
    };
    snap.enrollments = [...snap.enrollments, row];
    await this.commit(orgId, snap, actor, 'organization.sis.enrollment.create', row.id, null, row);
    const { studentId: _omit, ...rest } = row;
    return rest;
  }

  async removeEnrollment(orgId: string, actor: Actor, studentId: string, teachingAssignmentId: string): Promise<{ removed: boolean }> {
    const snap = await this.snapshot(orgId);
    const before = snap.enrollments.find((e) => e.studentId === studentId && e.teachingAssignmentId === teachingAssignmentId);
    if (!before) throw new NotFoundException('That teacher is not linked to this student.');
    snap.enrollments = snap.enrollments.filter((e) => !(e.studentId === studentId && e.teachingAssignmentId === teachingAssignmentId));
    await this.commit(orgId, snap, actor, 'organization.sis.enrollment.delete', before.id, before, null);
    return { removed: true };
  }

  /* ------------------------------------------------------------------ misc */

  /**
   * Reference lists (campuses, classes, sections, …) are DERIVED from the rows —
   * exactly as `SisSyncService.reconcile()` derives them — so a manually added
   * campus or section appears in every picker without a second place to maintain.
   */
  private refreshRefs(snap: SisSnapshot): void {
    const list = (names: (string | undefined)[]) =>
      [...new Set(names.filter((n): n is string => !!n && n.trim() !== ''))].map((n) => ({ id: n, code: n, name: n }));
    snap.campuses = list([...snap.students.map((s) => s.campus), ...snap.teachingAssignments.map((a) => a.campus)]);
    snap.faculties = list([...snap.students.map((s) => s.faculty), ...snap.teachers.map((t) => t.faculty)]);
    snap.departments = list([...snap.students.map((s) => s.department), ...snap.teachers.map((t) => t.department)]);
    snap.programs = list(snap.students.map((s) => s.program));
    snap.sessions = list([...snap.students.map((s) => s.session), ...snap.teachingAssignments.map((a) => a.session)]);
    snap.semesters = list(snap.students.map((s) => s.semester));
    snap.classes = list(snap.students.map((s) => s.currentClass));
    snap.sections = list(snap.students.map((s) => s.currentSection));
  }
}
