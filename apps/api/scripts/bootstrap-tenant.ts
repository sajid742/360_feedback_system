import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { provisionTenant } from '../src/provisioning/tenant-provisioning';

/**
 * Dev-time wrapper around the shared tenant-provisioning logic (F-C1). The real
 * implementation now lives in `src/provisioning/` so it also compiles into `dist`
 * and can be run from the production container:
 *   node dist/provisioning/bootstrap.cli.js
 *
 * Values are resolved from (in order): --flags, environment variables, defaults.
 *   npm run db:bootstrap-tenant
 *   npm run db:bootstrap-tenant -- --slug care --email sajidq@carepvtltd.com --password "Secret1!"
 *
 * Defaults: org "CARE Pvt. Ltd.", slug "care", email "sajidq@carepvtltd.com",
 *           password "ChangeMe123!". Run `npm run db:seed` first.
 */
const prisma = new PrismaClient();

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function resolve(name: string, envKey: string, fallback: string): string {
  return flag(name) ?? process.env[envKey] ?? fallback;
}

async function main(): Promise<void> {
  const result = await provisionTenant(prisma, {
    orgName: resolve('org', 'BOOTSTRAP_ORG', 'CARE Pvt. Ltd.'),
    slug: resolve('slug', 'BOOTSTRAP_SLUG', 'care'),
    email: resolve('email', 'BOOTSTRAP_EMAIL', 'sajidq@carepvtltd.com'),
    password: resolve('password', 'BOOTSTRAP_PASSWORD', 'ChangeMe123!'),
    // Parity with the production CLI (src/provisioning/bootstrap.cli.ts), which has
    // always supported this. Without it a dev seeding a tenant that will get its own
    // content (db:sample / db:demo) ends up with two "Standard 360 Review" templates
    // and two overlapping competency sets.
    withStarterContent: !process.argv.includes('--no-starter-content'),
  });
  console.log(
    result.created
      ? `Created org "${result.slug}", ${result.rolesSeeded} system roles, admin ${result.email} (Super Admin)`
      : `Org "${result.slug}" + admin ${result.email} already exist — system roles refreshed (${result.rolesSeeded}).`,
  );
  console.log(`\nLogin:  org slug '${result.slug}'  /  ${result.email}`);
}

main()
  .catch((error) => {
    console.error('Bootstrap failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
