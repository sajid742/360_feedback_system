import { BadRequestException, Injectable } from '@nestjs/common';
import type { HrDepartment, HrDesignation, HrEmployee, HrProvider, HrSnapshot } from '../hr-provider.interface';
import { fetchJson, isInactive, pick } from './provider-util';

/**
 * Zoho People provider. Connection: { dc, clientId, clientSecret, refreshToken }.
 * Refreshes an access token via the Zoho accounts server, then reads the Employee
 * form records and maps them into the shared HrSnapshot.
 *
 * Zoho form field labels vary per tenant, so mapping is synonym-based and
 * case/space-insensitive. Correlation: externalId = Zoho EmployeeID (the stable
 * employee code); managerExternalId = the leading token of "Reporting To" (usually
 * the manager's EmployeeID), which the reconcile engine resolves by code.
 */
@Injectable()
export class ZohoPeopleProvider implements HrProvider {
  readonly name = 'Zoho People';

  async getSnapshot(_organizationId: string, options?: Record<string, unknown>): Promise<HrSnapshot> {
    const c = (options?.connection ?? {}) as Record<string, string>;
    const dc = (String(c.dc ?? 'com').trim() || 'com').replace(/[^a-z.]/gi, '');
    const clientId = String(c.clientId ?? '').trim();
    const clientSecret = String(c.clientSecret ?? '').trim();
    const refreshToken = String(c.refreshToken ?? '').trim();
    if (!clientId || !clientSecret || !refreshToken) {
      throw new BadRequestException('Zoho People is not configured — set the data center and OAuth client id/secret/refresh token under Connection settings.');
    }
    const limit = typeof options?.limit === 'number' ? (options.limit as number) : undefined;

    // 1) Refresh an access token.
    const tokenUrl = `https://accounts.zoho.${dc}/oauth/v2/token?refresh_token=${encodeURIComponent(refreshToken)}&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=refresh_token`;
    const tok = (await fetchJson(tokenUrl, { method: 'POST' })) as { access_token?: string; error?: string };
    if (!tok.access_token) throw new BadRequestException(`Zoho token refresh failed${tok.error ? `: ${tok.error}` : ''}. Check the client id/secret, refresh token and data center.`);
    const headers = { Authorization: `Zoho-oauthtoken ${tok.access_token}` };

    // 2) Page through employee records.
    const peopleBase = `https://people.zoho.${dc}/people/api/forms/employee/getRecords`;
    const per = 200;
    const raw: Record<string, unknown>[] = [];
    for (let start = 0; start < 10_000; start += per) {
      const j = await fetchJson(`${peopleBase}?sIndex=${start}&limit=${per}`, { headers });
      const batch = extractRecords(j);
      raw.push(...batch);
      if (batch.length < per) break;
      if (limit && raw.length >= limit) break;
    }
    let rows = raw;
    if (limit && limit > 0) rows = rows.slice(0, limit);

    // 3) Map.
    const depts = new Map<string, string>();
    const desigs = new Map<string, string>();
    const employees: HrEmployee[] = rows
      .map((r) => {
        const code = pick(r, ['EmployeeID', 'Employee ID', 'Employeeid', 'EmpID']);
        if (!code) return null;
        const dep = pick(r, ['Department', 'Department Name']);
        const des = pick(r, ['Designation', 'Job Title', 'Role']);
        if (dep) depts.set(dep, dep);
        if (des) desigs.set(des, des);
        const managerRaw = pick(r, ['Reporting_To', 'ReportingTo', 'Reporting To', 'Reporting_Manager', 'Reporting Manager']);
        const managerCode = managerRaw ? managerRaw.split(/[\s|,-]+/)[0] : '';
        const status = pick(r, ['Employeestatus', 'Employee status', 'EmployeeStatus', 'Status']);
        const fullName = pick(r, ['EmployeeName', 'Employee Name', 'FullName', 'Full Name'])
          || [pick(r, ['FirstName', 'First Name']), pick(r, ['LastName', 'Last Name'])].filter(Boolean).join(' ').trim();
        return {
          externalId: code,
          employeeCode: code,
          fullName: fullName || pick(r, ['EmailID', 'Email ID', 'Email']) || code,
          email: pick(r, ['EmailID', 'Email ID', 'Email', 'Work Email']),
          departmentExternalId: dep || undefined,
          designationExternalId: des || undefined,
          managerExternalId: managerCode && managerCode !== code ? managerCode : null,
          status: status && isInactive(status) ? 'inactive' : 'active',
          joinDate: pick(r, ['Dateofjoining', 'Date of Joining', 'DOJ', 'Joining Date']) || undefined,
        } as HrEmployee;
      })
      .filter((e): e is HrEmployee => e !== null);

    const departments: HrDepartment[] = [...depts.keys()].map((n) => ({ externalId: n, name: n }));
    const designations: HrDesignation[] = [...desigs.keys()].map((n) => ({ externalId: n, name: n }));

    return { organization: null, campuses: [], departments, designations, employees };
  }
}

/** Flatten Zoho's nested getRecords response into flat field objects. */
function extractRecords(j: unknown): Record<string, unknown>[] {
  const result = (j as { response?: { result?: unknown } })?.response?.result;
  const out: Record<string, unknown>[] = [];
  if (Array.isArray(result)) {
    for (const entry of result) {
      if (!entry || typeof entry !== 'object') continue;
      for (const [recId, arr] of Object.entries(entry as Record<string, unknown>)) {
        const rec = Array.isArray(arr) ? (arr[0] as Record<string, unknown>) : (arr as Record<string, unknown>);
        if (rec && typeof rec === 'object') out.push({ _recordId: recId, ...rec });
      }
    }
  } else if (Array.isArray(j)) {
    for (const rec of j) if (rec && typeof rec === 'object') out.push(rec as Record<string, unknown>);
  }
  return out;
}
