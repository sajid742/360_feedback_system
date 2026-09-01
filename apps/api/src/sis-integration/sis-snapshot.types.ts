import type {
  SisEnrollment, SisLocalMeta, SisParent, SisRef, SisStudent, SisSubject, SisTeacher, SisTeachingAssignment,
} from '../sis/sis.types';

/** An enrollment inside a snapshot also records WHICH student it belongs to
 *  (the public SisEnrollment is always returned in a per-student context). */
export interface SisSnapshotEnrollment extends SisEnrollment, SisLocalMeta {
  studentId: string;
}

/**
 * A full, self-contained SIS roster snapshot. Every provider (Mock, Excel/CSV,
 * Generic, OneRoster) produces one of these; the import engine persists it per
 * organization; and `StoredSisProvider` serves the EXISTING `SisProvider`
 * interface from it. Nothing else in the 360 app depends on this shape — the
 * business logic only ever sees `SisProvider`.
 */
export interface SisSnapshot {
  campuses: SisRef[];
  faculties: SisRef[];
  departments: SisRef[];
  programs: SisRef[];
  sessions: SisRef[];
  semesters: SisRef[];
  classes: SisRef[];
  sections: SisRef[];
  subjects: SisSubject[];
  teachers: SisTeacher[];
  students: SisStudent[];
  /** Guardians/parents — a student may have several. */
  parents: SisParent[];
  teachingAssignments: SisTeachingAssignment[];
  enrollments: SisSnapshotEnrollment[];
}

export function emptySnapshot(): SisSnapshot {
  return {
    campuses: [], faculties: [], departments: [], programs: [], sessions: [], semesters: [],
    classes: [], sections: [], subjects: [], teachers: [], students: [], parents: [],
    teachingAssignments: [], enrollments: [],
  };
}
