import { Injectable } from '@nestjs/common';
import { Workbook } from 'exceljs';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Organization data export (F-H6).
 *
 * Import was one-way: an organization could load its people and structure in but had
 * no way to get them back out — blocking offboarding, reconciliation against an HR
 * system of record, and any "give me our data" request.
 *
 * The workbook deliberately mirrors the IMPORT template exactly (same sheets, same
 * column names), so an export can be edited and fed straight back through the
 * existing import wizard. Passwords are never exported.
 */
const SHEETS = {
  Organization: ['name'],
  Campuses: ['name', 'slug', 'status'],
  Departments: ['name', 'parent', 'campus', 'unitType'],
  Designations: ['name', 'level', 'promotesTo'],
  Employees: ['employeeCode', 'fullName', 'email', 'department', 'designation', 'campus', 'managerCode', 'joinDate', 'status'],
  Competencies: ['category', 'name', 'description'],
} as const;

type SheetName = keyof typeof SHEETS;

@Injectable()
export class OrgExportService {
  constructor(private readonly prisma: PrismaService) {}

  /** Build the export as rows per sheet (also used for the CSV form). */
  async rows(orgId: string): Promise<Record<SheetName, (string | number)[][]>> {
    const [org, campuses, departments, designations, employees, competencies] = await Promise.all([
      this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
      this.prisma.organization.findMany({
        where: { parentOrgId: orgId, orgType: 'campus', deletedAt: null },
        select: { id: true, name: true, slug: true, status: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.department.findMany({
        where: { organizationId: orgId, deletedAt: null },
        select: { id: true, name: true, parentId: true, campusId: true, unitType: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.designation.findMany({
        where: { organizationId: orgId, deletedAt: null },
        select: { id: true, name: true, level: true, promotionToId: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.employee.findMany({
        where: { organizationId: orgId, deletedAt: null },
        select: {
          employeeCode: true, joinDate: true, status: true, lineManagerId: true, id: true,
          user: { select: { fullName: true, email: true } },
          department: { select: { name: true } },
          designation: { select: { name: true } },
          campusId: true,
        },
        orderBy: { employeeCode: 'asc' },
      }),
      this.prisma.competency.findMany({
        where: { organizationId: orgId, deletedAt: null },
        select: { name: true, description: true, category: { select: { name: true } } },
        orderBy: { name: 'asc' },
      }),
    ]);

    const campusName = new Map(campuses.map((c) => [c.id, c.name]));
    const deptName = new Map(departments.map((d) => [d.id, d.name]));
    const desigName = new Map(designations.map((d) => [d.id, d.name]));
    const empCode = new Map(employees.map((e) => [e.id, e.employeeCode]));

    return {
      Organization: [[org?.name ?? '']],
      Campuses: campuses.map((c) => [c.name, c.slug ?? '', c.status ?? 'active']),
      Departments: departments.map((d) => [
        d.name,
        d.parentId ? deptName.get(d.parentId) ?? '' : '',
        d.campusId ? campusName.get(d.campusId) ?? '' : '',
        d.unitType ?? 'department',
      ]),
      Designations: designations.map((d) => [
        d.name,
        d.level ?? 0,
        d.promotionToId ? desigName.get(d.promotionToId) ?? '' : '',
      ]),
      Employees: employees.map((e) => [
        e.employeeCode,
        e.user?.fullName ?? '',
        e.user?.email ?? '',
        e.department?.name ?? '',
        e.designation?.name ?? '',
        e.campusId ? campusName.get(e.campusId) ?? '' : '',
        e.lineManagerId ? empCode.get(e.lineManagerId) ?? '' : '',
        e.joinDate ? e.joinDate.toISOString().slice(0, 10) : '',
        e.status ?? 'active',
      ]),
      Competencies: competencies.map((c) => [c.category?.name ?? '', c.name, c.description ?? '']),
    };
  }

  /** Multi-sheet workbook matching the import template layout. */
  async workbook(orgId: string): Promise<Buffer> {
    const data = await this.rows(orgId);
    const wb = new Workbook();
    wb.creator = '360 Feedback System';
    for (const [sheet, headers] of Object.entries(SHEETS) as [SheetName, readonly string[]][]) {
      const ws = wb.addWorksheet(sheet);
      ws.addRow([...headers]);
      ws.getRow(1).font = { bold: true };
      for (const row of data[sheet]) ws.addRow(row);
      ws.columns.forEach((col) => {
        col.width = Math.max(16, ...(col.values ?? []).map((v) => String(v ?? '').length + 2).slice(0, 200));
      });
    }
    return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
  }

  /** Single-entity CSV (same columns as the corresponding sheet). */
  async csv(orgId: string, sheet: SheetName): Promise<string> {
    const data = await this.rows(orgId);
    const esc = (v: string | number): string => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [SHEETS[sheet].join(',')];
    for (const row of data[sheet]) lines.push(row.map(esc).join(','));
    return lines.join('\n');
  }

  static isSheet(value: string): value is SheetName {
    return Object.prototype.hasOwnProperty.call(SHEETS, value);
  }
}
