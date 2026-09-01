import { PrismaClient } from '@prisma/client';

export const SIS_PERMISSIONS = {
  read: 'sis.read',
} as const;

const SEED = [{ code: SIS_PERMISSIONS.read, module: 'sis', description: 'Browse Student Information System data' }];

export async function seedSisPermissions(prisma: PrismaClient): Promise<void> {
  for (const permission of SEED) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { module: permission.module, description: permission.description },
      create: permission,
    });
  }
}
