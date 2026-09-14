import { BadRequestException, Injectable } from '@nestjs/common';
import { Workbook } from 'exceljs';
import type {
  CampusRow, CompetencyRow, DepartmentRow, DesignationRow, EmployeeRow, ImportDataset, ImportEntity, OrganizationRow,
} from '../org-import.types';

/** Canonical sheet name per entity + accepted synonyms (normalized). */
const SHEET_ALIASES: Record<ImportEntity, string[]> = {
  organization: ['organization', 'organisation', 'org'],
  campuses: ['campuses', 'campus', 'institutes', 'institute', 'locations', 'location'],
  departments: ['departments', 'department', 'departmentsunits', 'units', 'unit'],
  designations: ['designations', 'designation', 'titles', 'jobtitles', 'grades'],
  employees: ['employees', 'employee', 'staff', 'people'],
  competencies: ['competencies', 'competency', 'competences'],
};

/** Per-entity column → accepted header synonyms (all normalized to lowercase alnum). */
const COLUMN_ALIASES: Record<string, Record<string, string[]>> = {
  organization: {
    name: ['name', 'organizationname', 'organisationname', 'orgname'],
    slug: ['slug'],
    status: ['status'],
  },
  campuses: {
    name: ['name', 'campusname', 'institutename', 'location', 'campus', 'institute'],
    slug: ['slug', 'code'],
    status: ['status', 'active'],
  },
  departments: {
    name: ['name', 'department', 'departmentname', 'unit', 'unitname'],
    parent: ['parent', 'parentdepartment', 'parentunit', 'parentname'],
    campus: ['campus', 'institute', 'location'],
    unitType: ['unittype', 'type'],
  },
  designations: {
    name: ['name', 'designation', 'title', 'jobtitle'],
    level: ['level', 'seniority', 'grade', 'rank'],
    promotesTo: ['promotesto', 'promotionto', 'promotionpath', 'nextdesignation'],
  },
  employees: {
    employeeCode: ['employeecode', 'code', 'serviceno', 'servicenumber', 'serviceno', 'empcode', 'employeeid', 'empid', 'staffid'],
    fullName: ['fullname', 'name', 'employeename', 'staffname'],
    email: ['email', 'emailaddress', 'workemail'],
    department: ['department', 'departmentname', 'dept'],
    designation: ['designation', 'title', 'jobtitle'],
    campus: ['campus', 'institute', 'location'],
    managerCode: ['managercode', 'reportingto', 'reportsto', 'manager', 'managerid', 'reportingtocode', 'reportingtoemployeecode', 'linemanager', 'linemanagercode'],
    joinDate: ['joindate', 'dateofjoining', 'doj', 'joiningdate'],
    status: ['status', 'active', 'employeestatus'],
    password: ['password', 'initialpassword', 'temporarypassword'],
  },
  competencies: {
    category: ['category', 'competencycategory', 'group'],
    name: ['name', 'competency', 'competencyname'],
    description: ['description', 'desc', 'details'],
  },
};

/**
 * Sheet names that mean "one flat list of staff" rather than "the Employees sheet of
 * the multi-sheet workbook". Same idea as the SIS importer's Roster sheet: the columns
 * are identical to Employees, but the master data referenced in them is DERIVED
 * instead of being required to exist already. See services/staff-expand.ts.
 */
const FLAT_SHEET_ALIASES = ['staff', 'stafflist', 'flat', 'flatstaff', 'employeesflat', 'staffdata', 'hrdata', 'people'];

interface ParsedInput {
  filename: string;
  contentBase64: string;
  /** Required for CSV (single sheet): which entity the file represents. */
  entity?: ImportEntity;
  /** Treat an employees file as the flat Staff sheet (CSV has no sheet name to go on). */
  flat?: boolean;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

@Injectable()
export class ParseService {
  /** Parse an uploaded CSV/Excel file into the normalized ImportDataset. */
  async parse(input: ParsedInput): Promise<{ dataset: ImportDataset; sheetsFound: ImportEntity[]; flat: boolean }> {
    const buffer = this.decode(input.contentBase64);
    const isCsv = /\.csv$/i.test(input.filename);
    const sheets: Partial<Record<ImportEntity, Record<string, string>[]>> = {};
    // A flat file is still an EMPLOYEES file — same columns, same entity, same upsert.
    // The only difference is that its master data is derived rather than required.
    let flat = input.flat === true;

    if (isCsv) {
      if (!input.entity) throw new BadRequestException('For a CSV upload, specify which entity it contains (e.g. employees).');
      sheets[input.entity] = this.parseCsv(buffer.toString('utf8'));
    } else {
      const wb = new Workbook();
      try {
        await wb.xlsx.load(buffer as unknown as ArrayBuffer);
      } catch {
        throw new BadRequestException('Could not read the Excel file. Upload a valid .xlsx workbook or a .csv file.');
      }
      wb.eachSheet((ws) => {
        const isFlatSheet = FLAT_SHEET_ALIASES.includes(norm(ws.name));
        const entity = isFlatSheet ? 'employees' : this.matchEntity(ws.name);
        if (!entity) return;
        const rows = this.sheetToObjects(ws, entity);
        if (!rows.length) return;
        // A workbook holding both Staff and Employees would be ambiguous about which
        // list is authoritative, so the flat sheet only ever ADDS to employees and the
        // file counts as flat if any sheet asked for it.
        sheets[entity] = [...(sheets[entity] ?? []), ...rows];
        if (isFlatSheet) flat = true;
      });
      if (Object.keys(sheets).length === 0) {
        throw new BadRequestException('No recognised sheets found. Use the provided template — either the single "Staff" sheet, or the workbook sheets Campuses, Departments, Designations, Employees, Competencies.');
      }
    }

    const dataset: ImportDataset = {
      organization: this.mapOrganization(sheets.organization),
      campuses: (sheets.campuses ?? []).map((r, i) => this.mapCampus(r, i)).filter((r): r is CampusRow => r !== null),
      departments: (sheets.departments ?? []).map((r, i) => this.mapDepartment(r, i)).filter((r): r is DepartmentRow => r !== null),
      designations: (sheets.designations ?? []).map((r, i) => this.mapDesignation(r, i)).filter((r): r is DesignationRow => r !== null),
      employees: (sheets.employees ?? []).map((r, i) => this.mapEmployee(r, i)).filter((r): r is EmployeeRow => r !== null),
      competencies: (sheets.competencies ?? []).map((r, i) => this.mapCompetency(r, i)).filter((r): r is CompetencyRow => r !== null),
    };
    return { dataset, sheetsFound: Object.keys(sheets) as ImportEntity[], flat };
  }

  private decode(b64: string): Buffer {
    try {
      const clean = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64; // strip data: URL prefix
      return Buffer.from(clean, 'base64');
    } catch {
      throw new BadRequestException('The uploaded file could not be decoded.');
    }
  }

  private matchEntity(sheetName: string): ImportEntity | null {
    const n = norm(sheetName);
    for (const [entity, aliases] of Object.entries(SHEET_ALIASES)) {
      if (aliases.includes(n)) return entity as ImportEntity;
    }
    return null;
  }

  /** Convert an exceljs worksheet to header-keyed row objects (canonical field keys). */
  private sheetToObjects(ws: import('exceljs').Worksheet, forEntity?: ImportEntity): Record<string, string>[] {
    const headerRow = ws.getRow(1);
    const headers: (string | null)[] = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col] = this.cellText(cell.value);
    });
    const entity = forEntity ?? this.matchEntity(ws.name);
    const aliasMap = entity ? COLUMN_ALIASES[entity] : {};
    const colToField = new Map<number, string>();
    headers.forEach((h, col) => {
      if (!h) return;
      const nh = norm(h);
      for (const [field, aliases] of Object.entries(aliasMap)) {
        if (aliases.includes(nh)) { colToField.set(col, field); break; }
      }
    });
    const out: Record<string, string>[] = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const obj: Record<string, string> = {};
      let hasValue = false;
      colToField.forEach((field, col) => {
        const v = this.cellText(row.getCell(col).value);
        if (v) { obj[field] = v; hasValue = true; }
      });
      obj._sourceRow = String(r);
      if (hasValue) out.push(obj);
    }
    return out;
  }

  private cellText(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
      const v = value as Record<string, unknown>;
      if ('text' in v) return String(v.text).trim();
      if ('result' in v) return String(v.result).trim();
      if ('richText' in v && Array.isArray(v.richText)) return v.richText.map((t) => (t as { text: string }).text).join('').trim();
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      if ('hyperlink' in v && 'text' in v) return String(v.text).trim();
    }
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value).trim();
  }

  /** Minimal RFC-4180 CSV parser → canonical field-keyed objects. */
  private parseCsv(text: string): Record<string, string>[] {
    const rows = this.csvRows(text.replace(/^﻿/, ''));
    if (rows.length < 2) return [];
    const headers = rows[0];
    const out: Record<string, string>[] = [];
    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i];
      if (cells.every((c) => c.trim() === '')) continue;
      const obj: Record<string, string> = { _sourceRow: String(i + 1) };
      headers.forEach((h, idx) => { obj[h.trim()] = (cells[idx] ?? '').trim(); });
      out.push(obj);
    }
    return out;
  }

  private csvRows(text: string): string[][] {
    const rows: string[][] = [];
    let field = '', row: string[] = [], inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
        else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* ignore */ }
      else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  /** For CSV, keys are raw header text → remap to canonical fields for the chosen entity. */
  private remapCsvKeys(entity: ImportEntity, row: Record<string, string>): Record<string, string> {
    const aliasMap = COLUMN_ALIASES[entity];
    const out: Record<string, string> = { _sourceRow: row._sourceRow };
    for (const [rawKey, val] of Object.entries(row)) {
      if (rawKey === '_sourceRow') continue;
      const nk = norm(rawKey);
      for (const [field, aliases] of Object.entries(aliasMap)) {
        if (aliases.includes(nk)) { out[field] = val; break; }
      }
    }
    return out;
  }

  private srow(r: Record<string, string>): number { return Number(r._sourceRow ?? 0) || 0; }

  private mapOrganization(rows?: Record<string, string>[]): OrganizationRow | null {
    if (!rows || !rows.length) return null;
    const r = this.remapMaybe('organization', rows[0]);
    if (!r.name && !r.slug) return null;
    return { name: r.name || undefined, slug: r.slug || undefined, status: r.status || undefined };
  }
  private mapCampus(r0: Record<string, string>, i: number): CampusRow | null {
    const r = this.remapMaybe('campuses', r0);
    if (!r.name) return null;
    return { name: r.name, slug: r.slug || undefined, status: r.status || undefined, _row: this.srow(r0) || i + 2 };
  }
  private mapDepartment(r0: Record<string, string>, i: number): DepartmentRow | null {
    const r = this.remapMaybe('departments', r0);
    if (!r.name) return null;
    return { name: r.name, parent: r.parent || undefined, campus: r.campus || undefined, unitType: r.unitType || undefined, _row: this.srow(r0) || i + 2 };
  }
  private mapDesignation(r0: Record<string, string>, i: number): DesignationRow | null {
    const r = this.remapMaybe('designations', r0);
    if (!r.name) return null;
    const level = r.level !== undefined && r.level !== '' ? Number(r.level) : undefined;
    return { name: r.name, level: Number.isFinite(level) ? level : undefined, promotesTo: r.promotesTo || undefined, _row: this.srow(r0) || i + 2 };
  }
  private mapEmployee(r0: Record<string, string>, i: number): EmployeeRow | null {
    const r = this.remapMaybe('employees', r0);
    if (!r.employeeCode) return null;
    return {
      employeeCode: r.employeeCode, fullName: r.fullName || undefined, email: r.email || undefined,
      department: r.department || undefined, designation: r.designation || undefined, campus: r.campus || undefined,
      managerCode: r.managerCode || undefined, joinDate: r.joinDate || undefined, status: r.status || undefined,
      password: r.password || undefined, _row: this.srow(r0) || i + 2,
    };
  }
  private mapCompetency(r0: Record<string, string>, i: number): CompetencyRow | null {
    const r = this.remapMaybe('competencies', r0);
    if (!r.name || !r.category) return null;
    return { category: r.category, name: r.name, description: r.description || undefined, _row: this.srow(r0) || i + 2 };
  }

  /** xlsx rows already have canonical keys; CSV rows have raw header keys — remap those. */
  private remapMaybe(entity: ImportEntity, r: Record<string, string>): Record<string, string> {
    const canonicalFields = Object.keys(COLUMN_ALIASES[entity]);
    const looksCanonical = Object.keys(r).some((k) => canonicalFields.includes(k));
    return looksCanonical ? r : this.remapCsvKeys(entity, r);
  }
}
