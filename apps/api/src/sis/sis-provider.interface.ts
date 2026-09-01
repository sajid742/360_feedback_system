import type {
  SisAssignmentQuery,
  SisEnrollment,
  SisParent,
  SisRef,
  SisStudent,
  SisStudentQuery,
  SisStudentSummary,
  SisSubject,
  SisTeacher,
  SisTeacherOfStudent,
  SisTeachingAssignment,
} from './sis.types';

/**
 * The SIS integration boundary. The 360 Feedback System's business logic
 * depends ONLY on this interface. To replace the Mock SIS with a real Student
 * Information System, an ERP, or another vendor, implement this interface in a
 * new provider and bind it in SisModule — nothing else in the 360 app changes.
 */
export interface SisProvider {
  // Academic structure
  getCampuses(): Promise<SisRef[]>;
  getFaculties(): Promise<SisRef[]>;
  getDepartments(): Promise<SisRef[]>;
  getPrograms(): Promise<SisRef[]>;
  getSessions(): Promise<SisRef[]>;
  getSemesters(): Promise<SisRef[]>;
  getClasses(): Promise<SisRef[]>;
  getSections(): Promise<SisRef[]>;

  // Students & parents
  getStudents(query?: SisStudentQuery): Promise<SisStudentSummary[]>;
  getStudent(id: string): Promise<SisStudent>;
  getParentsOfStudent(studentId: string): Promise<SisParent[]>;

  // Teachers & subjects
  getTeachers(): Promise<SisTeacher[]>;
  getTeacher(id: string): Promise<SisTeacher>;
  getSubjects(): Promise<SisSubject[]>;

  // Teaching relationship
  getTeachingAssignments(query?: SisAssignmentQuery): Promise<SisTeachingAssignment[]>;
  getTeachingAssignment(id: string): Promise<SisTeachingAssignment>;
  getTeacherAssignments(teacherId: string): Promise<SisTeachingAssignment[]>;
  getStudentEnrollments(studentId: string): Promise<SisEnrollment[]>;
  getStudentsOfTeacher(teacherId: string): Promise<SisStudentSummary[]>;
  getStudentsBySubject(subjectId: string): Promise<SisStudentSummary[]>;
  getTeachersOfStudent(studentId: string): Promise<SisTeacherOfStudent[]>;
}

/** DI token for the active SIS provider. */
export const SIS_PROVIDER = Symbol('SIS_PROVIDER');
