import { BadRequestException } from '@nestjs/common';
import type { HrCampus, HrDepartment, HrDesignation, HrEmployee, HrSnapshot } from '../hr-provider.interface';

/** fetch() with a timeout so a hung HR endpoint can't stall a sync forever. */
export async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<unknown> {
  const res = await fetchWithTimeout(url, { ...init, headers: { Accept: 'application/json', ...(init.headers ?? {}) } }, timeoutMs);
  const text = await res.text();
  if (!res.ok) throw new BadRequestException(`HR endpoint returned ${res.status}: ${text.slice(0, 300)}`);
  try { return text ? JSON.parse(text) : {}; } catch { throw new BadRequestException('HR endpoint did not return valid JSON.'); }
}

export async function fetchText(url: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<string> {
  const res = await fetchWithTimeout(url, init, timeoutMs);
  const text = await res.text();
  if (!res.ok) throw new BadRequestException(`HR endpoint returned ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    throw new BadRequestException(`Could not reach the HR endpoint: ${(e as Error).message}`);
  } finally {
    clearTimeout(t);
  }
}

/** Read a nested value by dot path (e.g. "data.employees"). Blank path = the value itself. */
export function atPath(obj: unknown, path?: string): unknown {
  if (!path) return obj;
  return path.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), obj);
}

/** First non-empty value among candidate keys (case/space/underscore-insensitive). */
export function pick(row: Record<string, unknown>, candidates: string[]): string {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');
  const index = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) index.set(norm(k), v);
  for (const c of candidates) {
    const v = index.get(norm(c));
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/** Minimal, robust CSV parser (RFC-4180-ish): quoted fields, embedded quotes/commas/newlines. */
export function parseCsv(text: string, delimiter = ','): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '', row: string[] = [], inQuotes = false;
  const d = delimiter || ',';
  const s = text.replace(/^﻿/, ''); // strip BOM
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === d) { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); field = ''; row = []; }
    else if (ch === '\r') { /* ignore */ }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmpty.length === 0) return [];
  const headers = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((r) => {
    const o: Record<string, string> = {};
    headers.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
}

/** Is a status string "inactive" (anything non-active deactivates on our side). */
export function isInactive(status: string): boolean {
  return /inactive|terminat|resign|exit|left|separated|disabled|inactiv/i.test(status);
}

/**
 * Build a full HrSnapshot from flat employee rows using a source→field mapping.
 * Departments/designations/campuses are synthesized from distinct names (name = id),
 * and the manager link is by employee code (externalId == employeeCode here), so the
 * existing reconcile engine resolves Reporting-To unchanged.
 */
export interface FieldMapping {
  employeeCode: string; fullName: string; email: string;
  department?: string; designation?: string; campus?: string;
  managerCode?: string; status?: string; joinDate?: string;
  firstName?: string; lastName?: string;
}

export function buildSnapshotFromRows(rows: Record<string, unknown>[], mapping: FieldMapping, orgName?: string): HrSnapshot {
  const depts = new Map<string, string>();
  const desigs = new Map<string, string>();
  const campuses = new Map<string, string>();
  const employees: HrEmployee[] = [];

  const val = (row: Record<string, unknown>, key?: string): string => (key ? pick(row, [key]) : '');

  for (const row of rows) {
    const code = val(row, mapping.employeeCode);
    if (!code) continue; // no stable key → skip the row
    let fullName = val(row, mapping.fullName);
    if (!fullName) fullName = [val(row, mapping.firstName), val(row, mapping.lastName)].filter(Boolean).join(' ').trim();
    const dep = val(row, mapping.department);
    const des = val(row, mapping.designation);
    const cam = val(row, mapping.campus);
    if (dep) depts.set(dep, dep);
    if (des) desigs.set(des, des);
    if (cam) campuses.set(cam, cam);
    const status = val(row, mapping.status);
    employees.push({
      externalId: code,
      employeeCode: code,
      fullName: fullName || val(row, mapping.email) || code,
      email: val(row, mapping.email),
      departmentExternalId: dep || undefined,
      designationExternalId: des || undefined,
      campusExternalId: cam || undefined,
      managerExternalId: val(row, mapping.managerCode) || null,
      status: status ? (isInactive(status) ? 'inactive' : 'active') : 'active',
      joinDate: val(row, mapping.joinDate) || undefined,
    });
  }

  const campusesArr: HrCampus[] = [...campuses.keys()].map((n) => ({ externalId: n, name: n }));
  const departmentsArr: HrDepartment[] = [...depts.keys()].map((n) => ({ externalId: n, name: n }));
  const designationsArr: HrDesignation[] = [...desigs.keys()].map((n) => ({ externalId: n, name: n }));

  return {
    organization: orgName ? { name: orgName } : null,
    campuses: campusesArr,
    departments: departmentsArr,
    designations: designationsArr,
    employees,
  };
}
