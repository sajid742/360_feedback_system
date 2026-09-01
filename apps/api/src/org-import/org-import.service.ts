import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth/current-user';
import { ParseService } from './services/parse.service';
import { ResolverService } from './services/resolver.service';
import { ValidationService } from './services/validation.service';
import { ImportService, type ImportOptions } from './services/import.service';
import type { ImportDataset, ImportEntity, ImportMode, ValidationResult } from './org-import.types';

interface UploadInput { filename: string; contentBase64: string; entity?: ImportEntity; mode?: ImportMode }

@Injectable()
export class OrgImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly parser: ParseService,
    private readonly resolver: ResolverService,
    private readonly validation: ValidationService,
    private readonly importer: ImportService,
  ) {}

  /** Upload → Validate → Preview: parse, validate against existing data, persist a job. */
  async validateUpload(user: AuthUser, ctx: RequestContext, input: UploadInput): Promise<Record<string, unknown>> {
    const { dataset, sheetsFound } = await this.parser.parse(input);
    const totalRows = dataset.campuses.length + dataset.departments.length + dataset.designations.length + dataset.employees.length + dataset.competencies.length;
    if (totalRows === 0) throw new BadRequestException('The file contained no data rows to import.');
    const existing = await this.resolver.loadExisting(user.organizationId);
    const mode = input.mode ?? 'skip';
    const result = this.validation.build(dataset, existing, mode);

    const job = await this.prisma.organizationImportJob.create({
      data: {
        organizationId: user.organizationId,
        createdBy: user.userId,
        createdByName: user.email,
        filename: input.filename,
        status: 'validated',
        dataset: dataset as unknown as Prisma.InputJsonValue,
        validation: result as unknown as Prisma.InputJsonValue,
      },
    });
    await this.audit.record({ organizationId: user.organizationId, userId: user.userId, action: 'organization.import.validate', entityType: 'organization_import', entityId: job.id, newValue: { filename: input.filename, sheetsFound, errors: result.errors.length, warnings: result.warnings.length }, ip: ctx.ip, device: ctx.device });

    return { jobId: job.id, filename: input.filename, sheetsFound, ...result, existing: this.existingSummary(existing), activeCycleCount: existing.activeCycleCount };
  }

  /** Recompute the create/update/skip plan for a different mode without re-uploading. */
  async preview(user: AuthUser, jobId: string, mode: ImportMode): Promise<Record<string, unknown>> {
    const { dataset } = await this.load(user, jobId);
    const existing = await this.resolver.loadExisting(user.organizationId);
    const result = this.validation.build(dataset, existing, mode);
    return { jobId, mode, ...result, existing: this.existingSummary(existing), activeCycleCount: existing.activeCycleCount };
  }

  async getJob(user: AuthUser, jobId: string): Promise<Record<string, unknown>> {
    const job = await this.owned(user, jobId);
    return { jobId: job.id, filename: job.filename, status: job.status, mode: job.mode, validation: job.validation, summary: job.summary, createdAt: job.createdAt, importedAt: job.importedAt };
  }

  /** Confirm → Import → Verify: run the import atomically, persist the summary. */
  async confirm(user: AuthUser, ctx: RequestContext, jobId: string, opts: ImportOptions): Promise<Record<string, unknown>> {
    const job = await this.owned(user, jobId);
    if (job.status === 'imported') throw new BadRequestException('This import has already been applied.');
    const dataset = job.dataset as unknown as ImportDataset;

    // Re-validate against current data at confirm time (data may have changed since upload).
    const existing = await this.resolver.loadExisting(user.organizationId);
    const check = this.validation.build(dataset, existing, opts.mode);
    if (!check.canImport) {
      throw new BadRequestException('The file still has blocking errors and cannot be imported. Re-validate and fix them first.');
    }

    let summary;
    try {
      summary = await this.importer.run(user.organizationId, user.userId, dataset, opts);
    } catch (e) {
      await this.prisma.organizationImportJob.update({ where: { id: job.id }, data: { status: 'failed', mode: opts.mode, summary: { error: (e as Error).message } as unknown as Prisma.InputJsonValue } });
      throw e;
    }
    // Carry the validation warnings into the stored summary for the report.
    summary.warnings = check.warnings;
    const verify = await this.verify(user.organizationId);
    await this.prisma.organizationImportJob.update({ where: { id: job.id }, data: { status: 'imported', mode: opts.mode, importedAt: new Date(), summary: { ...summary, verify } as unknown as Prisma.InputJsonValue } });
    await this.audit.record({ organizationId: user.organizationId, userId: user.userId, action: 'organization.import.execute', entityType: 'organization_import', entityId: job.id, newValue: { mode: opts.mode, perEntity: summary.perEntity }, reason: opts.mode === 'replace' || opts.mode === 'reset' ? `Destructive import (${opts.mode})` : null, ip: ctx.ip, device: ctx.device });

    return { jobId: job.id, status: 'imported', summary, verify };
  }

  /** Post-import verification counts straight from the DB (the "Verify" step). */
  private async verify(orgId: string): Promise<Record<string, number>> {
    const [campuses, departments, designations, employees, withManager, competencies] = await Promise.all([
      this.prisma.organization.count({ where: { parentOrgId: orgId, orgType: 'campus', deletedAt: null } }),
      this.prisma.department.count({ where: { organizationId: orgId, deletedAt: null } }),
      this.prisma.designation.count({ where: { organizationId: orgId, deletedAt: null } }),
      this.prisma.employee.count({ where: { organizationId: orgId, deletedAt: null } }),
      this.prisma.employee.count({ where: { organizationId: orgId, deletedAt: null, lineManagerId: { not: null } } }),
      this.prisma.competency.count({ where: { organizationId: orgId, deletedAt: null } }),
    ]);
    return { campuses, departments, designations, employees, employeesWithManager: withManager, competencies };
  }

  /** CSV error/warning report for a job (validation issues + any import failures). */
  async reportCsv(user: AuthUser, jobId: string): Promise<string> {
    const job = await this.owned(user, jobId);
    const v = (job.validation ?? {}) as unknown as ValidationResult;
    const summary = (job.summary ?? {}) as Record<string, unknown>;
    const rows: Array<{ severity: string; entity: string; row: unknown; field: unknown; key: unknown; message: unknown }> = [];
    for (const e of v.errors ?? []) rows.push({ severity: 'error', entity: e.entity, row: e.row, field: e.field, key: e.key, message: e.message });
    for (const w of v.warnings ?? []) rows.push({ severity: 'warning', entity: w.entity, row: w.row, field: w.field, key: w.key, message: w.message });
    for (const f of (summary.failures as ValidationResult['errors']) ?? []) rows.push({ severity: 'failed', entity: f.entity, row: f.row, field: f.field, key: f.key, message: f.message });
    const esc = (val: unknown) => { const s = val == null ? '' : String(val); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = ['Severity,Entity,Row,Field,Key,Message'];
    for (const r of rows) lines.push([r.severity, r.entity, r.row, r.field, r.key, r.message].map(esc).join(','));
    return lines.join('\n');
  }

  private existingSummary(existing: Awaited<ReturnType<ResolverService['loadExisting']>>): Record<string, number> {
    return {
      campuses: existing.campusesByName.size, departments: existing.departmentsByName.size,
      designations: existing.designationsByName.size, employees: existing.employeesByCode.size,
      competencies: existing.competenciesByName.size,
    };
  }

  private async load(user: AuthUser, jobId: string): Promise<{ dataset: ImportDataset }> {
    const job = await this.owned(user, jobId);
    return { dataset: job.dataset as unknown as ImportDataset };
  }

  private async owned(user: AuthUser, jobId: string) {
    const job = await this.prisma.organizationImportJob.findFirst({ where: { id: jobId, organizationId: user.organizationId } });
    if (!job) throw new NotFoundException('Import job not found.');
    return job;
  }
}
