import { BadRequestException, Injectable } from '@nestjs/common';
import { Workbook } from 'exceljs';
import { ReportsService } from './reports.service';

export type ExportType = 'institutional' | 'departmental';
export type ExportFormat = 'csv' | 'xlsx';

interface Sheet {
  name: string;
  columns: string[];
  rows: (string | number | null)[][];
}

export interface ExportResult {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

/**
 * Turns the existing Reports aggregates into downloadable CSV / Excel files.
 * No new data access — it composes the ReportsService outputs, so exports always
 * match what the dashboards show. PDF is produced client-side (print view) to
 * avoid adding a headless browser to the backend.
 */
@Injectable()
export class ReportExportService {
  constructor(private readonly reports: ReportsService) {}

  async export(orgId: string, type: ExportType, format: ExportFormat, cycleId?: string): Promise<ExportResult> {
    const sheets = type === 'institutional' ? await this.institutionalSheets(orgId, cycleId) : await this.departmentalSheets(orgId, cycleId);
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `360-${type}-${stamp}`;
    if (format === 'csv') {
      return { buffer: Buffer.from(this.toCsv(sheets), 'utf8'), filename: `${base}.csv`, contentType: 'text/csv; charset=utf-8' };
    }
    if (format === 'xlsx') {
      return {
        buffer: await this.toXlsx(sheets),
        filename: `${base}.xlsx`,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
    }
    throw new BadRequestException('Unsupported export format. Use csv or xlsx.');
  }

  private async departmentalSheets(orgId: string, cycleId?: string): Promise<Sheet[]> {
    const rows = (await this.reports.departmental(orgId, cycleId)) as unknown as {
      department: string;
      participants: number;
      completed: number;
      completionPct: number;
      avgScore: number | null;
    }[];
    return [
      {
        name: 'Departmental',
        columns: ['Department', 'Participants', 'Completed', 'Completion %', 'Average score'],
        rows: rows.map((r) => [r.department, r.participants, r.completed, r.completionPct, r.avgScore]),
      },
    ];
  }

  private async institutionalSheets(orgId: string, cycleId?: string): Promise<Sheet[]> {
    const data = (await this.reports.institutional(orgId, cycleId)) as unknown as {
      participation: { total: number; started: number; completed: number; completionPct: number };
      avgScore: number | null;
      distribution: { bucket: string; count: number }[];
      topPerformers: { name: string; score: number }[];
      bottomPerformers: { name: string; score: number }[];
    };
    return [
      {
        name: 'Summary',
        columns: ['Metric', 'Value'],
        rows: [
          ['Participants', data.participation.total],
          ['Started', data.participation.started],
          ['Completed', data.participation.completed],
          ['Completion %', data.participation.completionPct],
          ['Average score', data.avgScore],
        ],
      },
      {
        name: 'Score distribution',
        columns: ['Band', 'Count'],
        rows: data.distribution.map((d) => [d.bucket, d.count]),
      },
      {
        name: 'Performers',
        columns: ['Group', 'Name', 'Score'],
        rows: [
          ...data.topPerformers.map((p) => ['Top', p.name, p.score] as (string | number | null)[]),
          ...data.bottomPerformers.map((p) => ['Needs support', p.name, p.score] as (string | number | null)[]),
        ],
      },
    ];
  }

  private toCsv(sheets: Sheet[]): string {
    const esc = (v: string | number | null): string => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const blocks = sheets.map((sheet) => {
      const header = sheet.columns.map(esc).join(',');
      const body = sheet.rows.map((row) => row.map(esc).join(',')).join('\n');
      const title = sheets.length > 1 ? `${sheet.name}\n` : '';
      return `${title}${header}\n${body}`;
    });
    return blocks.join('\n\n');
  }

  private async toXlsx(sheets: Sheet[]): Promise<Buffer> {
    const wb = new Workbook();
    wb.creator = 'Enterprise 360';
    wb.created = new Date();
    for (const sheet of sheets) {
      const ws = wb.addWorksheet(sheet.name.slice(0, 31));
      const header = ws.addRow(sheet.columns);
      header.font = { bold: true };
      header.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6D5DFC' } };
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      });
      for (const row of sheet.rows) ws.addRow(row.map((v) => (v === null ? '' : v)));
      ws.columns.forEach((col) => {
        let max = 10;
        col.eachCell?.({ includeEmpty: false }, (cell) => {
          max = Math.max(max, String(cell.value ?? '').length + 2);
        });
        col.width = Math.min(max, 40);
      });
    }
    const arrayBuffer = await wb.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer as ArrayBuffer);
  }
}
