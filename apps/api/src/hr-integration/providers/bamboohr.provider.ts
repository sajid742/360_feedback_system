import { BadRequestException, Injectable } from '@nestjs/common';
import type { HrDepartment, HrDesignation, HrEmployee, HrProvider, HrSnapshot } from '../hr-provider.interface';
import { fetchJson, isInactive } from './provider-util';

interface BambooRow {
  id?: string | number;
  employeeNumber?: string;
  firstName?: string;
  lastName?: string;
  workEmail?: string;
  department?: string;
  division?: string;
  jobTitle?: string;
  supervisorEId?: string | number;
  status?: string;
  hireDate?: string;
}

/**
 * BambooHR provider. Connection: { subdomain, apiKey }. Auth is HTTP Basic with the
 * API key as the username (password 'x') — BambooHR's documented scheme. Pulls a
 * custom report of current employees and maps it into the shared HrSnapshot.
 *
 * Correlation: externalId = BambooHR internal id (stable), employeeCode =
 * employeeNumber, managerExternalId = supervisorEId (the manager's BambooHR id), so
 * the existing reconcile engine resolves Reporting-To with no changes.
 */
@Injectable()
export class BambooHrProvider implements HrProvider {
  readonly name = 'BambooHR';

  async getSnapshot(_organizationId: string, options?: Record<string, unknown>): Promise<HrSnapshot> {
    const c = (options?.connection ?? {}) as Record<string, string>;
    const subdomain = String(c.subdomain ?? '').trim();
    const apiKey = String(c.apiKey ?? '').trim();
    if (!subdomain || !apiKey) throw new BadRequestException('BambooHR is not configured — set the company domain and API key under Connection settings.');
    const limit = typeof options?.limit === 'number' ? (options.limit as number) : undefined;

    const auth = 'Basic ' + Buffer.from(`${apiKey}:x`).toString('base64');
    const base = `https://api.bamboohr.com/api/gateway.php/${encodeURIComponent(subdomain)}/v1`;
    const body = {
      title: '360 Feedback sync',
      fields: ['employeeNumber', 'firstName', 'lastName', 'workEmail', 'department', 'division', 'jobTitle', 'supervisorEId', 'status', 'hireDate'],
    };
    const data = (await fetchJson(`${base}/reports/custom?format=JSON&onlyCurrent=true`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })) as { employees?: BambooRow[] };

    let rows = Array.isArray(data.employees) ? data.employees : [];
    if (limit && limit > 0) rows = rows.slice(0, limit);

    const depts = new Map<string, string>();
    const desigs = new Map<string, string>();
    const employees: HrEmployee[] = rows
      .map((r) => {
        const code = String(r.employeeNumber ?? '').trim() || String(r.id ?? '').trim();
        if (!code) return null;
        const dep = String(r.department ?? '').trim();
        const des = String(r.jobTitle ?? '').trim();
        if (dep) depts.set(dep, dep);
        if (des) desigs.set(des, des);
        const status = String(r.status ?? '').trim();
        return {
          externalId: String(r.id ?? code),
          employeeCode: code,
          fullName: [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || String(r.workEmail ?? '').trim() || code,
          email: String(r.workEmail ?? '').trim(),
          departmentExternalId: dep || undefined,
          designationExternalId: des || undefined,
          managerExternalId: r.supervisorEId != null && String(r.supervisorEId).trim() ? String(r.supervisorEId) : null,
          status: status && isInactive(status) ? 'inactive' : 'active',
          joinDate: r.hireDate || undefined,
        } as HrEmployee;
      })
      .filter((e): e is HrEmployee => e !== null);

    const departments: HrDepartment[] = [...depts.keys()].map((n) => ({ externalId: n, name: n }));
    const designations: HrDesignation[] = [...desigs.keys()].map((n) => ({ externalId: n, name: n }));

    return { organization: null, campuses: [], departments, designations, employees };
  }
}
