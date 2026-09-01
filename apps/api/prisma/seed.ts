/**
 * Seed runner — runs every module's permission seed idempotently.
 * Invoked by `npm run db:seed`.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { seedConfigurationPermissions } from '../src/config/config.permissions';
import { seedAuthPermissions } from '../src/auth/auth.permissions';
import { seedOrganizationPermissions } from '../src/organization/organization.permissions';
import { seedCompetencyPermissions } from '../src/competency/competency.seed';
import { seedCommunicationPermissions } from '../src/communication/communication.permissions';
import { seedQuestionnairePermissions } from '../src/questionnaire/questionnaire.permissions';
import { seedWorkflowPermissions } from '../src/workflow/workflow.permissions';
import { seedAppraisalPermissions } from '../src/appraisal/appraisal.permissions';
import { seedReportsPermissions } from '../src/reports/reports.permissions';
import { seedAiPermissions } from '../src/ai/ai.permissions';
import { seedIntegrationPermissions } from '../src/integration/integration.permissions';
import { seedDevelopmentPermissions } from '../src/development/development.permissions';
import { seedSisPermissions } from '../src/sis/sis.permissions';
import { seedExternalEvaluationPermissions } from '../src/external-evaluation/external-evaluation.permissions';
import { seedIdentityPermissions } from '../src/identity/identity.permissions';
import { seedRbacPermissions } from '../src/rbac/rbac.permissions';
import { seedFeedbackAuditPermissions } from '../src/feedback-audit/feedback-audit.permissions';
import { seedOrgImportPermissions } from '../src/org-import/org-import.permissions';
import { seedHrIntegrationPermissions } from '../src/hr-integration/hr-integration.permissions';
import { seedSisIntegrationPermissions } from '../src/sis-integration/sis-integration.permissions';

const prisma = new PrismaClient();

const seeders: Array<{ name: string; run: (p: PrismaClient) => Promise<void> }> = [
  { name: 'configuration', run: seedConfigurationPermissions },
  { name: 'auth', run: seedAuthPermissions },
  { name: 'organization', run: seedOrganizationPermissions },
  { name: 'competency', run: seedCompetencyPermissions },
  { name: 'communication', run: seedCommunicationPermissions },
  { name: 'questionnaire', run: seedQuestionnairePermissions },
  { name: 'workflow', run: seedWorkflowPermissions },
  { name: 'appraisal', run: seedAppraisalPermissions },
  { name: 'reports', run: seedReportsPermissions },
  { name: 'ai', run: seedAiPermissions },
  { name: 'integration', run: seedIntegrationPermissions },
  { name: 'development', run: seedDevelopmentPermissions },
  { name: 'sis', run: seedSisPermissions },
  { name: 'external-evaluation', run: seedExternalEvaluationPermissions },
  { name: 'identity', run: seedIdentityPermissions },
  { name: 'rbac', run: seedRbacPermissions },
  { name: 'feedback-audit', run: seedFeedbackAuditPermissions },
  { name: 'org-import', run: seedOrgImportPermissions },
  { name: 'hr-integration', run: seedHrIntegrationPermissions },
  { name: 'sis-integration', run: seedSisIntegrationPermissions },
];

async function main(): Promise<void> {
  for (const seeder of seeders) {
    process.stdout.write(`Seeding ${seeder.name}… `);
    await seeder.run(prisma);
    process.stdout.write('done\n');
  }
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
