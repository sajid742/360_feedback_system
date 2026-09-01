import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from './prisma.service';

type Row = Record<string, unknown>;

/**
 * Read model for the vendor SIS. All reads are raw SQL so the JSON shape is an
 * explicit part of the vendor contract (camelCase, resolved names) rather than
 * a leak of the internal table structure.
 */
@Injectable()
export class SisService {
  constructor(private readonly prisma: PrismaService) {}

  private q<T = Row>(sql: string, ...params: unknown[]): Promise<T[]> {
    return this.prisma.$queryRawUnsafe<T[]>(sql, ...params);
  }

  // -------------------- Academic structure --------------------
  campuses(): Promise<Row[]> {
    return this.q(`SELECT id, code, name, city, status FROM campuses ORDER BY name`);
  }
  faculties(): Promise<Row[]> {
    return this.q(`SELECT id, campus_id AS "campusId", code, name, status FROM faculties ORDER BY name`);
  }
  departments(): Promise<Row[]> {
    return this.q(`SELECT id, faculty_id AS "facultyId", code, name, status FROM departments ORDER BY name`);
  }
  programs(): Promise<Row[]> {
    return this.q(`SELECT id, department_id AS "departmentId", code, name, level, status FROM programs ORDER BY name`);
  }
  sessions(): Promise<Row[]> {
    return this.q(`SELECT id, code, name, start_date AS "startDate", end_date AS "endDate", status FROM academic_sessions ORDER BY code`);
  }
  semesters(): Promise<Row[]> {
    return this.q(`SELECT id, session_id AS "sessionId", code, name, term, status FROM semesters ORDER BY code`);
  }
  classes(): Promise<Row[]> {
    return this.q(`SELECT id, program_id AS "programId", code, name, status FROM classes ORDER BY name`);
  }
  sections(): Promise<Row[]> {
    return this.q(`SELECT id, grade_class_id AS "gradeClassId", code, name, capacity, status FROM sections ORDER BY name`);
  }

  // -------------------- Students & parents --------------------
  async students(campusId?: string, programId?: string, limit = 50, offset = 0): Promise<Row[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (campusId) { params.push(campusId); where.push(`s.campus_id = $${params.length}::uuid`); }
    if (programId) { params.push(programId); where.push(`s.program_id = $${params.length}::uuid`); }
    params.push(limit); const lim = params.length;
    params.push(offset); const off = params.length;
    return this.q(
      `SELECT s.id, s.registration_no AS "registrationNo", s.roll_no AS "rollNo", s.name, s.gender,
              s.status, p.name AS "program", c.name AS "campus", cl.name AS "currentClass", sec.name AS "currentSection"
       FROM students s
       LEFT JOIN programs p ON p.id = s.program_id
       LEFT JOIN campuses c ON c.id = s.campus_id
       LEFT JOIN classes cl ON cl.id = s.current_class_id
       LEFT JOIN sections sec ON sec.id = s.current_section_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY s.name LIMIT $${lim} OFFSET $${off}`,
      ...params,
    );
  }

  async studentDetails(id: string): Promise<Row> {
    const [row] = await this.q(
      `SELECT s.id, s.registration_no AS "registrationNo", s.roll_no AS "rollNo", s.name, s.gender,
              s.date_of_birth AS "dateOfBirth", s.admission_date AS "admissionDate", s.status,
              p.name AS "program", c.name AS "campus", f.name AS "faculty", d.name AS "department",
              cl.name AS "currentClass", sec.name AS "currentSection", ses.name AS "session", sem.name AS "semester"
       FROM students s
       LEFT JOIN programs p ON p.id = s.program_id
       LEFT JOIN campuses c ON c.id = s.campus_id
       LEFT JOIN faculties f ON f.id = s.faculty_id
       LEFT JOIN departments d ON d.id = s.department_id
       LEFT JOIN classes cl ON cl.id = s.current_class_id
       LEFT JOIN sections sec ON sec.id = s.current_section_id
       LEFT JOIN academic_sessions ses ON ses.id = s.session_id
       LEFT JOIN semesters sem ON sem.id = s.semester_id
       WHERE s.id = $1::uuid`,
      id,
    );
    if (!row) throw new NotFoundException('Student not found.');
    return row;
  }

  parentsOfStudent(studentId: string): Promise<Row[]> {
    return this.q(
      `SELECT id, student_id AS "studentId", name, relationship, mobile, whatsapp, email,
              preferred_language AS "preferredLanguage", active
       FROM parents WHERE student_id = $1::uuid AND active = true ORDER BY relationship`,
      studentId,
    );
  }

  // -------------------- Teachers & subjects --------------------
  teachers(): Promise<Row[]> {
    return this.q(
      `SELECT t.id, t.employee_code AS "employeeCode", t.name, t.designation, t.mobile, t.email, t.status,
              d.name AS "department", f.name AS "faculty"
       FROM teachers t LEFT JOIN departments d ON d.id = t.department_id LEFT JOIN faculties f ON f.id = t.faculty_id
       ORDER BY t.name`,
    );
  }

  async teacherDetails(id: string): Promise<Row> {
    const [row] = await this.teachersWhere(`t.id = $1::uuid`, id);
    if (!row) throw new NotFoundException('Teacher not found.');
    return row;
  }
  private teachersWhere(clause: string, ...params: unknown[]): Promise<Row[]> {
    return this.q(
      `SELECT t.id, t.employee_code AS "employeeCode", t.name, t.designation, t.mobile, t.email, t.status,
              d.name AS "department", f.name AS "faculty"
       FROM teachers t LEFT JOIN departments d ON d.id = t.department_id LEFT JOIN faculties f ON f.id = t.faculty_id
       WHERE ${clause}`,
      ...params,
    );
  }

  subjects(): Promise<Row[]> {
    return this.q(
      `SELECT s.id, s.code, s.name, s.credit_hours AS "creditHours", s.status,
              d.name AS "department", p.name AS "program"
       FROM subjects s LEFT JOIN departments d ON d.id = s.department_id LEFT JOIN programs p ON p.id = s.program_id
       ORDER BY s.code`,
    );
  }

  // -------------------- Teaching assignments & enrollments --------------------
  private assignmentSelect = `
    SELECT ta.id, ta.status, ta.start_date AS "startDate", ta.end_date AS "endDate",
           t.id AS "teacherId", t.name AS "teacher", t.employee_code AS "employeeCode",
           sub.id AS "subjectId", sub.name AS "subject", sub.code AS "subjectCode",
           ses.name AS "session", sem.name AS "semester", cmp.name AS "campus",
           prog.name AS "program", cl.name AS "gradeClass", sec.name AS "section"
    FROM teaching_assignments ta
    LEFT JOIN teachers t ON t.id = ta.teacher_id
    LEFT JOIN subjects sub ON sub.id = ta.subject_id
    LEFT JOIN academic_sessions ses ON ses.id = ta.session_id
    LEFT JOIN semesters sem ON sem.id = ta.semester_id
    LEFT JOIN campuses cmp ON cmp.id = ta.campus_id
    LEFT JOIN programs prog ON prog.id = ta.program_id
    LEFT JOIN classes cl ON cl.id = ta.grade_class_id
    LEFT JOIN sections sec ON sec.id = ta.section_id`;

  async teachingAssignments(teacherId?: string, subjectId?: string, sessionId?: string): Promise<Row[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (teacherId) { params.push(teacherId); where.push(`ta.teacher_id = $${params.length}::uuid`); }
    if (subjectId) { params.push(subjectId); where.push(`ta.subject_id = $${params.length}::uuid`); }
    if (sessionId) { params.push(sessionId); where.push(`ta.session_id = $${params.length}::uuid`); }
    return this.q(`${this.assignmentSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.name, sub.code`, ...params);
  }

  async teachingAssignmentDetails(id: string): Promise<Row> {
    const [row] = await this.q(`${this.assignmentSelect} WHERE ta.id = $1::uuid`, id);
    if (!row) throw new NotFoundException('Teaching assignment not found.');
    return row;
  }

  teacherAssignments(teacherId: string): Promise<Row[]> {
    return this.teachingAssignments(teacherId);
  }

  studentEnrollments(studentId: string): Promise<Row[]> {
    return this.q(
      `SELECT e.id, e.enrollment_date AS "enrollmentDate", e.status,
              ta.id AS "teachingAssignmentId", t.name AS "teacher", sub.name AS "subject", sub.code AS "subjectCode",
              cl.name AS "gradeClass", sec.name AS "section", ses.name AS "session"
       FROM student_enrollments e
       JOIN teaching_assignments ta ON ta.id = e.teaching_assignment_id
       LEFT JOIN teachers t ON t.id = ta.teacher_id
       LEFT JOIN subjects sub ON sub.id = ta.subject_id
       LEFT JOIN classes cl ON cl.id = ta.grade_class_id
       LEFT JOIN sections sec ON sec.id = ta.section_id
       LEFT JOIN academic_sessions ses ON ses.id = ta.session_id
       WHERE e.student_id = $1::uuid ORDER BY sub.code`,
      studentId,
    );
  }

  /** Distinct students taught by a teacher (resolved through enrollments). */
  studentsOfTeacher(teacherId: string): Promise<Row[]> {
    return this.q(
      `SELECT DISTINCT s.id, s.registration_no AS "registrationNo", s.name, sub.name AS "subject", sec.name AS "section"
       FROM student_enrollments e
       JOIN teaching_assignments ta ON ta.id = e.teaching_assignment_id
       JOIN students s ON s.id = e.student_id
       LEFT JOIN subjects sub ON sub.id = ta.subject_id
       LEFT JOIN sections sec ON sec.id = ta.section_id
       WHERE ta.teacher_id = $1::uuid ORDER BY s.name`,
      teacherId,
    );
  }

  /** Distinct students studying a subject (across teachers/sections). */
  studentsBySubject(subjectId: string): Promise<Row[]> {
    return this.q(
      `SELECT DISTINCT s.id, s.registration_no AS "registrationNo", s.name, t.name AS "teacher", sec.name AS "section"
       FROM student_enrollments e
       JOIN teaching_assignments ta ON ta.id = e.teaching_assignment_id
       JOIN students s ON s.id = e.student_id
       LEFT JOIN teachers t ON t.id = ta.teacher_id
       LEFT JOIN sections sec ON sec.id = ta.section_id
       WHERE ta.subject_id = $1::uuid ORDER BY s.name`,
      subjectId,
    );
  }

  /** Distinct teachers teaching a student, with the subject each teaches them. */
  teachersOfStudent(studentId: string): Promise<Row[]> {
    return this.q(
      `SELECT DISTINCT t.id AS "teacherId", t.name AS "teacher", sub.id AS "subjectId", sub.name AS "subject",
              ta.id AS "teachingAssignmentId", sec.name AS "section"
       FROM student_enrollments e
       JOIN teaching_assignments ta ON ta.id = e.teaching_assignment_id
       JOIN teachers t ON t.id = ta.teacher_id
       LEFT JOIN subjects sub ON sub.id = ta.subject_id
       LEFT JOIN sections sec ON sec.id = ta.section_id
       WHERE e.student_id = $1::uuid ORDER BY t.name`,
      studentId,
    );
  }
}
