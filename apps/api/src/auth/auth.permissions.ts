import { PrismaClient } from '@prisma/client';

/** Auth permission codes (data). Most auth endpoints are self-service (any
 *  authenticated user); these gate administrative security views. */
export const AUTH_PERMISSIONS = {
  sessionManage: 'auth.session.manage',
  securityAdmin: 'auth.security.admin',
} as const;

const SEED = [
  { code: AUTH_PERMISSIONS.sessionManage, module: 'auth', description: 'View/revoke sessions' },
  { code: AUTH_PERMISSIONS.securityAdmin, module: 'auth', description: 'Administer auth security settings' },
];

export async function seedAuthPermissions(prisma: PrismaClient): Promise<void> {
  for (const permission of SEED) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { module: permission.module, description: permission.description },
      create: permission,
    });
  }
}
