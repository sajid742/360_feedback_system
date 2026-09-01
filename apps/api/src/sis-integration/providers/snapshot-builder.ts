import { pick } from '../../hr-integration/providers/provider-util';
import type { SisParent, SisRef, SisStudent, SisSubject, SisTeacher, SisTeachingAssignment } from '../../sis/sis.types';
import type { SisSnapshot, SisSnapshotEnrollment } from '../sis-snapshot.types';

export interface SisRawRows {
  students: Record<string, unknown>[];
  guardians: Record<string, unknown>[];
  teachers: Record<string, unknown>[];
  teachingAssignments: Record<string, unknown>[];
  enrollments: Record<string, unknown>[];
}

export function emptyRows(): SisRawRows {
  return { students: [], guardians: [], teachers: [], teachingAssignments: [], enrollments: [] };
}

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
 * Build a full SisSnapshot from normalized row sets. Academic-structure refs
 * (campuses/departments/programs/sessions/classes/sections/semesters/faculties) are
 * synthesized from the data; subjects are synthesized from teaching assignments; a
 * student's inline parent columns become a primary guardian, and the Guardians sheet
 * adds more. IDs use the source's stable ids so re-imports update in place.
 */
export function buildSnapshot(rows: SisRawRows): SisSnapshot {
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
export function validateRows(rows: SisRawRows): SisValidationResult {
  const g = (r: Record<string, unknown>, key: keyof typeof SYN): string => pick(r, SYN[key]);
  const errors: SisValidationIssue[] = [];
  const warnings: SisValidationIssue[] = [];

  const studentIds = new Set<string>();
  rows.students.forEach((r, i) => {
    const id = g(r, 'studentId');
    if (!id) errors.push({ entity: 'students', row: i + 1, field: 'student_id', key: null, message: 'Missing student_id.' });
    else if (studentIds.has(id)) errors.push({ entity: 'students', row: i + 1, field: 'student_id', key: id, message: `Duplicate student_id "${id}".` });
    else studentIds.add(id);
    if (!g(r, 'name')) warnings.push({ entity: 'students', row: i + 1, field: 'name', key: id, message: 'Student has no name.' });
    if (!g(r, 'parentMobile') && !g(r, 'parentWhatsapp') && !g(r, 'parentEmail')) warnings.push({ entity: 'students', row: i + 1, field: 'parent', key: id, message: 'No parent contact — parent feedback cannot be sent for this student unless a Guardian row provides one.' });
  });

  const teacherIds = new Set<string>();
  rows.teachers.forEach((r, i) => {
    const id = g(r, 'teacherId') || g(r, 'employeeCode');
    if (!id) errors.push({ entity: 'teachers', row: i + 1, field: 'teacher_id', key: null, message: 'Missing teacher_id / employee_code.' });
    else if (teacherIds.has(id)) errors.push({ entity: 'teachers', row: i + 1, field: 'teacher_id', key: id, message: `Duplicate teacher "${id}".` });
    else teacherIds.add(id);
    if (!g(r, 'employeeCode')) warnings.push({ entity: 'teachers', row: i + 1, field: 'employee_code', key: id, message: 'No employee_code — teacher will not auto-map to a 360 employee.' });
  });

  const asgIds = new Set<string>();
  rows.teachingAssignments.forEach((r, i) => {
    const id = g(r, 'assignmentId');
    const teacherId = g(r, 'teacherId');
    if (!id) errors.push({ entity: 'teachingAssignments', row: i + 1, field: 'assignment_id', key: null, message: 'Missing assignment_id.' });
    else if (asgIds.has(id)) errors.push({ entity: 'teachingAssignments', row: i + 1, field: 'assignment_id', key: id, message: `Duplicate assignment_id "${id}".` });
    else asgIds.add(id);
    if (teacherId && !teacherIds.has(teacherId)) errors.push({ entity: 'teachingAssignments', row: i + 1, field: 'teacher_id', key: id, message: `Unknown teacher_id "${teacherId}".` });
  });

  rows.guardians.forEach((r, i) => {
    const sid = g(r, 'studentId');
    if (sid && !studentIds.has(sid)) errors.push({ entity: 'guardians', row: i + 1, field: 'student_id', key: sid, message: `Guardian references unknown student "${sid}".` });
  });
  rows.enrollments.forEach((r, i) => {
    const sid = g(r, 'studentId'); const aid = g(r, 'assignmentId');
    if (sid && !studentIds.has(sid)) errors.push({ entity: 'enrollments', row: i + 1, field: 'student_id', key: sid, message: `Enrollment references unknown student "${sid}".` });
    if (aid && !asgIds.has(aid)) errors.push({ entity: 'enrollments', row: i + 1, field: 'assignment_id', key: aid, message: `Enrollment references unknown assignment "${aid}".` });
  });

  return {
    ok: errors.length === 0,
    counts: { students: rows.students.length, guardians: rows.guardians.length, teachers: rows.teachers.length, teachingAssignments: rows.teachingAssignments.length, enrollments: rows.enrollments.length },
    errors, warnings,
  };
}
