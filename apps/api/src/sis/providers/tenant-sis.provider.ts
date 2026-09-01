import { Injectable } from '@nestjs/common';
import { currentOrgId, requestCached } from '../../common/context/request-context';
import { SisDatasetService } from '../../sis-integration/sis-dataset.service';
import { StoredSisProvider } from '../../sis-integration/stored-sis.provider';
import type { SisProvider } from '../sis-provider.interface';
import type {
  SisAssignmentQuery, SisEnrollment, SisParent, SisRef, SisStudent, SisStudentQuery,
  SisStudentSummary, SisSubject, SisTeacher, SisTeacherOfStudent, SisTeachingAssignment,
} from '../sis.types';
import { MockSisProvider } from './mock-sis.provider';

/**
 * The bound `SIS_PROVIDER`. For each call it resolves the CURRENT tenant (from the
 * per-request context) and, if that org has a synced/imported SIS dataset, serves it
 * from the stored snapshot; otherwise it falls back to the legacy provider (Mock SIS
 * over HTTP) exactly as before. This is what lets Internal / Excel-CSV / Generic /
 * OneRoster data flow into every existing SIS consumer — SIS browse, teacher↔employee
 * mapping, bulk generation, and parent feedback — with ZERO changes to those consumers.
 */
@Injectable()
export class TenantSisProvider implements SisProvider {
  constructor(private readonly datasets: SisDatasetService, private readonly legacy: MockSisProvider) {}

  /**
   * Resolve the provider for the current tenant.
   *
   * Performance (F-P2): this used to re-read the org's ENTIRE roster snapshot from
   * the database — one JSON blob holding every student, guardian, teacher and
   * enrolment — and rebuild a StoredSisProvider on EVERY method call. Bulk parent
   * generation calls the interface once per teacher and again per student, so a
   * single request could reload the whole roster thousands of times. The resolved
   * provider is now memoised for the lifetime of the request, so it loads once.
   * Nothing is cached across requests, so a fresh sync is picked up immediately.
   */
  private async delegate(): Promise<SisProvider> {
    const orgId = currentOrgId();
    if (!orgId) return this.legacy;
    return requestCached(`sis-provider:${orgId}`, async () => {
      const snap = await this.datasets.get(orgId);
      return snap ? new StoredSisProvider(snap) : (this.legacy as SisProvider);
    });
  }

  async getCampuses(): Promise<SisRef[]> { return (await this.delegate()).getCampuses(); }
  async getFaculties(): Promise<SisRef[]> { return (await this.delegate()).getFaculties(); }
  async getDepartments(): Promise<SisRef[]> { return (await this.delegate()).getDepartments(); }
  async getPrograms(): Promise<SisRef[]> { return (await this.delegate()).getPrograms(); }
  async getSessions(): Promise<SisRef[]> { return (await this.delegate()).getSessions(); }
  async getSemesters(): Promise<SisRef[]> { return (await this.delegate()).getSemesters(); }
  async getClasses(): Promise<SisRef[]> { return (await this.delegate()).getClasses(); }
  async getSections(): Promise<SisRef[]> { return (await this.delegate()).getSections(); }
  async getStudents(query?: SisStudentQuery): Promise<SisStudentSummary[]> { return (await this.delegate()).getStudents(query); }
  async getStudent(id: string): Promise<SisStudent> { return (await this.delegate()).getStudent(id); }
  async getParentsOfStudent(studentId: string): Promise<SisParent[]> { return (await this.delegate()).getParentsOfStudent(studentId); }
  async getTeachers(): Promise<SisTeacher[]> { return (await this.delegate()).getTeachers(); }
  async getTeacher(id: string): Promise<SisTeacher> { return (await this.delegate()).getTeacher(id); }
  async getSubjects(): Promise<SisSubject[]> { return (await this.delegate()).getSubjects(); }
  async getTeachingAssignments(query?: SisAssignmentQuery): Promise<SisTeachingAssignment[]> { return (await this.delegate()).getTeachingAssignments(query); }
  async getTeachingAssignment(id: string): Promise<SisTeachingAssignment> { return (await this.delegate()).getTeachingAssignment(id); }
  async getTeacherAssignments(teacherId: string): Promise<SisTeachingAssignment[]> { return (await this.delegate()).getTeacherAssignments(teacherId); }
  async getStudentEnrollments(studentId: string): Promise<SisEnrollment[]> { return (await this.delegate()).getStudentEnrollments(studentId); }
  async getStudentsOfTeacher(teacherId: string): Promise<SisStudentSummary[]> { return (await this.delegate()).getStudentsOfTeacher(teacherId); }
  async getStudentsBySubject(subjectId: string): Promise<SisStudentSummary[]> { return (await this.delegate()).getStudentsBySubject(subjectId); }
  async getTeachersOfStudent(studentId: string): Promise<SisTeacherOfStudent[]> { return (await this.delegate()).getTeachersOfStudent(studentId); }
}
