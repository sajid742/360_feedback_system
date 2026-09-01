import { NotFoundException } from '@nestjs/common';
import type { SisProvider } from '../sis/sis-provider.interface';
import type {
  SisAssignmentQuery, SisEnrollment, SisParent, SisRef, SisStudent, SisStudentQuery,
  SisStudentSummary, SisSubject, SisTeacher, SisTeacherOfStudent, SisTeachingAssignment,
} from '../sis/sis.types';
import type { SisSnapshot } from './sis-snapshot.types';

/**
 * Serves the EXISTING `SisProvider` interface entirely from an in-memory snapshot
 * (a tenant's persisted SIS dataset). This is the bridge that lets Internal /
 * Excel-CSV / Generic / OneRoster data flow through every existing SIS consumer —
 * the SIS browse API, teacher↔employee identity mapping, bulk generation, and the
 * parent-feedback workflow — with no change to any of them. Read-only and pure.
 */
export class StoredSisProvider implements SisProvider {
  constructor(private readonly snap: SisSnapshot) {}

  private summary(s: SisStudent): SisStudentSummary {
    return {
      id: s.id, registrationNo: s.registrationNo, rollNo: s.rollNo, name: s.name, gender: s.gender,
      status: s.status, program: s.program, campus: s.campus, currentClass: s.currentClass, currentSection: s.currentSection,
    };
  }

  async getCampuses(): Promise<SisRef[]> { return this.snap.campuses; }
  async getFaculties(): Promise<SisRef[]> { return this.snap.faculties; }
  async getDepartments(): Promise<SisRef[]> { return this.snap.departments; }
  async getPrograms(): Promise<SisRef[]> { return this.snap.programs; }
  async getSessions(): Promise<SisRef[]> { return this.snap.sessions; }
  async getSemesters(): Promise<SisRef[]> { return this.snap.semesters; }
  async getClasses(): Promise<SisRef[]> { return this.snap.classes; }
  async getSections(): Promise<SisRef[]> { return this.snap.sections; }

  async getStudents(query?: SisStudentQuery): Promise<SisStudentSummary[]> {
    let rows = this.snap.students;
    if (query?.campusId) rows = rows.filter((s) => s.campus === query.campusId || (s as unknown as Record<string, unknown>).campusId === query.campusId);
    if (query?.programId) rows = rows.filter((s) => s.program === query.programId || (s as unknown as Record<string, unknown>).programId === query.programId);
    if (query?.search) {
      const needle = query.search.trim().toLowerCase();
      if (needle) {
        rows = rows.filter((s) =>
          s.name?.toLowerCase().includes(needle) ||
          s.registrationNo?.toLowerCase().includes(needle) ||
          s.rollNo?.toLowerCase().includes(needle));
      }
    }
    const offset = query?.offset ?? 0;
    const limit = query?.limit ?? rows.length;
    return rows.slice(offset, offset + limit).map((s) => this.summary(s));
  }

  async getStudent(id: string): Promise<SisStudent> {
    const s = this.snap.students.find((x) => x.id === id || x.registrationNo === id);
    if (!s) throw new NotFoundException('Student not found in SIS.');
    return s;
  }

  async getParentsOfStudent(studentId: string): Promise<SisParent[]> {
    return this.snap.parents.filter((p) => p.studentId === studentId);
  }

  async getTeachers(): Promise<SisTeacher[]> { return this.snap.teachers; }

  async getTeacher(id: string): Promise<SisTeacher> {
    const t = this.snap.teachers.find((x) => x.id === id || x.employeeCode === id);
    if (!t) throw new NotFoundException('Teacher not found in SIS.');
    return t;
  }

  async getSubjects(): Promise<SisSubject[]> { return this.snap.subjects; }

  async getTeachingAssignments(query?: SisAssignmentQuery): Promise<SisTeachingAssignment[]> {
    let rows = this.snap.teachingAssignments;
    if (query?.teacherId) rows = rows.filter((a) => a.teacherId === query.teacherId);
    if (query?.subjectId) rows = rows.filter((a) => a.subjectId === query.subjectId);
    if (query?.sessionId) rows = rows.filter((a) => a.session === query.sessionId);
    return rows;
  }

  async getTeachingAssignment(id: string): Promise<SisTeachingAssignment> {
    const a = this.snap.teachingAssignments.find((x) => x.id === id);
    if (!a) throw new NotFoundException('Teaching assignment not found in SIS.');
    return a;
  }

  async getTeacherAssignments(teacherId: string): Promise<SisTeachingAssignment[]> {
    return this.snap.teachingAssignments.filter((a) => a.teacherId === teacherId);
  }

  async getStudentEnrollments(studentId: string): Promise<SisEnrollment[]> {
    return this.snap.enrollments.filter((e) => e.studentId === studentId).map(({ studentId: _omit, ...rest }) => rest);
  }

  async getStudentsOfTeacher(teacherId: string): Promise<SisStudentSummary[]> {
    const asgIds = new Set(this.snap.teachingAssignments.filter((a) => a.teacherId === teacherId).map((a) => a.id));
    const studentIds = new Set(this.snap.enrollments.filter((e) => asgIds.has(e.teachingAssignmentId)).map((e) => e.studentId));
    return this.snap.students.filter((s) => studentIds.has(s.id)).map((s) => this.summary(s));
  }

  async getStudentsBySubject(subjectId: string): Promise<SisStudentSummary[]> {
    const asgIds = new Set(this.snap.teachingAssignments.filter((a) => a.subjectId === subjectId).map((a) => a.id));
    const studentIds = new Set(this.snap.enrollments.filter((e) => asgIds.has(e.teachingAssignmentId)).map((e) => e.studentId));
    return this.snap.students.filter((s) => studentIds.has(s.id)).map((s) => this.summary(s));
  }

  async getTeachersOfStudent(studentId: string): Promise<SisTeacherOfStudent[]> {
    const asgIds = new Set(this.snap.enrollments.filter((e) => e.studentId === studentId).map((e) => e.teachingAssignmentId));
    return this.snap.teachingAssignments
      .filter((a) => asgIds.has(a.id))
      .map((a) => ({ teacherId: a.teacherId, teacher: a.teacher, subjectId: a.subjectId, subject: a.subject, teachingAssignmentId: a.id, section: a.section }));
  }
}
