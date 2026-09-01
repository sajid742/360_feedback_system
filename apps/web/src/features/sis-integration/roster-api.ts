import { apiClient } from '@/lib/api-client';

/**
 * Roster browse + maintenance. These endpoints sit alongside the existing
 * `/sis-integration/*` administration routes and read/write the same stored
 * snapshot, so anything corrected here is what parent feedback, bulk generation
 * and teacher mapping see on their next request.
 *
 * Reads need `sis.read` (Viewer included); writes need `organization.sis.manage`.
 */

/** Where a record came from, and what was corrected here. */
export interface LocalMeta {
  origin?: 'sis' | 'manual';
  localEdits?: string[];
  updatedLocallyAt?: string | null;
  updatedLocallyBy?: string | null;
}

export interface RosterStudent extends LocalMeta {
  id: string;
  registrationNo: string;
  rollNo: string;
  name: string;
  gender: string;
  status: string;
  campus?: string;
  program?: string;
  faculty?: string;
  department?: string;
  currentClass?: string;
  currentSection?: string;
  session?: string;
  semester?: string;
  dateOfBirth?: string | null;
  admissionDate?: string | null;
  guardianCount?: number;
  teacherCount?: number;
}

export interface RosterParent extends LocalMeta {
  id: string;
  studentId: string;
  name: string;
  relationship: string;
  mobile?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  preferredLanguage: string;
  active: boolean;
}

export interface RosterTeacherOfStudent {
  teacherId: string;
  teacher: string;
  subjectId: string;
  subject: string;
  teachingAssignmentId: string;
  section?: string;
}

export interface RosterEnrollment {
  id: string;
  teachingAssignmentId: string;
  teacher: string;
  subject: string;
  subjectCode?: string;
  gradeClass?: string;
  section?: string;
  session?: string;
  enrollmentDate?: string | null;
  status: string;
  origin?: 'sis' | 'manual';
}

export interface TeachingAssignment {
  id: string;
  teacherId: string;
  teacher: string;
  subjectId: string;
  subject: string;
  subjectCode?: string;
  gradeClass?: string;
  section?: string;
  session?: string;
  campus?: string;
  status: string;
}

export interface StudentPage {
  items: RosterStudent[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface StudentDetail {
  student: RosterStudent;
  parents: RosterParent[];
  teachers: RosterTeacherOfStudent[];
  enrollments: RosterEnrollment[];
}

export interface RosterOptions {
  campuses: string[];
  classes: string[];
  sections: string[];
  sessions: string[];
  semesters: string[];
  programs: string[];
  faculties: string[];
  departments: string[];
  counts: {
    students: number; manualStudents: number; editedStudents: number;
    guardians: number; manualGuardians: number;
    teachers: number; teachingAssignments: number; enrollments: number;
  };
}

const base = '/sis-integration/roster';

export const rosterApi = {
  students: (q: { search?: string; status?: string; campus?: string; origin?: string; page?: number; pageSize?: number }): Promise<StudentPage> =>
    apiClient.get(`${base}/students`, q as Record<string, string | number | undefined>),
  student: (id: string): Promise<StudentDetail> => apiClient.get(`${base}/students/${encodeURIComponent(id)}`),
  options: (): Promise<RosterOptions> => apiClient.get(`${base}/options`),
  teachingAssignments: (search?: string): Promise<TeachingAssignment[]> =>
    apiClient.get(`${base}/teaching-assignments`, search ? { search } : undefined),

  createStudent: (body: Partial<RosterStudent>): Promise<RosterStudent> => apiClient.post(`${base}/students`, body),
  updateStudent: (id: string, body: Partial<RosterStudent>): Promise<RosterStudent> =>
    apiClient.put(`${base}/students/${encodeURIComponent(id)}`, body),
  setStudentStatus: (id: string, status: 'active' | 'inactive'): Promise<RosterStudent> =>
    apiClient.post(`${base}/students/${encodeURIComponent(id)}/status`, { status }),

  createParent: (studentId: string, body: Partial<RosterParent>): Promise<RosterParent> =>
    apiClient.post(`${base}/students/${encodeURIComponent(studentId)}/parents`, body),
  updateParent: (parentId: string, body: Partial<RosterParent>): Promise<RosterParent> =>
    apiClient.put(`${base}/parents/${encodeURIComponent(parentId)}`, body),
  removeParent: (parentId: string): Promise<{ removed: boolean; deactivated: boolean; reason?: string }> =>
    apiClient.delete(`${base}/parents/${encodeURIComponent(parentId)}`),

  addEnrollment: (studentId: string, teachingAssignmentId: string): Promise<RosterEnrollment> =>
    apiClient.post(`${base}/students/${encodeURIComponent(studentId)}/enrollments`, { teachingAssignmentId }),
  removeEnrollment: (studentId: string, teachingAssignmentId: string): Promise<{ removed: boolean }> =>
    apiClient.delete(`${base}/students/${encodeURIComponent(studentId)}/enrollments/${encodeURIComponent(teachingAssignmentId)}`),
};
