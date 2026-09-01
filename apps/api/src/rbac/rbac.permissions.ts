import { PrismaClient } from '@prisma/client';

/** Permission that gates the RBAC administration (users, roles, assignments). */
export const RBAC_PERMISSIONS = {
  manage: 'security.rbac.manage',
} as const;

const SEED = [
  { code: RBAC_PERMISSIONS.manage, module: 'system', description: 'Manage users, roles and assignments (RBAC)' },
];

export async function seedRbacPermissions(prisma: PrismaClient): Promise<void> {
  for (const permission of SEED) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { module: permission.module, description: permission.description },
      create: permission,
    });
  }
}
