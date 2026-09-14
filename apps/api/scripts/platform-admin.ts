/**
 * db:platform-admin — grant or revoke platform-administrator access.
 *
 * WHY THIS IS A SCRIPT AND NOT AN ENDPOINT. Platform administrators sit above every
 * tenant, so the surface that creates them must not be reachable over HTTP: an operator
 * session that can mint more operators turns one compromised login into a permanent
 * foothold. Making it a script means the act requires database access, which is the
 * same bar as restoring a backup.
 *
 *   npm run -w apps/api db:platform-admin -- --list
 *   npm run -w apps/api db:platform-admin -- --grant  admin@vendor.com --label "Ops"
 *   npm run -w apps/api db:platform-admin -- --revoke admin@vendor.com
 *
 * The account must already exist as a user in some organisation — usually the vendor's
 * own tenant. Platform membership grants nothing inside that tenant and nothing inside
 * any other; it is checked by its own guard against its own table.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

async function list(): Promise<void> {
  const rows = await prisma.platformAdmin.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
    include: { user: { select: { email: true, fullName: true, organization: { select: { slug: true } } } } },
  });
  if (rows.length === 0) {
    console.log('\n  No platform administrators. Grant one with --grant <email>.\n');
    return;
  }
  console.log(`\n  Platform administrators (${rows.length})\n`);
  for (const r of rows) {
    console.log(`    ${r.user.email.padEnd(40)} ${r.label ?? ''}  [org: ${r.user.organization.slug}]`);
  }
  console.log('');
}

async function grant(email: string, label?: string): Promise<void> {
  const user = await prisma.user.findFirst({
    where: { email: email.toLowerCase(), deletedAt: null },
    select: { id: true, email: true, organization: { select: { slug: true } } },
  });
  if (!user) throw new Error(`No user with email "${email}". Create the account first, then grant it.`);

  const existing = await prisma.platformAdmin.findFirst({ where: { userId: user.id, deletedAt: null } });
  if (existing) {
    console.log(`\n  ${user.email} is already a platform administrator.\n`);
    return;
  }
  await prisma.platformAdmin.create({ data: { userId: user.id, label: label ?? null } });
  console.log(`\n  ✓ ${user.email} (org ${user.organization.slug}) is now a platform administrator.\n`);
}

async function revoke(email: string): Promise<void> {
  const user = await prisma.user.findFirst({ where: { email: email.toLowerCase(), deletedAt: null }, select: { id: true, email: true } });
  if (!user) throw new Error(`No user with email "${email}".`);
  const row = await prisma.platformAdmin.findFirst({ where: { userId: user.id, deletedAt: null } });
  if (!row) {
    console.log(`\n  ${user.email} is not a platform administrator.\n`);
    return;
  }
  // Soft-deleted rather than removed, so the history of who held this access survives.
  await prisma.platformAdmin.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
  console.log(`\n  ✓ Platform administration revoked for ${user.email}.\n`);
}

async function main(): Promise<void> {
  const grantEmail = arg('grant');
  const revokeEmail = arg('revoke');

  if (has('list') || (!grantEmail && !revokeEmail)) {
    await list();
    if (!has('list')) {
      console.log('  Usage:  --list | --grant <email> [--label "…"] | --revoke <email>\n');
    }
    return;
  }
  if (grantEmail) await grant(grantEmail, arg('label'));
  if (revokeEmail) await revoke(revokeEmail);
}

main()
  .catch((err) => {
    console.error(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
