import { BadRequestException, Injectable } from '@nestjs/common';
import { Workbook, type Worksheet } from 'exceljs';
import { parseCsv } from '../../hr-integration/providers/provider-util';
import { emptyRows, type SisRawRows } from './snapshot-builder';

export interface SisParseInput { filename: string; base64: string; entity?: string }

const SHEET_ENTITY: Record<string, keyof SisRawRows> = {
  students: 'students', student: 'students',
  guardians: 'guardians', guardian: 'guardians', parents: 'guardians', parent: 'guardians',
  teachers: 'teachers', teacher: 'teachers', staff: 'teachers',
  teachingassignments: 'teachingAssignments', assignments: 'teachingAssignments', assignment: 'teachingAssignments', teaching: 'teachingAssignments',
  enrollments: 'enrollments', enrolments: 'enrollments', enrollment: 'enrollments',
};

/** Canonical template columns per entity (used by the downloadable template). */
export const TEMPLATE_COLUMNS: Record<keyof SisRawRows, string[]> = {
  students: ['student_id', 'name', 'gender', 'class', 'section', 'campus', 'department', 'session', 'status', 'parent_name', 'parent_mobile', 'parent_whatsapp', 'parent_email'],
  guardians: ['student_id', 'name', 'relationship', 'mobile', 'whatsapp', 'email', 'language', 'status'],
  teachers: ['teacher_id', 'employee_code', 'name', 'designation', 'department', 'faculty', 'mobile', 'email', 'status'],
  teachingAssignments: ['assignment_id', 'teacher_id', 'subject_id', 'subject_name', 'subject_code', 'class', 'section', 'session', 'semester', 'campus', 'program', 'status'],
  enrollments: ['student_id', 'assignment_id', 'status'],
};

/** Parses an uploaded Excel workbook (sheets by entity) or a single CSV file. */
@Injectable()
export class SisParseService {
  private resolveEntity(name: string): keyof SisRawRows | undefined {
    return SHEET_ENTITY[name.toLowerCase().replace(/[\s_-]+/g, '')];
  }

  async parseAsync(input: SisParseInput): Promise<SisRawRows> {
    const buffer = Buffer.from(input.base64, 'base64');
    const rows = emptyRows();
    if (/\.csv$/i.test(input.filename)) {
      const entity = this.resolveEntity(input.entity ?? 'students');
      if (!entity) throw new BadRequestException('For a CSV upload, specify a valid entity (students, guardians, teachers, teachingAssignments, enrollments).');
      rows[entity] = parseCsv(buffer.toString('utf8'));
      return rows;
    }
    let wb: Workbook;
    try { const loader = new Workbook(); wb = await loader.xlsx.load(buffer as unknown as Parameters<typeof loader.xlsx.load>[0]); }
    catch { throw new BadRequestException('Could not read the file. Upload a valid .xlsx workbook or a .csv file.'); }
    for (const ws of wb.worksheets) {
      const entity = this.resolveEntity(ws.name);
      if (!entity) continue;
      rows[entity] = this.sheetToObjects(ws);
    }
    if (Object.values(rows).every((a) => a.length === 0)) {
      throw new BadRequestException('No recognised sheets found. Expected sheets named Students, Guardians, Teachers, TeachingAssignments, Enrollments.');
    }
    return rows;
  }

  private sheetToObjects(ws: Worksheet): Record<string, string>[] {
    const headerRow = ws.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, col) => { headers[col] = String(cell.value ?? '').trim(); });
    const out: Record<string, string>[] = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const obj: Record<string, string> = {};
      let any = false;
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        const h = headers[col];
        if (!h) return;
        const v = cell.value;
        const s = v == null ? '' : typeof v === 'object' && 'text' in (v as object) ? String((v as { text: unknown }).text) : String(v);
        obj[h] = s.trim();
        if (obj[h]) any = true;
      });
      if (any) out.push(obj);
    }
    return out;
  }

  /** Build a downloadable multi-sheet .xlsx template with example rows. */
  async template(): Promise<Buffer> {
    const wb = new Workbook();
    const intro = wb.addWorksheet('Instructions');
    intro.addRow(['Student / SIS Import Template']);
    intro.addRow([]);
    intro.addRow(['Fill the sheets below and upload on Student Integration → Import. Only Students is required;']);
    intro.addRow(['add Teachers + TeachingAssignments + Enrollments to enable parent-feedback (student → teacher → employee).']);
    intro.addRow(['Teachers whose employee_code matches a 360 employee are auto-linked for parent feedback.']);
    (intro.getRow(1).getCell(1)).font = { bold: true, size: 14 };

    const examples: Record<keyof typeof TEMPLATE_COLUMNS, string[][]> = {
      students: [['S1001', 'Ahmed Ali', 'Male', 'Grade 9', 'A', 'CARE Taxila Campus', 'Science', '2025-2026', 'active', 'Imran Ali', '+923001234567', '+923001234567', 'imran.ali@gmail.com']],
      guardians: [['S1001', 'Sana Ali', 'Mother', '+923007654321', '+923007654321', 'sana.ali@gmail.com', 'en', 'active']],
      teachers: [['T100', 'E1000', 'Imran Farooqi', 'Senior Teacher', 'Science', 'Faculty of Science', '+923009998888', 'imran.farooqi@carepvtltd.com', 'active']],
      teachingAssignments: [['TA1', 'T100', 'PHY9', 'Physics', 'PHY-9', 'Grade 9', 'A', '2025-2026', 'Term 1', 'CARE Taxila Campus', 'Science', 'active']],
      enrollments: [['S1001', 'TA1', 'active']],
    };
    for (const [entity, cols] of Object.entries(TEMPLATE_COLUMNS) as [keyof typeof TEMPLATE_COLUMNS, string[]][]) {
      const sheetName = entity === 'teachingAssignments' ? 'TeachingAssignments' : entity[0].toUpperCase() + entity.slice(1);
      const ws = wb.addWorksheet(sheetName);
      ws.addRow(cols);
      ws.getRow(1).font = { bold: true };
      for (const ex of examples[entity]) ws.addRow(ex);
      ws.columns.forEach((c) => { c.width = 18; });
    }
    const buf = await wb.xlsx.writeBuffer();
    return buf as unknown as Buffer;
  }
}
