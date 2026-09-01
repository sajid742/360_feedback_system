import { Module } from '@nestjs/common';
import { OrgImportController } from './org-import.controller';
import { OrgImportService } from './org-import.service';
import { ParseService } from './services/parse.service';
import { ResolverService } from './services/resolver.service';
import { ValidationService } from './services/validation.service';
import { ImportService } from './services/import.service';
import { TemplateService } from './services/template.service';
import { OrgExportService } from './services/export.service';
import { OrgWritableGuard } from '../common/auth/org-writable.guard';

/** Organization Data Import & Onboarding utility (+ data export, F-H6). */
@Module({
  controllers: [OrgImportController],
  providers: [OrgImportService, ParseService, ResolverService, ValidationService, ImportService, TemplateService, OrgExportService, OrgWritableGuard],
  // Exported so the HR Integration sync can reuse the same reconcile engine.
  exports: [ResolverService, ValidationService, ImportService],
})
export class OrgImportModule {}
