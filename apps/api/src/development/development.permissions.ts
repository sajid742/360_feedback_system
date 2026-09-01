import { PrismaClient } from '@prisma/client';

export const DEVELOPMENT_PERMISSIONS = {
  read: 'development.read',
  manage: 'development.manage',
} as const;

const SEED = [
  { code: DEVELOPMENT_PERMISSIONS.read, module: 'development', description: 'View development action plans' },
  { code: DEVELOPMENT_PERMISSIONS.manage, module: 'development', description: 'Create and update development actions' },
];

export async function seedDevelopmentPermissions(prisma: PrismaClient): Promise<void> {
  for (const permission of SEED) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { module: permission.module, description: permission.description },
      create: permission,
    });
  }
}
