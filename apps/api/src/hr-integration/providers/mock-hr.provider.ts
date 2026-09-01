import { Injectable } from '@nestjs/common';
import type { HrEmployee, HrProvider, HrSnapshot } from '../hr-provider.interface';

/**
 * In-memory HR provider for local development and testing — the feature works
 * with NO real HR system. Returns a small, self-consistent org (Pakistani names)
 * with a manager hierarchy. A `scenario` option lets tests exercise the sync's
 * create / update / deactivate paths without any external dependency:
 *   - 'full'    (default): the whole roster (first sync → all created).
 *   - 'reduced':           HRE006 is removed (→ deactivated) and HRE003 is
 *                          promoted + moved (→ updated).
 */
@Injectable()
export class MockHrProvider implements HrProvider {
  readonly name = 'Mock HR (built-in)';

  async getSnapshot(_organizationId: string, options?: Record<string, unknown>): Promise<HrSnapshot> {
    const scenario = String(options?.scenario ?? 'full');
    const reduced = scenario === 'reduced';

    const employees: HrEmployee[] = [
      { externalId: 'HRX-001', employeeCode: 'HRE001', fullName: 'Tariq Mehmood', email: 'tariq.mehmood@carepvtltd.com', departmentExternalId: 'HRD1', designationExternalId: 'HRG1', campusExternalId: 'HRC1', managerExternalId: null, status: 'active' },
      { externalId: 'HRX-002', employeeCode: 'HRE002', fullName: 'Ayesha Noor', email: 'ayesha.noor@carepvtltd.com', departmentExternalId: 'HRD2', designationExternalId: 'HRG2', campusExternalId: 'HRC1', managerExternalId: 'HRX-001', status: 'active' },
      {
        externalId: 'HRX-003', employeeCode: 'HRE003', fullName: 'Bilal Hussain', email: 'bilal.hussain@carepvtltd.com',
        // reduced scenario promotes Bilal to Manager and moves him to Sales.
        departmentExternalId: reduced ? 'HRD3' : 'HRD2', designationExternalId: reduced ? 'HRG2' : 'HRG3',
        campusExternalId: reduced ? 'HRC2' : 'HRC1', managerExternalId: reduced ? 'HRX-001' : 'HRX-002', status: 'active',
      },
      { externalId: 'HRX-004', employeeCode: 'HRE004', fullName: 'Sana Iqbal', email: 'sana.iqbal@carepvtltd.com', departmentExternalId: 'HRD3', designationExternalId: 'HRG2', campusExternalId: 'HRC2', managerExternalId: 'HRX-001', status: 'active' },
      { externalId: 'HRX-005', employeeCode: 'HRE005', fullName: 'Kamran Ali', email: 'kamran.ali@carepvtltd.com', departmentExternalId: 'HRD3', designationExternalId: 'HRG3', campusExternalId: 'HRC2', managerExternalId: 'HRX-004', status: 'active' },
      // HRE006 exists only in the full roster; the reduced roster omits it (→ deactivate).
      ...(reduced ? [] : [{ externalId: 'HRX-006', employeeCode: 'HRE006', fullName: 'Hina Raza', email: 'hina.raza@carepvtltd.com', departmentExternalId: 'HRD2', designationExternalId: 'HRG3', campusExternalId: 'HRC1', managerExternalId: 'HRX-002', status: 'active' } as HrEmployee]),
    ];

    return {
      organization: { name: 'CARE Pvt. Ltd. (HR-managed)' },
      campuses: [
        { externalId: 'HRC1', name: 'Head Office' },
        { externalId: 'HRC2', name: 'North Branch' },
      ],
      departments: [
        { externalId: 'HRD1', name: 'Executive', parentExternalId: null, campusExternalId: 'HRC1', unitType: 'division' },
        { externalId: 'HRD2', name: 'Engineering', parentExternalId: 'HRD1', campusExternalId: 'HRC1', unitType: 'department' },
        { externalId: 'HRD3', name: 'Sales', parentExternalId: 'HRD1', campusExternalId: 'HRC2', unitType: 'department' },
      ],
      designations: [
        { externalId: 'HRG1', name: 'Chief Executive', level: 10, promotesToExternalId: null },
        { externalId: 'HRG2', name: 'Manager', level: 7, promotesToExternalId: 'HRG1' },
        { externalId: 'HRG3', name: 'Officer', level: 4, promotesToExternalId: 'HRG2' },
      ],
      employees,
    };
  }
}
