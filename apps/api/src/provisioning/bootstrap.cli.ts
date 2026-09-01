import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { provisionTenant } from './tenant-provisioning';

/**
 * Tenant bootstrap CLI that ships INSIDE the production build (F-C1), so a
 * container deployment can create its first organization:
 *
 *   node dist/provisioning/bootstrap.cli.js --slug care --email sajidq@carepvtltd.com --password "Secret1!"
 *
 * Values resolve from --flags, then environment variables, then defaults.
 * Idempotent: re-running refreshes roles rather than failing.
 */
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function resolve(name: string, envKey: string, fallback: string): string {
  return flag(name) ?? process.env[envKey] ?? fallback;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const result = await provisionTenant(prisma, {
      orgName: resolve('org', 'BOOTSTRAP_ORG', 'CARE Pvt. Ltd.'),
      slug: resolve('slug', 'BOOTSTRAP_SLUG', 'care'),
      email: resolve('email', 'BOOTSTRAP_EMAIL', 'sajidq@carepvtltd.com'),
      password: resolve('password', 'BOOTSTRAP_PASSWORD', 'ChangeMe123!'),
      // --no-starter-content provisions a deliberately empty tenant.
      withStarterContent: !process.argv.includes('--no-starter-content'),
    });
    console.log(
      result.created
        ? `Created organization "${result.slug}" with ${result.rolesSeeded} system roles and admin ${result.email}.`
        : `Organization "${result.slug}" already existed — roles refreshed (${result.rolesSeeded}).`,
    );
    const sc = result.starterContent;
    if (sc) {
      console.log(
        sc.skipped
          ? 'Starter content: skipped (this organization already has a questionnaire template).'
          : `Starter content: ${sc.ratingScales} rating scale, ${sc.competencies} competencies, ${sc.questions} questions, ${sc.templates} questionnaire template.`,
      );
    }
    console.log(`\nLogin:  org slug '${result.slug}'  /  ${result.email}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('Bootstrap failed:', error);
  process.exitCode = 1;
});
