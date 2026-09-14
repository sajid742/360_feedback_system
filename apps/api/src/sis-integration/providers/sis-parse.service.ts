import { BadRequestException, Injectable } from '@nestjs/common';
import { Workbook, type Worksheet } from 'exceljs';
import { parseCsv } from '../../hr-integration/providers/provider-util';
import { emptyRows, type SisRawRows } from './snapshot-builder';

export interface SisParseInput { filename: string; base64: string; entity?: string }

const SHEET_ENTITY: Record<string, keyof SisRawRows> = {
  // The flat sheet — one row per student x subject. Kept distinct from `Students`
  // because a roster repeats each student across their subjects, which the Students
  // sheet correctly rejects as duplicate ids.
  roster: 'roster', flat: 'roster', combined: 'roster', studentsandteachers: 'roster', studentteachers: 'roster',
  students: 'students', student: 'students',
  guardians: 'guardians', guardian: 'guardians', parents: 'guardians', parent: 'guardians',
  teachers: 'teachers', teacher: 'teachers', staff: 'teachers',
  teachingassignments: 'teachingAssignments', assignments: 'teachingAssignments', assignment: 'teachingAssignments', teaching: 'teachingAssignments',
  enrollments: 'enrollments', enrolments: 'enrollments', enrollment: 'enrollments',
};

/**
 * Canonical template columns per entity (used by the downloadable multi-sheet template).
 * `roster` is excluded on purpose — it is the single-sheet alternative, not one of the
 * five sheets, and lives in ROSTER_COLUMNS below.
 */
export const TEMPLATE_COLUMNS: Record<Exclude<keyof SisRawRows, 'roster'>, string[]> = {
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
      if (!entity) throw new BadRequestException('For a CSV upload, specify a valid entity (roster, students, guardians, teachers, teachingAssignments, enrollments).');
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
      throw new BadRequestException('No recognised sheets found. Expected a sheet named Roster (the single-sheet format), or Students, Guardians, Teachers, TeachingAssignments, Enrollments.');
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

  /**
   * The FLAT template: ONE sheet, one row per student x subject.
   *
   * This is the shape a SQL join produces — the student and parent columns repeat on
   * every one of that student's rows, and the teacher/subject columns say who teaches
   * them what. It is written for an HR user who should not have to know what an entity
   * or a relationship is, and it covers the WHOLE chain the five-sheet template covers:
   *
   *   Student -> class/section -> Parent -> contact
   *   Student -> Subject -> Teacher -> 360 employee   (via Teacher Employee Code)
   *
   * `expandRoster()` in snapshot-builder unfolds it: students, guardians, teachers,
   * teaching assignments and enrolments are all de-duplicated out of the repetition.
   * Leave the teacher columns blank and it degrades to a plain roster.
   */
  async templateSimple(): Promise<Buffer> {
    const wb = new Workbook();

    const intro = wb.addWorksheet('Instructions');
    const lines: [string, boolean?][] = [
      ['Student roster — single-sheet import', true],
      [''],
      ['Fill the "Roster" sheet and upload it on Student Integration -> Import.'],
      [''],
      ['ONE ROW PER STUDENT PER SUBJECT', true],
      ['A student taking four subjects has FOUR rows. Repeat their name, class, section'],
      ['and parent details on every one of those rows — that repetition is expected and'],
      ['is not a mistake. The import recognises the repeats and creates the student once,'],
      ['the parent once, and each teacher once.'],
      [''],
      ['WHAT IS REQUIRED', true],
      ['Only "Student ID" is required.'],
      ['To send parent-feedback links you also need a parent mobile, WhatsApp or e-mail.'],
      ['To collect feedback ABOUT TEACHERS you also need, on each row:'],
      ['    Teacher Employee Code   (the code that identifies them in the 360 system)'],
      ['    Subject'],
      ['    Class and Section'],
      ['Leave the teacher columns blank and you still get a student roster with parent'],
      ['contacts — you simply cannot ask parents about teachers.'],
      [''],
      ['TEACHER EMPLOYEE CODE IS THE IMPORTANT ONE', true],
      ['It must match the employee code of that teacher in the 360 system. That match is'],
      ['what routes the parent’s feedback onto the teacher’s own appraisal. A teacher'],
      ['with a name but no code is imported and then goes nowhere.'],
      [''],
      ['THE STUDENT ID IS THE IDENTITY', true],
      ['Keep it the same for the same person, every time you import. A student who moves'],
      ['class or changes teacher stays the SAME student and is updated, not duplicated.'],
      ['A student left out of a later file is marked inactive, never deleted, so feedback'],
      ['already collected about their teachers is preserved.'],
      [''],
      ['IF TWO ROWS DISAGREE', true],
      ['If S1001 says "Grade 9" on one row and "Grade 10" on another, the FIRST is used'],
      ['and the import warns you, naming both rows. Nothing is guessed silently.'],
      [''],
      ['MOBILE NUMBERS — PLEASE READ', true],
      ['The mobile columns are formatted as Text so a leading zero is not lost.'],
      ['If you retype or paste over them, keep them as Text, or write the number in'],
      ['international form (+923001234567). Excel turns 03001234567 into 3001234567 when'],
      ['the cell is a number, and messages to that parent will silently fail.'],
      [''],
      ['You may add extra columns of your own — unrecognised columns are ignored.'],
      ['The five-sheet template is still available and still works; use it if your data'],
      ['already comes out of an SIS in that shape.'],
    ];
    for (const [text, bold] of lines) {
      const row = intro.addRow([text]);
      if (bold) row.getCell(1).font = { bold: true };
    }
    intro.getRow(1).getCell(1).font = { bold: true, size: 14 };
    intro.getColumn(1).width = 92;

    // Headings are the HR-facing wording. `pick()` normalises case, spaces and
    // underscores before matching its synonym list, so "Student ID" resolves to
    // student_id, "Teacher Employee Code" to teacher_employee_code, and so on.
    const COLUMNS = [
      'Student ID', 'Student Name', 'Class', 'Section', 'Department', 'Campus', 'Session',
      'Gender', 'Status', 'Parent Name', 'Relationship', 'Parent Mobile', 'Parent WhatsApp', 'Parent Email',
      'Teacher Employee Code', 'Teacher Name', 'Subject', 'Subject Code',
    ];
    const ws = wb.addWorksheet('Roster');
    ws.addRow(COLUMNS);
    ws.getRow(1).font = { bold: true };

    /*
     * The examples carry the three things people get wrong, deliberately:
     *   - S1001 spans two rows (two subjects, two teachers) with everything repeated
     *   - S1002 is a sibling on the SAME parent contact
     *   - E1000 teaches two different students, so one teacher spans three rows
     */
    const P1 = ['Imran Ali', 'Father', '+923001234567', '+923001234567', 'imran.ali@gmail.com'];
    const P2 = ['Rashid Khan', 'Father', '+923009876543', '+923009876543', 'rashid.khan@gmail.com'];
    const examples = [
      ['S1001', 'Ahmed Ali', 'Grade 9', 'A', 'Science', 'CARE Taxila Campus', '2025-2026', 'Male', 'active', ...P1, 'E1000', 'Imran Farooqi', 'Physics', 'PHY-9'],
      ['S1001', 'Ahmed Ali', 'Grade 9', 'A', 'Science', 'CARE Taxila Campus', '2025-2026', 'Male', 'active', ...P1, 'E1002', 'Ayesha Noor', 'Mathematics', 'MTH-9'],
      ['S1002', 'Sara Ali', 'Grade 7', 'B', 'Science', 'CARE Taxila Campus', '2025-2026', 'Female', 'active', ...P1, 'E1003', 'Kamran Shah', 'English', 'ENG-7'],
      ['S1003', 'Hamza Khan', 'Grade 9', 'A', 'Science', 'CARE Taxila Campus', '2025-2026', 'Male', 'active', ...P2, 'E1000', 'Imran Farooqi', 'Physics', 'PHY-9'],
    ];
    for (const ex of examples) ws.addRow(ex);

    ws.columns.forEach((c) => { c.width = 20; });
    // Text format on the two phone columns. Without this Excel stores 03001234567 as
    // the NUMBER 3001234567 and the leading zero is gone by the time we read the cell.
    for (const header of ['Parent Mobile', 'Parent WhatsApp']) {
      const idx = COLUMNS.indexOf(header) + 1;
      if (idx > 0) ws.getColumn(idx).numFmt = '@';
    }
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    const buf = await wb.xlsx.writeBuffer();
    return buf as unknown as Buffer;
  }
}
