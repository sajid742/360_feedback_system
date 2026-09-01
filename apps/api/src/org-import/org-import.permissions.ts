import { PrismaClient } from '@prisma/client';

/** Permission gating the Organization Data Import & Onboarding utility. */
export const ORG_IMPORT_PERMISSIONS = {
  manage: 'organization.import.manage',
} as const;

const SEED = [
  { code: ORG_IMPORT_PERMISSIONS.manage, module: 'organization', description: 'Import & onboard organization structure (validate, preview, import)' },
];

export async function seedOrgImportPermissions(prisma: PrismaClient): Promise<void> {
  for (const permission of SEED) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { module: permission.module, description: permission.description },
      create: permission,
    });
  }
}
