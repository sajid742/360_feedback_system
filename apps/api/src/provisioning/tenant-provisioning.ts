import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { seedSystemRoles, SUPER_ADMIN_ROLE } from '../rbac/system-roles';
import { seedStarterContent, type StarterContentResult } from './starter-content';

/**
 * Tenant provisioning (F-C1). Lives under `src/` — rather than in `scripts/`, which
 * is excluded from the production build — so it compiles into `dist` and can be run
 * from the shipped container image (`node dist/provisioning/bootstrap.cli.js`).
 * Previously the only way to create an organization was a ts-node script that the
 * runtime image does not contain, so a container deployment could never create its
 * first tenant.
 *
 * Idempotent: safe to re-run to refresh roles or repair a partial setup.
 */
export interface ProvisionTenantOptions {
  orgName: string;
  slug: string;
  email: string;
  password: string;
  /**
   * Seed neutral starter content (rating scale, competencies, questionnaire) so the
   * tenant can actually author a cycle on day one. Defaults to true; pass false for
   * an intentionally empty tenant. Never overwrites existing configuration.
   */
  withStarterContent?: boolean;
}

export interface ProvisionTenantResult {
  organizationId: string;
  slug: string;
  email: string;
  created: boolean;
  rolesSeeded: number;
  starterContent?: StarterContentResult;
}

export async function provisionTenant(
  prisma: PrismaClient,
  opts: ProvisionTenantOptions,
): Promise<ProvisionTenantResult> {
  const slug = opts.slug.toLowerCase();
  const email = opts.email.toLowerCase();

  const permissions = await prisma.permission.findMany({ select: { code: true } });
  if (permissions.length === 0) {
    throw new Error('No permissions found — run the permission seed (`npm run db:seed`) first.');
  }

  const org =
    (await prisma.organization.findUnique({ where: { slug } })) ??
    (await prisma.organization.create({ data: { name: opts.orgName, slug, orgType: 'root' } }));

  // Five predefined system roles, permission grants synced. Idempotent.
  await seedSystemRoles(prisma, org.id);
  const superAdmin = await prisma.role.findFirstOrThrow({
    where: { organizationId: org.id, name: SUPER_ADMIN_ROLE },
  });

  const existingAdmin = await prisma.user.findFirst({
    where: { organizationId: org.id, email },
    select: { id: true },
  });
  let created = false;
  if (existingAdmin) {
    await prisma.userRole.createMany({
      data: [{ userId: existingAdmin.id, roleId: superAdmin.id }],
      skipDuplicates: true,
    });
  } else {
    await prisma.user.create({
      data: {
        organizationId: org.id,
        email,
        passwordHash: await bcrypt.hash(opts.password, 10),
        fullName: 'Administrator',
        userRoles: { create: { roleId: superAdmin.id } },
      },
    });
    created = true;
  }

  const roleCount = await prisma.role.count({ where: { organizationId: org.id } });
  const result: ProvisionTenantResult = {
    organizationId: org.id,
    slug,
    email,
    created,
    rolesSeeded: roleCount,
  };

  // A tenant with no rating scale, competencies or questionnaire cannot run a cycle
  // at all, so starter content is seeded by default (F-C2).
  if (opts.withStarterContent !== false) {
    result.starterContent = await seedStarterContent(prisma, org.id);
  }
  return result;
}
