import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { PassportModule } from '@nestjs/passport';
import { RequestContextInterceptor } from './common/context/request-context.interceptor';
import { SisIntegrationModule } from './sis-integration/sis-integration.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { AuditModule } from './common/audit/audit.module';
import { JwtStrategy } from './common/auth/jwt.strategy';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';
import { OrganizationModule } from './organization/organization.module';
import { CompetencyModule } from './competency/competency.module';
import { CommunicationModule } from './communication/communication.module';
import { QuestionnaireModule } from './questionnaire/questionnaire.module';
import { WorkflowModule } from './workflow/workflow.module';
import { AppraisalModule } from './appraisal/appraisal.module';
import { ReportsModule } from './reports/reports.module';
import { AiModule } from './ai/ai.module';
import { IntegrationModule } from './integration/integration.module';
import { DevelopmentModule } from './development/development.module';
import { UserNotificationModule } from './user-notifications/user-notification.module';
import { ReportScheduleModule } from './report-schedule/report-schedule.module';
import { SisModule } from './sis/sis.module';
import { ExternalEvaluationModule } from './external-evaluation/external-evaluation.module';
import { IdentityModule } from './identity/identity.module';
import { BulkGenerationModule } from './bulk-generation/bulk-generation.module';
import { RbacModule } from './rbac/rbac.module';
import { FeedbackAuditModule } from './feedback-audit/feedback-audit.module';
import { OrgImportModule } from './org-import/org-import.module';
import { HrIntegrationModule } from './hr-integration/hr-integration.module';
import { HealthModule } from './health/health.module';
import { ProvisioningModule } from './provisioning/provisioning.module';
import { LicenseModule } from './license/license.module';

/**
 * Root module. Global PrismaModule + AuditModule are imported once; feature
 * modules are added here as each increment lands (Auth, Organization,
 * Communication next).
 */
@Module({
  imports: [
    LicenseModule,
    ScheduleModule.forRoot(),
    PrismaModule,
    AuditModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    AuthModule,
    ConfigModule,
    OrganizationModule,
    CompetencyModule,
    CommunicationModule,
    QuestionnaireModule,
    WorkflowModule,
    AppraisalModule,
    ReportsModule,
    AiModule,
    IntegrationModule,
    DevelopmentModule,
    UserNotificationModule,
    ReportScheduleModule,
    SisModule,
    IdentityModule,
    ExternalEvaluationModule,
    BulkGenerationModule,
    RbacModule,
    FeedbackAuditModule,
    OrgImportModule,
    HrIntegrationModule,
    SisIntegrationModule,
    HealthModule,
    ProvisioningModule,
  ],
  providers: [
    JwtStrategy,
    // Populates the per-request org context (used by the tenant-aware SIS provider).
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
  ],
})
export class AppModule {}
