import { PrismaClient } from '@prisma/client';

export const QUESTIONNAIRE_PERMISSIONS = {
  read: 'questionnaire.read',
  questionManage: 'questionnaire.question.manage',
  templateManage: 'questionnaire.template.manage',
  rubricManage: 'questionnaire.rubric.manage',
} as const;

const SEED = [
  { code: QUESTIONNAIRE_PERMISSIONS.read, module: 'questionnaire', description: 'View questionnaires' },
  { code: QUESTIONNAIRE_PERMISSIONS.questionManage, module: 'questionnaire', description: 'Manage question bank' },
  { code: QUESTIONNAIRE_PERMISSIONS.templateManage, module: 'questionnaire', description: 'Manage templates' },
  { code: QUESTIONNAIRE_PERMISSIONS.rubricManage, module: 'questionnaire', description: 'Manage rubrics' },
];

export async function seedQuestionnairePermissions(prisma: PrismaClient): Promise<void> {
  for (const permission of SEED) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { module: permission.module, description: permission.description },
      create: permission,
    });
  }
}
