import { PrismaClient } from '@prisma/client';

export const AI_PERMISSIONS = {
  read: 'ai.read',
} as const;

const SEED = [
  { code: AI_PERMISSIONS.read, module: 'ai', description: 'View AI insights (blind spots, recommendations, readiness)' },
];

export async function seedAiPermissions(prisma: PrismaClient): Promise<void> {
  for (const permission of SEED) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { module: permission.module, description: permission.description },
      create: permission,
    });
  }
}
