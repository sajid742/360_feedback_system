import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../common/auth/permissions.guard';
import { OrgWritableGuard } from '../common/auth/org-writable.guard';
import { RequirePermissions } from '../common/auth/require-permissions.decorator';
import { CurrentUser, ReqContext, type AuthUser, type RequestContext } from '../common/auth/current-user';
import { ORG_IMPORT_PERMISSIONS } from './org-import.permissions';
import { OrgImportService } from './org-import.service';
import { TemplateService } from './services/template.service';
import { OrgExportService } from './services/export.service';
import { ConfirmDto, UploadDto } from './org-import.dto';
import type { ImportEntity, ImportMode } from './org-import.types';

/**
 * Organization Data Import & Onboarding — administrator-only. Gated by
 * `organization.import.manage`. Workflow: Upload → Validate → Preview → Confirm →
 * Import → Verify. Nothing is written until POST /:jobId/confirm.
 */
// OrgWritableGuard disables spreadsheet import (its POST routes) when the tenant is
// in External HR mode — HR is then the source of truth. GET routes (templates) pass.
@Controller('org-import')
@UseGuards(JwtAuthGuard, PermissionsGuard, OrgWritableGuard)
@RequirePermissions(ORG_IMPORT_PERMISSIONS.manage)
export class OrgImportController {
  constructor(
    private readonly svc: OrgImportService,
    private readonly templates: TemplateService,
    private readonly exports: OrgExportService,
  ) {}

  /**
   * Export the organization's current structure and people (F-H6).
   *
   * Import was previously one-way. This produces the SAME sheet/column layout as the
   * import template, so the file can be edited and fed straight back through the
   * import wizard — supporting offboarding, reconciliation against an HR system of
   * record, and data-portability requests. Passwords are never included.
   */
  @Get('export')
  async export(
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
    @Query('format') format: 'xlsx' | 'csv' = 'xlsx',
    @Query('entity') entity = 'Employees',
  ): Promise<void> {
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'csv') {
      if (!OrgExportService.isSheet(entity)) {
        throw new BadRequestException(
          'Unknown export entity. Use Organization, Campuses, Departments, Designations, Employees or Competencies.',
        );
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="organization-${entity.toLowerCase()}-${stamp}.csv"`);
      res.send(await this.exports.csv(user.organizationId, entity));
      return;
    }
    const buffer = await this.exports.workbook(user.organizationId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="organization-export-${stamp}.xlsx"`);
    res.send(buffer);
  }

  /** Upload + validate a file; returns a jobId, preview, errors and warnings. */
  @Post('validate')
  validate(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Body() dto: UploadDto) {
    return this.svc.validateUpload(user, ctx, dto);
  }

  /** Re-plan create/update/skip counts for a different mode (no re-upload). */
  @Get(':jobId/preview')
  preview(@CurrentUser() user: AuthUser, @Param('jobId', ParseUUIDPipe) jobId: string, @Query('mode') mode: ImportMode = 'skip') {
    return this.svc.preview(user, jobId, mode);
  }

  @Get(':jobId')
  get(@CurrentUser() user: AuthUser, @Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.svc.getJob(user, jobId);
  }

  /** Execute the import (the only writing endpoint). */
  @Post(':jobId/confirm')
  confirm(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('jobId', ParseUUIDPipe) jobId: string, @Body() dto: ConfirmDto) {
    return this.svc.confirm(user, ctx, jobId, dto);
  }

  /** Downloadable CSV error/warning report for a job. */
  @Get(':jobId/report')
  async report(@CurrentUser() user: AuthUser, @Res() res: Response, @Param('jobId', ParseUUIDPipe) jobId: string): Promise<void> {
    const csv = await this.svc.reportCsv(user, jobId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="import-report.csv"');
    res.send(csv);
  }

  /**
   * Downloadable template: the flat one-sheet Staff list, the full Excel workbook, or a
   * single-entity CSV.
   *
   * `variant=staff` is the HR twin of the SIS `variant=simple` roster: same columns as
   * the Employees sheet, but the departments, designations and campuses it names are
   * created from the list rather than having to exist first.
   */
  @Get('template/download')
  async template(
    @Res() res: Response,
    @Query('format') format: 'xlsx' | 'csv' = 'xlsx',
    @Query('entity') entity: ImportEntity = 'employees',
    @Query('variant') variant?: string,
  ): Promise<void> {
    if (variant === 'staff') {
      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="staff-list-flat.csv"');
        res.send(this.templates.staffCsv());
        return;
      }
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="staff-list-flat.xlsx"');
      res.send(await this.templates.staffWorkbook());
      return;
    }
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="import-template-${entity}.csv"`);
      res.send(this.templates.csv(entity));
      return;
    }
    const buffer = await this.templates.workbook();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="organization-import-template.xlsx"');
    res.send(buffer);
  }
}
