import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { SisProvider } from '../sis-provider.interface';
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
} from '../sis.types';

/**
 * Talks to the Mock SIS vendor API over HTTP. This is the ONLY place that knows
 * the vendor's URL, credential and envelope. A production SIS or ERP would be a
 * sibling provider implementing the same SisProvider interface.
 *
 * Config (env): SIS_BASE_URL (default http://localhost:3100/api/v1), SIS_API_KEY.
 */
@Injectable()
export class MockSisProvider implements SisProvider {
  private readonly logger = new Logger(MockSisProvider.name);
  private readonly baseUrl = (process.env.SIS_BASE_URL ?? 'http://localhost:3100/api/v1').replace(/\/+$/, '');
  private readonly apiKey = process.env.SIS_API_KEY ?? 'mock-sis-dev-key-change-me';

  private async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const qs = query
      ? '?' +
        Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')
      : '';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(`${this.baseUrl}${path}${qs}`, {
        headers: { 'x-api-key': this.apiKey, accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`SIS responded ${res.status} for ${path}`);
      const json = (await res.json()) as { data: T };
      return json.data;
    } catch (error) {
      this.logger.error(`SIS request failed: ${(error as Error).message}`);
      throw new ServiceUnavailableException('The Student Information System is unavailable.');
    } finally {
      clearTimeout(timeout);
    }
  }

  getCampuses = (): Promise<SisRef[]> => this.get('/campuses');
  getFaculties = (): Promise<SisRef[]> => this.get('/faculties');
  getDepartments = (): Promise<SisRef[]> => this.get('/departments');
  getPrograms = (): Promise<SisRef[]> => this.get('/programs');
  getSessions = (): Promise<SisRef[]> => this.get('/sessions');
  getSemesters = (): Promise<SisRef[]> => this.get('/semesters');
  getClasses = (): Promise<SisRef[]> => this.get('/classes');
  getSections = (): Promise<SisRef[]> => this.get('/sections');

  getStudents = (query?: SisStudentQuery): Promise<SisStudentSummary[]> =>
    this.get('/students', { campusId: query?.campusId, programId: query?.programId, search: query?.search, limit: query?.limit, offset: query?.offset });
  getStudent = (id: string): Promise<SisStudent> => this.get(`/students/${id}`);
  getParentsOfStudent = (studentId: string): Promise<SisParent[]> => this.get(`/students/${studentId}/parents`);

  getTeachers = (): Promise<SisTeacher[]> => this.get('/teachers');
  getTeacher = (id: string): Promise<SisTeacher> => this.get(`/teachers/${id}`);
  getSubjects = (): Promise<SisSubject[]> => this.get('/subjects');

  getTeachingAssignments = (query?: SisAssignmentQuery): Promise<SisTeachingAssignment[]> =>
    this.get('/teaching-assignments', { teacherId: query?.teacherId, subjectId: query?.subjectId, sessionId: query?.sessionId });
  getTeachingAssignment = (id: string): Promise<SisTeachingAssignment> => this.get(`/teaching-assignments/${id}`);
  getTeacherAssignments = (teacherId: string): Promise<SisTeachingAssignment[]> => this.get(`/teachers/${teacherId}/assignments`);
  getStudentEnrollments = (studentId: string): Promise<SisEnrollment[]> => this.get(`/students/${studentId}/enrollments`);
  getStudentsOfTeacher = (teacherId: string): Promise<SisStudentSummary[]> => this.get(`/teachers/${teacherId}/students`);
  getStudentsBySubject = (subjectId: string): Promise<SisStudentSummary[]> => this.get(`/subjects/${subjectId}/students`);
  getTeachersOfStudent = (studentId: string): Promise<SisTeacherOfStudent[]> => this.get(`/students/${studentId}/teachers`);
}
