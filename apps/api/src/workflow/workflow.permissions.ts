import { PrismaClient } from '@prisma/client';

export const WORKFLOW_PERMISSIONS = {
  read: 'workflow.read',
  manage: 'workflow.definition.manage',
  act: 'workflow.act',
} as const;

const SEED = [
  { code: WORKFLOW_PERMISSIONS.read, module: 'workflow', description: 'View workflows and tasks' },
  { code: WORKFLOW_PERMISSIONS.manage, module: 'workflow', description: 'Manage workflow definitions' },
  { code: WORKFLOW_PERMISSIONS.act, module: 'workflow', description: 'Act on assigned workflow tasks' },
];

export async function seedWorkflowPermissions(prisma: PrismaClient): Promise<void> {
  for (const permission of SEED) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { module: permission.module, description: permission.description },
      create: permission,
    });
  }
}
