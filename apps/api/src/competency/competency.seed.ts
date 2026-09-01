import { PrismaClient } from '@prisma/client';
import { COMPETENCY_PERMISSION_SEED } from './competency.permissions';

/**
 * Seeds the Competency module's permission rows (idempotent). Called by the
 * monorepo's `prisma/seed.ts`, which runs every module's seed. Permissions are
 * data; roles are granted these codes via role_permissions by the tenant
 * bootstrap / RBAC admin — never assigned to hardcoded role names here.
 */
export async function seedCompetencyPermissions(prisma: PrismaClient): Promise<void> {
  for (const permission of COMPETENCY_PERMISSION_SEED) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { module: permission.module, description: permission.description },
      create: permission,
    });
  }
}
