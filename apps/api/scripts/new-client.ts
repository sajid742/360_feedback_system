/**
 * db:new-client — turn a development or demo installation into a clean starting point
 * for a new customer, in one command.
 *
 * It is a thin sequence over two things that already exist:
 *   1. `purgeClient()`      — removes the outgoing client's data (scripts/purge-client.ts)
 *   2. `provisionTenant()`  — creates the org, the five system roles, the Super Admin
 *                             and the generic starter content (src/provisioning/…)
 *
 * Nothing about provisioning is duplicated here. If the starter content changes, this
 * command picks it up automatically, because it calls the same function the first-run
 * wizard and `db:bootstrap-tenant` call.
 *
 * WHY THE TWO HALVES ARE ORDERED THIS WAY. Purge and bootstrap run back to back with a
 * verification between them, so the end state is either "the new client exists" or
 * "nothing was deleted". A purge that succeeded and a bootstrap that failed would leave
 * a database with no organisation and no administrator, reachable only from a shell.
 *
 *   npm run db:new-client -- --dry-run --org "New Client Ltd" --slug newclient \
 *     --email admin@newclient.com --password 'Str0ng!Pass'
 *   npm run db:new-client -- --force   --org "New Client Ltd" --slug newclient \
 *     --email admin@newclient.com --password 'Str0ng!Pass'
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { provisionTenant } from '../src/provisioning/tenant-provisioning';
import { integrityReport, purgeClient } from './purge-client';

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

function step(n: number, text: string): void {
  console.log(`\n  [${n}] ${text}`);
}

async function main(): Promise<void> {
  const orgName = arg('org') ?? process.env.ORG_NAME;
  const slug = (arg('slug') ?? process.env.ORG_SLUG)?.toLowerCase();
  const email = (arg('email') ?? process.env.ADMIN_EMAIL)?.toLowerCase();
  const password = arg('password') ?? process.env.ADMIN_PASSWORD;
  const purgeSlug = arg('purge-slug');           // default: purge everything
  const dryRun = has('dry-run');
  const force = has('force');
  const keepExisting = has('keep-existing');     // bootstrap only, purge nothing

  if (!orgName || !slug || !email || !password) {
    throw new Error(
      'Missing details for the new client. Required:\n' +
      '  --org "New Client Ltd"  --slug newclient  --email admin@newclient.com  --password "…"\n' +
      'Optional:\n' +
      '  --purge-slug <slug>   remove only that organisation (default: every organisation)\n' +
      '  --keep-existing       skip the purge entirely and only create the new tenant\n' +
      '  --dry-run             report what would happen and change nothing',
    );
  }
  if (!dryRun && !force) {
    throw new Error('Refusing to run without --force. Use --dry-run first to see what would happen.');
  }

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  NEW CLIENT SETUP${dryRun ? '  (DRY RUN — nothing will change)' : ''}`);
  console.log(`  organisation   ${orgName}  [${slug}]`);
  console.log(`  administrator  ${email}`);
  console.log('══════════════════════════════════════════════════════════════');

  /* -- 1/2. remove the outgoing client -------------------------------------- */
  if (keepExisting) {
    step(1, 'Purge skipped (--keep-existing)');
  } else {
    step(1, purgeSlug ? `Removing existing client data for "${purgeSlug}"` : 'Removing ALL existing client data');
    await purgeClient({ slug: purgeSlug, all: !purgeSlug, dryRun });
  }

  if (dryRun) {
    step(2, 'Would then create the new organisation, Super Admin and starter content');
    console.log('\n  Dry run complete — nothing was changed.');
    console.log(`  To apply:  npm run db:new-client -- --force --org "${orgName}" --slug ${slug} --email ${email} --password '…'\n`);
    return;
  }

  step(2, 'Verifying the database is ready');
  const permissions = await prisma.permission.count();
  if (permissions === 0) {
    throw new Error('The permissions catalogue is empty. Run `npm run db:seed` before creating a client.');
  }
  console.log(`      permissions catalogue: ${permissions} entries — intact`);

  /* -- 3-7. create the new client ------------------------------------------- */
  step(3, 'Creating the organisation, roles, Super Admin and starter content');
  const result = await provisionTenant(prisma, { orgName, slug, email, password });
  const sc = result.starterContent;
  console.log(`      organisation ...... ${result.slug} (${result.created ? 'created' : 'existing, refreshed'})`);
  console.log(`      system roles ...... ${result.rolesSeeded}`);
  console.log(`      administrator ..... ${result.email} (Super Admin)`);
  if (sc && !sc.skipped) {
    console.log(`      rating scale ...... ${sc.ratingScales}`);
    console.log(`      competencies ...... ${sc.competencies}`);
    console.log(`      questions ......... ${sc.questions}`);
    console.log(`      questionnaires .... ${sc.templates}`);
    console.log(`      default settings .. ${sc.configurations}`);
  } else if (sc?.skipped) {
    console.log('      starter content ... skipped (this organisation already had a questionnaire)');
  }

  /* -- 8. integrity ---------------------------------------------------------- */
  step(4, 'Integrity check');
  const report = await integrityReport([]);
  for (const l of report.lines) console.log(l);

  const cycles = await prisma.appraisalCycle.count({ where: { organizationId: result.organizationId } });
  const employees = await prisma.employee.count({ where: { organizationId: result.organizationId } });
  console.log(`  appraisal cycles (should be 0) ............ ${cycles}`);
  console.log(`  employees (should be 0 until imported) .... ${employees}`);

  /* -- 9. summary ------------------------------------------------------------ */
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  READY');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  Sign in with organisation "${slug}" and ${email}`);
  console.log('');
  console.log('  Next steps for the client:');
  console.log('    1. Change the administrator password');
  console.log('    2. Import or add employees (Data Import, or Organization → Add employee)');
  console.log('    3. Review the starter competencies and questionnaires, and edit to taste');
  console.log('    4. Configure Email / SMS / WhatsApp before enabling any channel');
  console.log('    5. Create the first feedback cycle');
  console.log('');
  console.log('  Communication channels are DISABLED until a provider is configured,');
  console.log('  so nothing can be sent by accident.\n');
}

main()
  .catch((e) => { console.error(`\n  ✗ ${(e as Error).message}\n`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
