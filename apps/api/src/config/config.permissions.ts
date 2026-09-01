import { PrismaClient } from '@prisma/client';

/** Configuration module permission codes (data, seeded rows). */
export const CONFIG_PERMISSIONS = {
  read: 'configuration.read',
  manage: 'configuration.manage',
  featureFlagRead: 'configuration.feature_flag.read',
  featureFlagManage: 'configuration.feature_flag.manage',
  ratingScaleRead: 'configuration.rating_scale.read',
  ratingScaleManage: 'configuration.rating_scale.manage',
} as const;

const SEED = [
  { code: CONFIG_PERMISSIONS.read, module: 'configuration', description: 'View configuration' },
  { code: CONFIG_PERMISSIONS.manage, module: 'configuration', description: 'Manage configuration' },
  { code: CONFIG_PERMISSIONS.featureFlagRead, module: 'configuration', description: 'View feature flags' },
  { code: CONFIG_PERMISSIONS.featureFlagManage, module: 'configuration', description: 'Manage feature flags' },
  { code: CONFIG_PERMISSIONS.ratingScaleRead, module: 'configuration', description: 'View rating scales' },
  { code: CONFIG_PERMISSIONS.ratingScaleManage, module: 'configuration', description: 'Manage rating scales' },
];

export async function seedConfigurationPermissions(prisma: PrismaClient): Promise<void> {
  for (const permission of SEED) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { module: permission.module, description: permission.description },
      create: permission,
    });
  }
}
