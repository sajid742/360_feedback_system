import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { seedSystemRoles, SUPER_ADMIN_ROLE } from '../src/rbac/system-roles';

/**
 * (Re)seed the five predefined system roles for EVERY organization and sync their
 * permission grants. Idempotent — safe to run after new permission codes are added
 * or when upgrading an existing deployment. Run after `npm run db:seed`.
 */
const prisma = new PrismaClient();

async function main(): Promise<void> {
  const orgs = await prisma.organization.findMany({ where: { orgType: 'root', deletedAt: null }, select: { id: true, slug: true } });
  for (const org of orgs) {
    await seedSystemRoles(prisma, org.id);
    // Ensure any existing legacy "Super Administrator" admins also hold the canonical Super Admin role.
    const superAdmin = await prisma.role.findFirst({ where: { organizationId: org.id, name: SUPER_ADMIN_ROLE }, select: { id: true } });
    const legacy = await prisma.role.findFirst({ where: { organizationId: org.id, name: 'Super Administrator' }, select: { id: true } });
    if (superAdmin && legacy) {
      const legacyUsers = await prisma.userRole.findMany({ where: { roleId: legacy.id }, select: { userId: true } });
      if (legacyUsers.length) {
        await prisma.userRole.createMany({ data: legacyUsers.map((u) => ({ userId: u.userId, roleId: superAdmin.id })), skipDuplicates: true });
      }
    }
    console.log(`Seeded 5 system roles for '${org.slug}'.`);
  }
}

main()
  .catch((e) => { console.error('Role seed failed:', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
