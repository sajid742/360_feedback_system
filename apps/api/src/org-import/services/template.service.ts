import { Injectable } from '@nestjs/common';
import { Workbook } from 'exceljs';
import type { ImportEntity } from '../org-import.types';

interface FieldSpec { name: string; required: boolean; description: string; examples: string[] }

/** Field catalogue driving both the downloadable templates and their documentation. */
const FIELDS: Record<Exclude<ImportEntity, 'organization'> | 'organization', FieldSpec[]> = {
  organization: [
    { name: 'name', required: true, description: 'Display name of the organization (updates the current tenant; the login slug is not changed).', examples: ['CARE Pvt. Ltd.'] },
  ],
  campuses: [
    { name: 'name', required: true, description: 'Campus or institute name (Institutes and Campuses are both location records).', examples: ['Main Campus', 'City Institute'] },
    { name: 'slug', required: false, description: 'Optional URL-safe code; auto-generated from the name if left blank.', examples: ['main-campus', ''] },
    { name: 'status', required: false, description: 'active or inactive (default active).', examples: ['active', 'active'] },
  ],
  departments: [
    { name: 'name', required: true, description: 'Unique department/unit name.', examples: ['Executive Office', 'Mathematics'] },
    { name: 'parent', required: false, description: 'Name of the parent department (must exist in this file or the system). Blank = top level.', examples: ['', 'Academics'] },
    { name: 'campus', required: false, description: 'Campus/Institute this unit belongs to (must match a Campuses row or existing campus).', examples: ['Main Campus', 'Main Campus'] },
    { name: 'unitType', required: false, description: 'Free-text unit type (division, department, team…). Default department.', examples: ['division', 'department'] },
  ],
  designations: [
    { name: 'name', required: true, description: 'Unique job title / designation.', examples: ['Principal', 'Senior Teacher'] },
    { name: 'level', required: false, description: 'Seniority level (higher = more senior). Drives Head-of-Department derivation. Default 0.', examples: ['9', '5'] },
    { name: 'promotesTo', required: false, description: 'Designation this one promotes to (must exist in this file or the system).', examples: ['', 'Principal'] },
  ],
  employees: [
    { name: 'employeeCode', required: true, description: 'Stable unique employee code / service number. This is the key used for Reporting To.', examples: ['E1000', 'E1001'] },
    { name: 'fullName', required: true, description: 'Employee full name.', examples: ['Imran Farooqi', 'Bilal Ahmed'] },
    { name: 'email', required: true, description: 'Unique work email (also becomes their login).', examples: ['imran.farooqi@carepvtltd.com', 'bilal.ahmed@carepvtltd.com'] },
    { name: 'department', required: false, description: 'Department name (must match a Departments row or existing department).', examples: ['Executive Office', 'Mathematics'] },
    { name: 'designation', required: false, description: 'Designation name (must match a Designations row or existing designation).', examples: ['Principal', 'Senior Teacher'] },
    { name: 'campus', required: false, description: 'Campus/Institute name.', examples: ['Main Campus', 'Main Campus'] },
    { name: 'managerCode', required: false, description: 'Reporting To — the employeeCode of this person’s line manager. Blank = top of hierarchy.', examples: ['', 'E1000'] },
    { name: 'joinDate', required: false, description: 'Joining date (YYYY-MM-DD).', examples: ['2020-01-15', '2021-08-01'] },
    { name: 'status', required: false, description: 'active or inactive (inactive staff are imported but excluded from evaluations). Default active.', examples: ['active', 'active'] },
    { name: 'password', required: false, description: 'Optional initial password. If blank, login stays disabled until set/reset.', examples: ['', ''] },
  ],
  competencies: [
    { name: 'category', required: true, description: 'Competency category (created automatically if new).', examples: ['Leadership', 'Teaching'] },
    { name: 'name', required: true, description: 'Unique competency name (created as a draft v1 for review).', examples: ['Strategic Leadership', 'Lesson Planning'] },
    { name: 'description', required: false, description: 'What the competency measures.', examples: ['Sets direction and priorities.', 'Plans effective lessons.'] },
  ],
};

const SHEET_ORDER: (keyof typeof FIELDS)[] = ['organization', 'campuses', 'departments', 'designations', 'employees', 'competencies'];
const SHEET_TITLE: Record<string, string> = {
  organization: 'Organization', campuses: 'Campuses', departments: 'Departments',
  designations: 'Designations', employees: 'Employees', competencies: 'Competencies',
};

@Injectable()
export class TemplateService {
  /** Full multi-sheet Excel template: an Instructions sheet + one sheet per entity. */
  async workbook(): Promise<Buffer> {
    const wb = new Workbook();
    wb.creator = '360 Feedback System';

    const info = wb.addWorksheet('Instructions');
    info.columns = [{ width: 16 }, { width: 20 }, { width: 12 }, { width: 70 }];
    info.addRow(['Organization Data Import Template']).font = { bold: true, size: 14 };
    info.addRow([]);
    info.addRow(['Fill in the sheets below and upload this workbook. Import employees with their managerCode (Reporting To) — the hierarchy is resolved after all employees are created. SIS / students / parents / teachers are out of scope for this utility.']);
    info.addRow([]);
    const head = info.addRow(['Sheet', 'Field', 'Required', 'Description']);
    head.font = { bold: true };
    for (const entity of SHEET_ORDER) {
      for (const f of FIELDS[entity]) {
        info.addRow([SHEET_TITLE[entity], f.name, f.required ? 'Required' : 'Optional', f.description]);
      }
    }

    for (const entity of SHEET_ORDER) {
      const ws = wb.addWorksheet(SHEET_TITLE[entity]);
      const specs = FIELDS[entity];
      ws.columns = specs.map((f) => ({ header: f.name, key: f.name, width: Math.max(14, f.name.length + 4) }));
      ws.getRow(1).font = { bold: true };
      const exampleCount = Math.max(...specs.map((f) => f.examples.length), 0);
      for (let i = 0; i < exampleCount; i++) {
        ws.addRow(specs.map((f) => f.examples[i] ?? ''));
      }
    }
    return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
  }

  /** Single-entity CSV template (header row + example rows). */
  csv(entity: ImportEntity): string {
    const specs = FIELDS[entity];
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = [specs.map((f) => f.name).join(',')];
    const exampleCount = Math.max(...specs.map((f) => f.examples.length), 0);
    for (let i = 0; i < exampleCount; i++) lines.push(specs.map((f) => esc(f.examples[i] ?? '')).join(','));
    return lines.join('\n');
  }

  fields() { return FIELDS; }
}
