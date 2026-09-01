/**
 * The stable SIS domain contract the 360 Feedback System depends on. Whatever
 * the underlying source (Mock SIS, a production SIS, an ERP), its adapter maps
 * the vendor's shape into THESE types — so the 360 business logic never changes.
 */

/**
 * Provenance for a roster record, so the UI can say where a value came from and
 * so a provider sync knows what it must NOT overwrite.
 *
 *   origin 'sis'    — arrived from an import or a provider sync (the default; a
 *                     record with no `origin` at all is treated as 'sis', which is
 *                     what every snapshot written before this existed looks like).
 *   origin 'manual' — created by an administrator inside this application. A sync
 *                     never updates or deactivates it, because the external system
 *                     has never heard of it.
 *   localEdits      — field names an administrator corrected by hand on an IMPORTED
 *                     record. `SisSyncService.reconcile()` re-applies the incoming
 *                     values to every other field and leaves these alone, so a
 *                     correction survives the next sync instead of being silently
 *                     undone.
 *
 * All three are optional and additive: they live inside the existing
 * `sis_datasets.snapshot` JSON, so no table or column was added for them.
 */
export interface SisLocalMeta {
  origin?: 'sis' | 'manual';
  localEdits?: string[];
  updatedLocallyAt?: string | null;
  updatedLocallyBy?: string | null;
}

export interface SisRef {
  id: string;
  code: string;
  name: string;
  [extra: string]: unknown;
}

export interface SisStudentSummary {
  id: string;
  registrationNo: string;
  rollNo: string;
  name: string;
  gender: string;
  status: string;
  program?: string;
  campus?: string;
  currentClass?: string;
  currentSection?: string;
}

export interface SisStudent extends SisStudentSummary, SisLocalMeta {
  dateOfBirth?: string | null;
  admissionDate?: string | null;
  faculty?: string;
  department?: string;
  session?: string;
  semester?: string;
}

export interface SisParent extends SisLocalMeta {
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

export interface SisTeacher extends SisLocalMeta {
  id: string;
  employeeCode: string;
  name: string;
  designation: string;
  department?: string;
  faculty?: string;
  mobile?: string | null;
  email?: string | null;
  status: string;
}

export interface SisSubject {
  id: string;
  code: string;
  name: string;
  department?: string;
  program?: string;
  creditHours: number;
  status: string;
}

export interface SisTeachingAssignment {
  id: string;
  teacherId: string;
  teacher: string;
  subjectId: string;
  subject: string;
  subjectCode?: string;
  session?: string;
  semester?: string;
  campus?: string;
  program?: string;
  gradeClass?: string;
  section?: string;
  startDate?: string | null;
  endDate?: string | null;
  status: string;
}

export interface SisEnrollment {
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
}

export interface SisTeacherOfStudent {
  teacherId: string;
  teacher: string;
  subjectId: string;
  subject: string;
  teachingAssignmentId: string;
  section?: string;
}

export interface SisStudentQuery {
  campusId?: string;
  programId?: string;
  limit?: number;
  offset?: number;
  /** Free text over name, registration number and roll number. */
  search?: string;
}

export interface SisAssignmentQuery {
  teacherId?: string;
  subjectId?: string;
  sessionId?: string;
}
