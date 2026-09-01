import { PrismaClient } from '@prisma/client';

/** Permission gating Student/SIS Integration configuration, import & synchronization. */
export const SIS_INTEGRATION_PERMISSIONS = {
  manage: 'organization.sis.manage',
} as const;

const SEED = [
  { code: SIS_INTEGRATION_PERMISSIONS.manage, module: 'organization', description: 'Configure the student data source and run SIS import/synchronization' },
];

export async function seedSisIntegrationPermissions(prisma: PrismaClient): Promise<void> {
  for (const permission of SEED) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { module: permission.module, description: permission.description },
      create: permission,
    });
  }
}
