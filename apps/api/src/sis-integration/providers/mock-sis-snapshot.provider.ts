import { Injectable } from '@nestjs/common';
import type { SisSnapshot } from '../sis-snapshot.types';
import type { SisSnapshotProvider } from './sis-snapshot-provider';
import { buildSnapshot, emptyRows, type SisRawRows } from './snapshot-builder';

/**
 * Self-contained sample SIS — the whole Student integration works locally with NO
 * external system. Teachers use employee codes (E1000/E1001) that match the sample
 * 360 employees, so the import auto-links them for parent feedback. A `scenario`
 * option exercises the sync's create/update/deactivate paths:
 *   - 'full'    (default): the whole roster.
 *   - 'reduced':           drops student S1004 (→ deactivate) and moves S1002 to
 *                          section B (→ update).
 */
@Injectable()
export class MockSisSnapshotProvider implements SisSnapshotProvider {
  /*
   * NAMED CAREFULLY. There are two different things a deployment may call "Mock
   * SIS" and they hold different data:
   *   - THIS one: a small fixed roster compiled into the API, used to demonstrate
   *     and test the sync path without any external system.
   *   - The standalone Mock SIS SERVICE: a separate NestJS app with its own
   *     database and admin page (port 3100), which exists to exercise the vendor
   *     HTTP connector.
   * Whichever is synced from, what the 360 app reads is the stored snapshot.
   *
   * Its student ids (S1001–S1004) are deliberately generic and CAN collide with a
   * roster seeded elsewhere. A sync that would rename or deactivate records is now
   * withheld pending confirmation (see SisSyncService.apply), so the collision is
   * visible before it applies rather than after.
   */
  readonly name = 'Sample roster (built-in demo data)';

  async getSnapshot(_organizationId: string, options?: Record<string, unknown>): Promise<SisSnapshot> {
    const reduced = String(options?.scenario ?? 'full') === 'reduced';
    const rows: SisRawRows = emptyRows();

    rows.teachers = [
      { teacher_id: 'T100', employee_code: 'E1000', name: 'Imran Farooqi', designation: 'Senior Teacher', department: 'Science', faculty: 'Faculty of Science', email: 'imran.farooqi@carepvtltd.com', status: 'active' },
      { teacher_id: 'T101', employee_code: 'E1001', name: 'Bilal Ahmed', designation: 'Teacher', department: 'Mathematics', faculty: 'Faculty of Science', email: 'bilal.ahmed@carepvtltd.com', status: 'active' },
    ];
    rows.teachingAssignments = [
      { assignment_id: 'TA1', teacher_id: 'T100', subject_id: 'PHY9', subject_name: 'Physics', subject_code: 'PHY-9', class: 'Grade 9', section: 'A', session: '2025-2026', semester: 'Term 1', campus: 'CARE Taxila Campus', program: 'Science', status: 'active' },
      { assignment_id: 'TA2', teacher_id: 'T101', subject_id: 'MTH9', subject_name: 'Mathematics', subject_code: 'MTH-9', class: 'Grade 9', section: 'A', session: '2025-2026', semester: 'Term 1', campus: 'CARE Taxila Campus', program: 'Science', status: 'active' },
      { assignment_id: 'TA3', teacher_id: 'T100', subject_id: 'PHY10', subject_name: 'Physics', subject_code: 'PHY-10', class: 'Grade 10', section: 'B', session: '2025-2026', semester: 'Term 1', campus: 'CARE Wah Cantt Campus', program: 'Science', status: 'active' },
    ];
    rows.students = [
      { student_id: 'S1001', name: 'Ahmed Ali', gender: 'Male', class: 'Grade 9', section: 'A', campus: 'CARE Taxila Campus', department: 'Science', session: '2025-2026', status: 'active', parent_name: 'Imran Ali', parent_mobile: '+923001112221', parent_whatsapp: '+923001112221', parent_email: 'imran.ali@gmail.com' },
      { student_id: 'S1002', name: 'Fatima Noor', gender: 'Female', class: 'Grade 9', section: reduced ? 'B' : 'A', campus: 'CARE Taxila Campus', department: 'Science', session: '2025-2026', status: 'active', parent_name: 'Noor Ahmed', parent_mobile: '+923002223332', parent_whatsapp: '+923002223332', parent_email: 'noor.ahmed@gmail.com' },
      { student_id: 'S1003', name: 'Hassan Raza', gender: 'Male', class: 'Grade 10', section: 'B', campus: 'CARE Wah Cantt Campus', department: 'Science', session: '2025-2026', status: 'active', parent_name: 'Raza Khan', parent_mobile: '+923003334443', parent_whatsapp: '+923003334443', parent_email: 'raza.khan@gmail.com' },
      ...(reduced ? [] : [{ student_id: 'S1004', name: 'Ayesha Malik', gender: 'Female', class: 'Grade 9', section: 'A', campus: 'CARE Taxila Campus', department: 'Science', session: '2025-2026', status: 'active', parent_name: 'Malik Sahib', parent_mobile: '+923004445554', parent_whatsapp: '+923004445554', parent_email: 'malik@gmail.com' }]),
    ];
    rows.guardians = [
      { student_id: 'S1001', name: 'Sana Ali', relationship: 'Mother', mobile: '+923001112229', whatsapp: '+923001112229', email: 'sana.ali@gmail.com', language: 'en', status: 'active' },
    ];
    rows.enrollments = [
      { student_id: 'S1001', assignment_id: 'TA1', status: 'active' },
      { student_id: 'S1001', assignment_id: 'TA2', status: 'active' },
      { student_id: 'S1002', assignment_id: 'TA1', status: 'active' },
      { student_id: 'S1003', assignment_id: 'TA3', status: 'active' },
      ...(reduced ? [] : [{ student_id: 'S1004', assignment_id: 'TA2', status: 'active' }]),
    ];

    return buildSnapshot(rows);
  }
}
