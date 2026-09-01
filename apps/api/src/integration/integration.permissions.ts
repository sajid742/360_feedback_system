import { PrismaClient } from '@prisma/client';

export const INTEGRATION_PERMISSIONS = {
  read: 'integration.read',
  manage: 'integration.manage',
} as const;

const SEED = [
  { code: INTEGRATION_PERMISSIONS.read, module: 'integration', description: 'View API keys and webhooks' },
  { code: INTEGRATION_PERMISSIONS.manage, module: 'integration', description: 'Create/revoke API keys and manage webhooks' },
];

export async function seedIntegrationPermissions(prisma: PrismaClient): Promise<void> {
  for (const permission of SEED) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { module: permission.module, description: permission.description },
      create: permission,
    });
  }
}
