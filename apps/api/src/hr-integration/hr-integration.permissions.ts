import { PrismaClient } from '@prisma/client';

/** Permission gating External HR Integration configuration & synchronization. */
export const HR_INTEGRATION_PERMISSIONS = {
  manage: 'organization.hr.manage',
} as const;

const SEED = [
  { code: HR_INTEGRATION_PERMISSIONS.manage, module: 'organization', description: 'Configure the organization data source and run HR synchronization' },
];

export async function seedHrIntegrationPermissions(prisma: PrismaClient): Promise<void> {
  for (const permission of SEED) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { module: permission.module, description: permission.description },
      create: permission,
    });
  }
}
