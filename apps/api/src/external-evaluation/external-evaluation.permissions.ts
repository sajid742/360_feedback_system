import { PrismaClient } from '@prisma/client';

export const EXTERNAL_EVAL_PERMISSIONS = {
  manage: 'external.evaluation.manage',
} as const;

const SEED = [
  {
    code: EXTERNAL_EVAL_PERMISSIONS.manage,
    module: 'external_evaluation',
    description: 'Generate, send and track parent/external evaluation links',
  },
];

export async function seedExternalEvaluationPermissions(prisma: PrismaClient): Promise<void> {
  for (const permission of SEED) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { module: permission.module, description: permission.description },
      create: permission,
    });
  }
}
