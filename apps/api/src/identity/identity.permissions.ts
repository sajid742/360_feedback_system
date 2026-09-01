import { PrismaClient } from '@prisma/client';

export const IDENTITY_PERMISSIONS = {
  manage: 'identity.manage',
} as const;

const SEED = [
  {
    code: IDENTITY_PERMISSIONS.manage,
    module: 'identity',
    description: 'Map external actors (SIS teachers, students, …) to 360 employees',
  },
];

export async function seedIdentityPermissions(prisma: PrismaClient): Promise<void> {
  for (const permission of SEED) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { module: permission.module, description: permission.description },
      create: permission,
    });
  }
}
