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

  /**
   * The FLAT template: ONE sheet, one row per employee.
   *
   * The HR twin of the SIS single-sheet Roster. Same columns as the Employees sheet of
   * the workbook — deliberately, because it IS the Employees sheet; what differs is
   * that the Departments, Designations and Campuses named in it are created from the
   * list rather than having to be typed out on three more sheets first.
   *
   * Written for someone who has a staff list and should not need to know what a
   * referential integrity error is.
   */
  async staffWorkbook(): Promise<Buffer> {
    const wb = new Workbook();
    wb.creator = '360 Feedback System';

    const intro = wb.addWorksheet('Instructions');
    const lines: [string, boolean?][] = [
      ['Staff list — single-sheet import', true],
      [''],
      ['Fill the "Staff" sheet and upload it on Organization Import.'],
      [''],
      ['ONE ROW PER EMPLOYEE', true],
      ['No other sheets are needed. Departments, Designations and Campuses are created'],
      ['automatically from what you type in those columns, so you do not have to list'],
      ['them separately first.'],
      [''],
      ['WHAT IS REQUIRED', true],
      ['    Employee Code   the service number that identifies this person'],
      ['    Full Name'],
      ['    Email           also becomes their login, and must be unique'],
      ['Everything else is optional.'],
      [''],
      ['THE EMPLOYEE CODE IS THE IDENTITY', true],
      ['Keep it the same for the same person, every time you import. Importing the same'],
      ['file again UPDATES those people — it never creates a second copy of anyone.'],
      ['Their appraisal history, feedback already collected about them and their reviewer'],
      ['assignments all stay attached, because the employee record is updated in place.'],
      [''],
      ['CHOOSE "Insert new + update existing" AT THE CONFIRM STEP', true],
      ['That is the mode that applies changes to people who already exist. "Insert new,'],
      ['skip existing" leaves them exactly as they are.'],
      [''],
      ['A BLANK CELL MEANS "LEAVE IT ALONE"', true],
      ['On an update, an empty Department, Designation, Campus, Status, Reporting To or'],
      ['Joining Date cell keeps whatever is already stored. It does not clear it. To'],
      ['change one of those, type the new value; to clear one, use the employee screen.'],
      [''],
      ['REPORTING TO', true],
      ['Put the MANAGER’S Employee Code in the Reporting To column, not their name.'],
      ['The manager can appear anywhere in the file, or already exist in the system —'],
      ['the hierarchy is resolved after every row has been read. Leave it blank for the'],
      ['top of the hierarchy.'],
      [''],
      ['STATUS', true],
      ['active or inactive. Inactive staff are imported and kept, with their history,'],
      ['but are left out of evaluations.'],
      [''],
      ['SPELLING MATTERS FOR NEW DEPARTMENTS', true],
      ['"Mathematics" and "Maths" become two different departments. Names differing only'],
      ['in capitalisation or spacing are treated as one, and the preview warns you which'],
      ['records it is about to create — read that list before confirming.'],
      [''],
      ['You may add extra columns of your own — unrecognised columns are ignored.'],
      ['The full multi-sheet workbook is still available and still works; use it when you'],
      ['need parent departments, seniority levels or promotion paths.'],
    ];
    for (const [text, bold] of lines) {
      const row = intro.addRow([text]);
      if (bold) row.getCell(1).font = { bold: true };
    }
    intro.getRow(1).getCell(1).font = { bold: true, size: 14 };
    intro.getColumn(1).width = 88;

    // HR-facing wording. The parser normalises case, spaces and underscores before
    // matching its synonym list, so "Employee Code" resolves to employeeCode and
    // "Reporting To" to managerCode.
    const COLUMNS = [
      'Employee Code', 'Full Name', 'Email', 'Department', 'Designation',
      'Campus', 'Reporting To', 'Joining Date', 'Status',
    ];
    const ws = wb.addWorksheet('Staff');
    ws.addRow(COLUMNS);
    ws.getRow(1).font = { bold: true };

    /*
     * The examples carry what people get wrong: the top of the hierarchy has a BLANK
     * Reporting To; everyone else points at a code that appears in this same file; and
     * two people share a department so it is created once, not twice.
     */
    const examples = [
      ['E1000', 'Imran Farooqi', 'imran.farooqi@carepvtltd.com', 'Executive Office', 'Principal', 'Main Campus', '', '2019-03-01', 'active'],
      ['E1001', 'Bilal Ahmed', 'bilal.ahmed@carepvtltd.com', 'Mathematics', 'Senior Teacher', 'Main Campus', 'E1000', '2020-08-15', 'active'],
      ['E1002', 'Ayesha Noor', 'ayesha.noor@carepvtltd.com', 'Mathematics', 'Teacher', 'Main Campus', 'E1001', '2022-01-10', 'active'],
      ['E1003', 'Kamran Shah', 'kamran.shah@carepvtltd.com', 'English', 'Teacher', 'Main Campus', 'E1000', '2021-09-01', 'active'],
    ];
    for (const ex of examples) ws.addRow(ex);

    ws.columns.forEach((c) => { c.width = 22; });
    // Text format on the code columns: an employee code like 00412 is a code, not the
    // number 412, and Excel will happily eat the leading zeros otherwise.
    for (const header of ['Employee Code', 'Reporting To']) {
      const idx = COLUMNS.indexOf(header) + 1;
      if (idx > 0) ws.getColumn(idx).numFmt = '@';
    }
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
  }

  /** Header row + examples for the flat Staff sheet, as CSV. */
  staffCsv(): string {
    return [
      'Employee Code,Full Name,Email,Department,Designation,Campus,Reporting To,Joining Date,Status',
      'E1000,Imran Farooqi,imran.farooqi@carepvtltd.com,Executive Office,Principal,Main Campus,,2019-03-01,active',
      'E1001,Bilal Ahmed,bilal.ahmed@carepvtltd.com,Mathematics,Senior Teacher,Main Campus,E1000,2020-08-15,active',
      'E1002,Ayesha Noor,ayesha.noor@carepvtltd.com,Mathematics,Teacher,Main Campus,E1001,2022-01-10,active',
    ].join('\n');
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
