import { createHash } from 'node:crypto';
import { pick } from '../../hr-integration/providers/provider-util';
import type { SisParent, SisRef, SisStudent, SisSubject, SisTeacher, SisTeachingAssignment } from '../../sis/sis.types';
import type { SisSnapshot, SisSnapshotEnrollment } from '../sis-snapshot.types';

export interface SisRawRows {
  students: Record<string, unknown>[];
  guardians: Record<string, unknown>[];
  teachers: Record<string, unknown>[];
  teachingAssignments: Record<string, unknown>[];
  enrollments: Record<string, unknown>[];
  /**
   * The FLAT sheet: one row per student × subject, student and parent columns repeated
   * on every row — the shape a SQL join produces. `expandRoster()` unfolds it into the
   * five buckets above, so nothing downstream knows it exists.
   */
  roster: Record<string, unknown>[];
}

export function emptyRows(): SisRawRows {
  return { students: [], guardians: [], teachers: [], teachingAssignments: [], enrollments: [], roster: [] };
}

/**
 * The spreadsheet row an expanded record came from, so a validation message points at
 * the line the operator can actually see. Absent on rows read straight off a sheet,
 * where the array index already is the row.
 */
const SOURCE_ROW = '__sourceRow';
const rowOf = (r: Record<string, unknown>, i: number): number =>
  typeof r[SOURCE_ROW] === 'number' ? (r[SOURCE_ROW] as number) : i + 1;

/** Header synonyms per canonical field (case/space/underscore-insensitive via `pick`). */
const SYN = {
  studentId: ['student_id', 'studentId', 'id', 'registration_no', 'reg_no', 'admission_no', 'sr_no'],
  name: ['name', 'student_name', 'full_name'],
  gender: ['gender', 'sex'],
  klass: ['class', 'grade', 'class_grade', 'current_class'],
  section: ['section', 'current_section'],
  campus: ['campus', 'institute', 'branch'],
  department: ['department', 'school', 'college'],
  session: ['session', 'academic_session', 'academic_year', 'year', 'session_year'],
  status: ['status', 'student_status'],
  rollNo: ['roll_no', 'roll'],
  faculty: ['faculty'],
  program: ['program', 'programme'],
  semester: ['semester', 'term'],
  parentName: ['parent_name', 'guardian_name'],
  parentMobile: ['parent_mobile', 'guardian_mobile', 'mobile', 'phone'],
  parentWhatsapp: ['parent_whatsapp', 'whatsapp', 'whatsapp_number'],
  parentEmail: ['parent_email', 'guardian_email', 'email'],
  relationship: ['relationship', 'relation'],
  language: ['language', 'preferred_language'],
  teacherId: ['teacher_id', 'teacherId'],
  employeeCode: ['employee_code', 'emp_code', 'employee_no', 'service_no', 'staff_code'],
  // Flat-sheet only. A roster row carries BOTH a student and a teacher, so the teacher's
  // name and code need headers that cannot collide with the student's.
  teacherName: ['teacher_name', 'teacher'],
  teacherEmployeeCode: ['teacher_employee_code', 'teacher_code', 'teacher_emp_code', 'teacher_employee_no'],
  designation: ['designation', 'title'],
  assignmentId: ['assignment_id', 'teaching_assignment_id', 'id'],
  subjectId: ['subject_id', 'subjectId'],
  subjectName: ['subject', 'subject_name'],
  subjectCode: ['subject_code'],
  creditHours: ['credit_hours', 'credits'],
};

function refList(names: Iterable<string>): SisRef[] {
  const out: SisRef[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    const name = (n ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ id: name, code: name, name });
  }
  return out;
}

function normStatus(s: string): string {
  return /inactive|left|withdrawn|graduated|transferred|terminated|disabled|alumni/i.test(s) ? 'inactive' : 'active';
}

/**
 * A teaching assignment id derived from what the assignment IS, so the same sheet
 * imported twice produces the same id and `reconcile()` updates in place instead of
 * accumulating a duplicate every term.
 *
 * Never use a row number or a counter here. `EvaluationLink.teachingAssignmentId` is
 * stamped onto every parent link at generation, and an id that moves between imports
 * would orphan the link's reference to it.
 */
function derivedAssignmentId(teacherId: string, subjectId: string, klass: string, section: string, session: string): string {
  const key = [teacherId, subjectId, klass, section, session].map((s) => s.trim().toLowerCase()).join('|');
  return `TA-${createHash('sha1').update(key).digest('hex').slice(0, 16)}`; // 19 chars, fits VARCHAR(64)
}

/**
 * Unfold the flat `Roster` sheet into the five normalized buckets.
 *
 * One row per student × subject, with the student and parent columns repeated. The
 * repetition is the point — it is what lets HR maintain the whole roster in one sheet —
 * so this function is where the de-duplication happens:
 *
 *   - a student appearing on six rows becomes ONE student (the first row wins for their
 *     attributes; a later row that disagrees is reported, not silently applied)
 *   - the same parent repeated across a student's rows becomes ONE guardian
 *   - a teacher repeated across many rows becomes ONE teacher, keyed on employee code
 *   - each distinct (teacher, subject, class, section, session) becomes ONE teaching
 *     assignment, with a derived, stable id
 *   - every row with a teacher on it becomes an enrolment
 *
 * Returns a NEW SisRawRows; the input is not modified. Rows already present in the
 * dedicated sheets are kept and the roster's are appended, so a workbook may mix both.
 */
export function expandRoster(rows: SisRawRows): SisRawRows {
  if (rows.roster.length === 0) return rows;
  const g = (r: Record<string, unknown>, key: keyof typeof SYN): string => pick(r, SYN[key]);

  const students: Record<string, unknown>[] = [];
  const teachers: Record<string, unknown>[] = [];
  const assignments: Record<string, unknown>[] = [];
  const enrollments: Record<string, unknown>[] = [];

  const seenStudent = new Set<string>();
  const seenTeacher = new Set<string>();
  const seenAssignment = new Set<string>();
  const seenEnrollment = new Set<string>();

  rows.roster.forEach((r, i) => {
    const row = i + 1;
    const studentId = g(r, 'studentId');
    if (!studentId) return; // reported by validateRoster; nothing to build from

    if (!seenStudent.has(studentId)) {
      seenStudent.add(studentId);
      students.push({
        student_id: studentId,
        name: g(r, 'name'),
        gender: g(r, 'gender'),
        class: g(r, 'klass'),
        section: g(r, 'section'),
        campus: g(r, 'campus'),
        department: g(r, 'department'),
        program: g(r, 'program'),
        session: g(r, 'session'),
        semester: g(r, 'semester'),
        roll_no: g(r, 'rollNo'),
        status: g(r, 'status'),
        // The inline guardian: buildSnapshot turns these into the student's parent.
        parent_name: g(r, 'parentName'),
        relationship: g(r, 'relationship'),
        parent_mobile: g(r, 'parentMobile'),
        parent_whatsapp: g(r, 'parentWhatsapp'),
        parent_email: g(r, 'parentEmail'),
        language: g(r, 'language'),
        [SOURCE_ROW]: row,
      });
    }

    // Teacher columns are OPTIONAL. A sheet with none of them is a plain roster and
    // still imports — it simply cannot drive parent feedback on teachers.
    const teacherCode = g(r, 'teacherEmployeeCode') || g(r, 'employeeCode');
    const teacherName = g(r, 'teacherName');
    const subjectName = g(r, 'subjectName');
    if (!teacherCode && !teacherName) return;

    // Employee code is the identity: it is what auto-links the teacher to a 360
    // employee. Name is the last resort and is reported as a warning when used.
    const teacherId = g(r, 'teacherId') || teacherCode || teacherName;
    if (!seenTeacher.has(teacherId)) {
      seenTeacher.add(teacherId);
      teachers.push({
        teacher_id: teacherId,
        employee_code: teacherCode,
        name: teacherName || teacherId,
        department: g(r, 'department'),
        faculty: g(r, 'faculty'),
        status: 'active',
        [SOURCE_ROW]: row,
      });
    }

    if (!subjectName) return; // no subject ⇒ no assignment to build; validateRoster warns

    const subjectCode = g(r, 'subjectCode');
    const subjectId = subjectCode || subjectName;
    const klass = g(r, 'klass');
    const section = g(r, 'section');
    const session = g(r, 'session');
    const assignmentId = derivedAssignmentId(teacherId, subjectId, klass, section, session);

    if (!seenAssignment.has(assignmentId)) {
      seenAssignment.add(assignmentId);
      assignments.push({
        assignment_id: assignmentId,
        teacher_id: teacherId,
        subject_id: subjectId,
        subject: subjectName,
        subject_code: subjectCode,
        class: klass,
        section,
        session,
        semester: g(r, 'semester'),
        campus: g(r, 'campus'),
        program: g(r, 'program') || g(r, 'department'),
        status: 'active',
        [SOURCE_ROW]: row,
      });
    }

    // A student taught the same subject by the same teacher twice in one sheet is one
    // enrolment, not two.
    const enrolKey = `${studentId}|${assignmentId}`;
    if (!seenEnrollment.has(enrolKey)) {
      seenEnrollment.add(enrolKey);
      enrollments.push({ student_id: studentId, assignment_id: assignmentId, status: 'active', [SOURCE_ROW]: row });
    }
  });

  return {
    students: [...rows.students, ...students],
    guardians: [...rows.guardians],
    teachers: [...rows.teachers, ...teachers],
    teachingAssignments: [...rows.teachingAssignments, ...assignments],
    enrollments: [...rows.enrollments, ...enrollments],
    roster: [],
  };
}

/**
 * Flat-sheet checks that need the ORIGINAL rows — row numbers the operator can find,
 * and conflicts that only exist because a student spans several rows. Run before
 * `expandRoster`, which collapses exactly that information away.
 */
function validateRoster(roster: Record<string, unknown>[]): { errors: SisValidationIssue[]; warnings: SisValidationIssue[] } {
  const g = (r: Record<string, unknown>, key: keyof typeof SYN): string => pick(r, SYN[key]);
  const errors: SisValidationIssue[] = [];
  const warnings: SisValidationIssue[] = [];
  if (roster.length === 0) return { errors, warnings };

  // First value seen per student per field, so a later disagreement can be named.
  const firstSeen = new Map<string, Map<string, { value: string; row: number }>>();
  const TRACKED: { key: keyof typeof SYN; field: string }[] = [
    { key: 'name', field: 'student_name' },
    { key: 'klass', field: 'class' },
    { key: 'section', field: 'section' },
    { key: 'parentMobile', field: 'parent_mobile' },
    { key: 'parentName', field: 'parent_name' },
  ];
  let anyTeacher = false;

  roster.forEach((r, i) => {
    const row = i + 1;
    // Noted BEFORE the missing-id bail-out: a sheet that plainly has teacher columns
    // must not also be told it has none just because one row lost its student id.
    if (g(r, 'teacherEmployeeCode') || g(r, 'employeeCode') || g(r, 'teacherName') || g(r, 'subjectName')) anyTeacher = true;

    const studentId = g(r, 'studentId');
    if (!studentId) {
      errors.push({ entity: 'roster', row, field: 'student_id', key: null, message: 'Missing Student ID — every row must say which student it is for.' });
      return;
    }

    let seen = firstSeen.get(studentId);
    if (!seen) { seen = new Map(); firstSeen.set(studentId, seen); }
    for (const { key, field } of TRACKED) {
      const value = g(r, key);
      if (!value) continue;
      const prior = seen.get(field);
      if (!prior) { seen.set(field, { value, row }); continue; }
      if (prior.value !== value) {
        warnings.push({
          entity: 'roster', row, field, key: studentId,
          message: `${studentId} has "${prior.value}" on row ${prior.row} but "${value}" here. The FIRST value is used; make them the same if row ${prior.row} is wrong.`,
        });
      }
    }

    const teacherCode = g(r, 'teacherEmployeeCode') || g(r, 'employeeCode');
    const teacherName = g(r, 'teacherName');
    const subject = g(r, 'subjectName');
    if (!teacherCode && !teacherName && !subject) return; // roster-only row, fine

    if (!teacherCode) {
      warnings.push({
        entity: 'roster', row, field: 'teacher_employee_code', key: teacherName || studentId,
        message: `No Teacher Employee Code for "${teacherName || 'this teacher'}" — the teacher is identified by name and will NOT auto-link to a 360 employee, so parent feedback cannot reach them.`,
      });
    }
    if (!teacherName) {
      warnings.push({ entity: 'roster', row, field: 'teacher_name', key: teacherCode, message: 'Teacher Employee Code with no Teacher Name — the teacher will show as their code.' });
    }
    if (!subject) {
      warnings.push({ entity: 'roster', row, field: 'subject', key: studentId, message: 'A teacher with no Subject — no teaching assignment is created from this row, so the parent is not asked about this teacher.' });
    }
    if (subject && !g(r, 'klass')) {
      warnings.push({ entity: 'roster', row, field: 'class', key: studentId, message: 'No Class on a row that names a teacher — teaching assignments are identified by teacher + subject + class + section + session, so leaving it blank merges rows that may be different classes.' });
    }
  });

  if (!anyTeacher) {
    warnings.push({
      entity: 'roster', row: null, field: null, key: null,
      message: 'No teacher or subject columns are filled. This imports the student roster and parent contacts, but parent feedback ON TEACHERS needs Teacher Employee Code and Subject on each row.',
    });
  }
  return { errors, warnings };
}

/**
 * Build a full SisSnapshot from normalized row sets. Academic-structure refs
 * (campuses/departments/programs/sessions/classes/sections/semesters/faculties) are
 * synthesized from the data; subjects are synthesized from teaching assignments; a
 * student's inline parent columns become a primary guardian, and the Guardians sheet
 * adds more. IDs use the source's stable ids so re-imports update in place.
 */
export function buildSnapshot(input: SisRawRows): SisSnapshot {
  // The flat sheet is unfolded first, so everything below sees ordinary per-entity rows
  // and needs no knowledge of it. A workbook with no Roster sheet is untouched.
  const rows = expandRoster(input);
  const g = (r: Record<string, unknown>, key: keyof typeof SYN): string => pick(r, SYN[key]);

  // Teachers
  const teachers: SisTeacher[] = [];
  const teacherById = new Map<string, SisTeacher>();
  for (const r of rows.teachers) {
    const id = g(r, 'teacherId') || g(r, 'employeeCode') || g(r, 'name');
    if (!id) continue;
    const t: SisTeacher = {
      id, employeeCode: g(r, 'employeeCode') || id, name: g(r, 'name') || id,
      designation: g(r, 'designation'), department: g(r, 'department') || undefined,
      faculty: g(r, 'faculty') || undefined, mobile: g(r, 'parentMobile') || pick(r, ['mobile', 'phone']) || null,
      email: pick(r, ['email']) || null, status: normStatus(g(r, 'status')),
    };
    teachers.push(t); teacherById.set(id, t);
  }

  // Teaching assignments (+ synthesize subjects)
  const subjectById = new Map<string, SisSubject>();
  const teachingAssignments: SisTeachingAssignment[] = [];
  const asgById = new Map<string, SisTeachingAssignment>();
  for (const r of rows.teachingAssignments) {
    const id = g(r, 'assignmentId');
    if (!id) continue;
    const teacherId = g(r, 'teacherId');
    const teacher = teacherById.get(teacherId);
    const subjectId = g(r, 'subjectId') || g(r, 'subjectName');
    const subjectName = g(r, 'subjectName') || subjectId;
    if (subjectId && !subjectById.has(subjectId)) {
      subjectById.set(subjectId, { id: subjectId, code: g(r, 'subjectCode') || subjectId, name: subjectName, department: g(r, 'department') || undefined, program: g(r, 'program') || undefined, creditHours: Number(g(r, 'creditHours')) || 0, status: 'active' });
    }
    const a: SisTeachingAssignment = {
      id, teacherId, teacher: teacher?.name ?? teacherId, subjectId, subject: subjectName, subjectCode: g(r, 'subjectCode') || undefined,
      session: g(r, 'session') || undefined, semester: g(r, 'semester') || undefined, campus: g(r, 'campus') || undefined,
      program: g(r, 'program') || undefined, gradeClass: g(r, 'klass') || undefined, section: g(r, 'section') || undefined,
      startDate: null, endDate: null, status: normStatus(g(r, 'status')),
    };
    teachingAssignments.push(a); asgById.set(id, a);
  }

  // Students (+ inline primary guardian)
  const students: SisStudent[] = [];
  const parents: SisParent[] = [];
  for (const r of rows.students) {
    const id = g(r, 'studentId');
    if (!id) continue;
    const campus = g(r, 'campus'); const dept = g(r, 'department'); const program = g(r, 'program') || dept;
    const s: SisStudent = {
      id, registrationNo: id, rollNo: g(r, 'rollNo') || id, name: g(r, 'name') || id, gender: g(r, 'gender') || 'Unspecified',
      status: normStatus(g(r, 'status')), program: program || undefined, campus: campus || undefined,
      currentClass: g(r, 'klass') || undefined, currentSection: g(r, 'section') || undefined,
      faculty: g(r, 'faculty') || undefined, department: dept || undefined, session: g(r, 'session') || undefined, semester: g(r, 'semester') || undefined,
      dateOfBirth: null, admissionDate: null,
    };
    students.push(s);
    const pName = g(r, 'parentName');
    const pMobile = g(r, 'parentMobile'); const pWa = g(r, 'parentWhatsapp'); const pEmail = g(r, 'parentEmail');
    if (pName || pMobile || pWa || pEmail) {
      parents.push({ id: `${id}-g1`, studentId: id, name: pName || 'Parent/Guardian', relationship: g(r, 'relationship') || 'Guardian', mobile: pMobile || null, whatsapp: pWa || pMobile || null, email: pEmail || null, preferredLanguage: g(r, 'language') || 'en', active: true });
    }
  }

  // Additional guardians
  let gi = 2;
  for (const r of rows.guardians) {
    const studentId = g(r, 'studentId');
    if (!studentId) continue;
    parents.push({ id: `${studentId}-g${gi++}`, studentId, name: g(r, 'parentName') || g(r, 'name') || 'Parent/Guardian', relationship: g(r, 'relationship') || 'Guardian', mobile: g(r, 'parentMobile') || null, whatsapp: g(r, 'parentWhatsapp') || g(r, 'parentMobile') || null, email: g(r, 'parentEmail') || null, preferredLanguage: g(r, 'language') || 'en', active: true });
  }

  // Enrollments (student <-> teaching assignment)
  const enrollments: SisSnapshotEnrollment[] = [];
  let ei = 1;
  for (const r of rows.enrollments) {
    const studentId = g(r, 'studentId');
    const assignmentId = g(r, 'assignmentId');
    const a = asgById.get(assignmentId);
    if (!studentId || !a) continue;
    enrollments.push({ id: `enr-${ei++}`, studentId, teachingAssignmentId: a.id, teacher: a.teacher, subject: a.subject, subjectCode: a.subjectCode, gradeClass: a.gradeClass, section: a.section, session: a.session, enrollmentDate: null, status: normStatus(g(r, 'status')) });
  }

  return {
    campuses: refList(students.map((s) => s.campus ?? '').concat(teachingAssignments.map((a) => a.campus ?? ''))),
    faculties: refList(students.map((s) => s.faculty ?? '').concat(teachers.map((t) => t.faculty ?? ''))),
    departments: refList(students.map((s) => s.department ?? '').concat(teachers.map((t) => t.department ?? ''))),
    programs: refList(students.map((s) => s.program ?? '')),
    sessions: refList(students.map((s) => s.session ?? '').concat(teachingAssignments.map((a) => a.session ?? ''))),
    semesters: refList(students.map((s) => s.semester ?? '')),
    classes: refList(students.map((s) => s.currentClass ?? '')),
    sections: refList(students.map((s) => s.currentSection ?? '')),
    subjects: [...subjectById.values()],
    teachers, students, parents, teachingAssignments, enrollments,
  };
}

export interface SisValidationIssue { entity: string; row: number | null; field: string | null; key: string | null; message: string }
export interface SisValidationResult {
  ok: boolean;
  counts: { students: number; guardians: number; teachers: number; teachingAssignments: number; enrollments: number };
  errors: SisValidationIssue[];
  warnings: SisValidationIssue[];
}

/** Read-only validation over the raw rows: required keys, in-file duplicates,
 *  reference existence, and helpful warnings. Errors block the import. */
export function validateRows(input: SisRawRows): SisValidationResult {
  const g = (r: Record<string, unknown>, key: keyof typeof SYN): string => pick(r, SYN[key]);
  const errors: SisValidationIssue[] = [];
  const warnings: SisValidationIssue[] = [];

  // Flat-sheet checks run on the ORIGINAL rows — the per-student conflicts and the row
  // numbers only exist before expansion collapses them.
  const rosterIssues = validateRoster(input.roster);
  errors.push(...rosterIssues.errors);
  warnings.push(...rosterIssues.warnings);
  const rows = expandRoster(input);

  const studentIds = new Set<string>();
  rows.students.forEach((r, i) => {
    const id = g(r, 'studentId');
    if (!id) errors.push({ entity: 'students', row: rowOf(r, i), field: 'student_id', key: null, message: 'Missing student_id.' });
    else if (studentIds.has(id)) errors.push({ entity: 'students', row: rowOf(r, i), field: 'student_id', key: id, message: `Duplicate student_id "${id}".` });
    else studentIds.add(id);
    if (!g(r, 'name')) warnings.push({ entity: 'students', row: rowOf(r, i), field: 'name', key: id, message: 'Student has no name.' });
    if (!g(r, 'parentMobile') && !g(r, 'parentWhatsapp') && !g(r, 'parentEmail')) warnings.push({ entity: 'students', row: rowOf(r, i), field: 'parent', key: id, message: 'No parent contact — parent feedback cannot be sent for this student unless a Guardian row provides one.' });
  });

  /*
   * Academic structure is keyed on the trimmed display name (see `refList` above),
   * so "BSCS-1", "bscs-1" and "BSCS 1" become THREE separate classes and nothing
   * downstream can tell they were meant to be one. In a hand-maintained workbook this
   * drifts quietly over an academic year.
   *
   * Warn rather than merge: folding them automatically would silently rewrite naming
   * an administrator may have chosen deliberately ("Grade 9" vs "Grade 9A").
   */
  const STRUCTURE: { key: keyof typeof SYN; field: string; label: string }[] = [
    { key: 'klass', field: 'class', label: 'class' },
    { key: 'section', field: 'section', label: 'section' },
    { key: 'department', field: 'department', label: 'department' },
    { key: 'program', field: 'program', label: 'program' },
    { key: 'campus', field: 'campus', label: 'campus' },
    { key: 'session', field: 'session', label: 'session' },
    { key: 'semester', field: 'semester', label: 'semester' },
    { key: 'faculty', field: 'faculty', label: 'faculty' },
  ];
  const fold = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  for (const { key, field, label } of STRUCTURE) {
    const variants = new Map<string, Set<string>>();
    for (const r of rows.students) {
      const raw = g(r, key);
      if (!raw) continue;
      const folded = fold(raw);
      if (!folded) continue;
      let set = variants.get(folded);
      if (!set) { set = new Set<string>(); variants.set(folded, set); }
      set.add(raw);
    }
    for (const set of variants.values()) {
      if (set.size < 2) continue;
      warnings.push({
        entity: 'students',
        row: null,
        field,
        key: null,
        message: `${set.size} spellings of what looks like one ${label}: ${[...set].map((v) => `"${v}"`).join(', ')}. Each becomes a SEPARATE ${label}. Make them identical if they are meant to be the same.`,
      });
    }
  }

  /*
   * Parent contact quality. All warnings — never blocking, because a roster import
   * that refuses over one malformed phone number is worse than one that imports and
   * says so. A bad number is not discovered otherwise until a WhatsApp send silently
   * fails weeks later.
   */
  const LOOKS_LIKE_PHONE = /^\+?[0-9][0-9\s()./-]{6,}$/;
  const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

  /** Last 10 digits — folds "03001234567" and "+923001234567" onto the same person. */
  const contactKey = (raw: string): string => {
    const digits = raw.replace(/\D/g, '');
    return digits.length >= 9 ? digits.slice(-10) : '';
  };
  const foldName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  const contacts = new Map<string, { names: Set<string>; emails: Set<string>; rows: number[] }>();

  /**
   * `nameField` differs by sheet and getting it wrong is not cosmetic: on a Students or
   * Roster row `name` is the STUDENT, so falling back to it would compare two siblings'
   * names against their shared parent number and report a conflict that is not one.
   * Only the Guardians sheet keeps the guardian's own name in `name`.
   */
  const checkContact = (entity: string, index: number, key: string | null, r: Record<string, unknown>, nameField: 'parentName' | 'guardianName'): void => {
    const row = rowOf(r, index);
    for (const [field, label] of [['parentMobile', 'parent_mobile'], ['parentWhatsapp', 'parent_whatsapp']] as const) {
      const value = g(r, field);
      if (!value) continue;
      if (!LOOKS_LIKE_PHONE.test(value)) {
        warnings.push({ entity, row, field: label, key, message: `"${value}" does not look like a phone number — no message can be delivered to it.` });
      } else if (!/^[0+]/.test(value)) {
        // Excel stores 03001234567 as the NUMBER 3001234567 unless the cell is Text,
        // and the leading zero is gone before we ever see it. Flag the shape; a number
        // that legitimately starts 1-9 in its own country is a false positive here.
        warnings.push({ entity, row, field: label, key, message: `"${value}" starts with neither 0 nor "+". If Excel dropped a leading zero, format the column as Text or write it as +92… — otherwise ignore this.` });
      }
    }
    const email = g(r, 'parentEmail');
    if (email && !LOOKS_LIKE_EMAIL.test(email)) {
      warnings.push({ entity, row, field: 'parent_email', key, message: `"${email}" is not a valid e-mail address.` });
    }
    const ck = contactKey(g(r, 'parentMobile') || g(r, 'parentWhatsapp'));
    if (!ck) return;
    let entry = contacts.get(ck);
    if (!entry) { entry = { names: new Set(), emails: new Set(), rows: [] }; contacts.set(ck, entry); }
    const name = foldName(nameField === 'guardianName' ? (g(r, 'parentName') || g(r, 'name')) : g(r, 'parentName'));
    if (name) entry.names.add(name);
    if (email) entry.emails.add(email.toLowerCase());
    entry.rows.push(row);
  };

  rows.students.forEach((r, i) => checkContact('students', i, g(r, 'studentId') || null, r, 'parentName'));
  rows.guardians.forEach((r, i) => checkContact('guardians', i, g(r, 'studentId') || null, r, 'guardianName'));

  /*
   * One phone number carrying MATERIALLY different names or e-mails. Case and
   * punctuation are folded away first, so "Rashid Ali" and "RASHID  ALI" are one
   * person and stay silent — the warning fires for "Rashid Ali" vs "Imran Ahmed",
   * which is normally a number copied down the wrong rows.
   *
   * Nothing is merged. A parent with several children legitimately appears on each
   * child's row, and each row is that child's own guardian record.
   */
  for (const [, entry] of contacts) {
    if (entry.rows.length < 2) continue;
    const where = `rows ${entry.rows.slice(0, 8).join(', ')}${entry.rows.length > 8 ? '…' : ''}`;
    if (entry.names.size > 1) {
      warnings.push({ entity: 'students', row: null, field: 'parent_name', key: null, message: `One phone number is shared by different parent names (${where}): ${[...entry.names].map((n) => `"${n}"`).join(', ')}. Check the number was not copied onto the wrong row.` });
    }
    if (entry.emails.size > 1) {
      warnings.push({ entity: 'students', row: null, field: 'parent_email', key: null, message: `One phone number is shared by different e-mail addresses (${where}): ${[...entry.emails].map((e) => `"${e}"`).join(', ')}.` });
    }
  }

  const teacherIds = new Set<string>();
  rows.teachers.forEach((r, i) => {
    const id = g(r, 'teacherId') || g(r, 'employeeCode');
    if (!id) errors.push({ entity: 'teachers', row: rowOf(r, i), field: 'teacher_id', key: null, message: 'Missing teacher_id / employee_code.' });
    else if (teacherIds.has(id)) errors.push({ entity: 'teachers', row: rowOf(r, i), field: 'teacher_id', key: id, message: `Duplicate teacher "${id}".` });
    else teacherIds.add(id);
    if (!g(r, 'employeeCode')) warnings.push({ entity: 'teachers', row: rowOf(r, i), field: 'employee_code', key: id, message: 'No employee_code — teacher will not auto-map to a 360 employee.' });
  });

  const asgIds = new Set<string>();
  rows.teachingAssignments.forEach((r, i) => {
    const id = g(r, 'assignmentId');
    const teacherId = g(r, 'teacherId');
    if (!id) errors.push({ entity: 'teachingAssignments', row: rowOf(r, i), field: 'assignment_id', key: null, message: 'Missing assignment_id.' });
    else if (asgIds.has(id)) errors.push({ entity: 'teachingAssignments', row: rowOf(r, i), field: 'assignment_id', key: id, message: `Duplicate assignment_id "${id}".` });
    else asgIds.add(id);
    if (teacherId && !teacherIds.has(teacherId)) errors.push({ entity: 'teachingAssignments', row: rowOf(r, i), field: 'teacher_id', key: id, message: `Unknown teacher_id "${teacherId}".` });
  });

  rows.guardians.forEach((r, i) => {
    const sid = g(r, 'studentId');
    if (sid && !studentIds.has(sid)) errors.push({ entity: 'guardians', row: rowOf(r, i), field: 'student_id', key: sid, message: `Guardian references unknown student "${sid}".` });
  });
  rows.enrollments.forEach((r, i) => {
    const sid = g(r, 'studentId'); const aid = g(r, 'assignmentId');
    if (sid && !studentIds.has(sid)) errors.push({ entity: 'enrollments', row: rowOf(r, i), field: 'student_id', key: sid, message: `Enrollment references unknown student "${sid}".` });
    if (aid && !asgIds.has(aid)) errors.push({ entity: 'enrollments', row: rowOf(r, i), field: 'assignment_id', key: aid, message: `Enrollment references unknown assignment "${aid}".` });
  });

  return {
    ok: errors.length === 0,
    counts: { students: rows.students.length, guardians: rows.guardians.length, teachers: rows.teachers.length, teachingAssignments: rows.teachingAssignments.length, enrollments: rows.enrollments.length },
    errors, warnings,
  };
}
