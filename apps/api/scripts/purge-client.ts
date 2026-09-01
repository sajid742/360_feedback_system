/**
 * db:purge-client — remove one client's (or every client's) operational data so the
 * database can be handed to a new customer.
 *
 * WHAT THIS IS FOR. A development or demo installation accumulates a specific
 * customer's world: their organisation, people, cycles, feedback, roster and
 * settings. Handing that database to a new client means removing all of it while
 * keeping the things the application itself needs to run. There was no way to do
 * that — this is it.
 *
 * WHAT IT KEEPS. The schema, `schema_migrations`, and the global `permissions`
 * catalogue. Those are code-derived: `provisionTenant()` refuses to run without
 * permissions, so deleting them would brick the install rather than clean it.
 *
 * WHAT IT REMOVES. Everything scoped to the target organisation(s) — including the
 * organisation rows themselves, their campuses (which are `organizations` rows with
 * `org_type='campus'`, not a separate table), their users, and the tenant's own
 * competencies, questions, templates and rating scales. A new client gets a fresh
 * generic library from `seedStarterContent()`, not the previous client's edits.
 *
 * SAFETY. Nothing happens without `--force`. `--dry-run` reports what would go.
 * A target must be named explicitly (`--slug` or `--all`) so a mistyped argument
 * cannot quietly select everything. The whole deletion runs in ONE transaction, so
 * a failure leaves the database exactly as it was rather than half-purged.
 *
 *   npm run db:purge-client -- --dry-run --slug care
 *   npm run db:purge-client -- --force   --slug care
 *   npm run db:purge-client -- --force   --all
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

/** Host/database of the connection actually in use, for the confirmation banner. */
function describeTarget(): { host: string; database: string; raw: string } {
  const raw = process.env.DATABASE_URL ?? '';
  try {
    const u = new URL(raw);
    return { host: `${u.hostname}:${u.port || '5432'}`, database: u.pathname.replace(/^\//, ''), raw };
  } catch {
    return { host: '(unparsed)', database: '(unknown)', raw };
  }
}

/**
 * Refuse to run against something that looks like production unless the operator
 * says so out loud. Deliberately a heuristic, not a security control — it exists to
 * catch a wrong terminal, not a determined mistake.
 */
function assertEnvironmentAllowed(database: string, raw: string): void {
  const looksProd = /prod|live/i.test(database) || /prod|live/i.test(raw);
  if (looksProd && process.env.ALLOW_DESTRUCTIVE_RESET !== 'true') {
    throw new Error(
      `Refusing to purge: the target database ("${database}") looks like production.\n` +
      `If that is genuinely what you want, re-run with ALLOW_DESTRUCTIVE_RESET=true set.`,
    );
  }
}

/* ------------------------------------------------------------------ counts */

/** Categories reported by --dry-run and after the purge. */
const COUNT_SQL: { label: string; sql: (ids: string[]) => string }[] = [
  { label: 'organizations (incl. campuses)', sql: () => `SELECT count(*)::int FROM organizations WHERE id = ANY($1::uuid[])` },
  { label: 'users', sql: () => `SELECT count(*)::int FROM users WHERE organization_id = ANY($1::uuid[])` },
  { label: 'employees', sql: () => `SELECT count(*)::int FROM employees WHERE organization_id = ANY($1::uuid[])` },
  { label: 'departments', sql: () => `SELECT count(*)::int FROM departments WHERE organization_id = ANY($1::uuid[])` },
  { label: 'designations', sql: () => `SELECT count(*)::int FROM designations WHERE organization_id = ANY($1::uuid[])` },
  { label: 'roles', sql: () => `SELECT count(*)::int FROM roles WHERE organization_id = ANY($1::uuid[])` },
  { label: 'appraisal cycles', sql: () => `SELECT count(*)::int FROM appraisal_cycles WHERE organization_id = ANY($1::uuid[])` },
  { label: 'reviewer assignments', sql: () => `SELECT count(*)::int FROM reviewer_assignments WHERE organization_id = ANY($1::uuid[])` },
  { label: 'feedback responses', sql: () => `SELECT count(*)::int FROM feedback_responses fr JOIN reviewer_assignments ra ON ra.id = fr.assignment_id WHERE ra.organization_id = ANY($1::uuid[])` },
  { label: 'parent evaluation links', sql: () => `SELECT count(*)::int FROM evaluation_links WHERE organization_id = ANY($1::uuid[])` },
  { label: 'SIS roster snapshots', sql: () => `SELECT count(*)::int FROM sis_datasets WHERE organization_id = ANY($1::uuid[])` },
  { label: 'identity maps (teacher→employee)', sql: () => `SELECT count(*)::int FROM external_identity_maps WHERE organization_id = ANY($1::uuid[])` },
  { label: 'competencies', sql: () => `SELECT count(*)::int FROM competencies WHERE organization_id = ANY($1::uuid[])` },
  { label: 'questions', sql: () => `SELECT count(*)::int FROM questions WHERE organization_id = ANY($1::uuid[])` },
  { label: 'questionnaire templates', sql: () => `SELECT count(*)::int FROM questionnaire_templates WHERE organization_id = ANY($1::uuid[])` },
  { label: 'rating scales', sql: () => `SELECT count(*)::int FROM rating_scales WHERE organization_id = ANY($1::uuid[])` },
  { label: 'notifications', sql: () => `SELECT count(*)::int FROM notifications WHERE organization_id = ANY($1::uuid[])` },
  { label: 'short links', sql: () => `SELECT count(*)::int FROM short_links WHERE organization_id = ANY($1::uuid[])` },
  { label: 'API keys', sql: () => `SELECT count(*)::int FROM api_keys WHERE organization_id = ANY($1::uuid[])` },
  { label: 'webhook endpoints', sql: () => `SELECT count(*)::int FROM webhook_endpoints WHERE organization_id = ANY($1::uuid[])` },
  { label: 'configurations', sql: () => `SELECT count(*)::int FROM configurations WHERE organization_id = ANY($1::uuid[])` },
  { label: 'audit log entries', sql: () => `SELECT count(*)::int FROM audit_logs WHERE organization_id = ANY($1::uuid[])` },
  { label: 'feedback audit events', sql: () => `SELECT count(*)::int FROM feedback_audit_events WHERE organization_id = ANY($1::uuid[])` },
];

async function countAll(ids: string[]): Promise<{ label: string; n: number }[]> {
  const out: { label: string; n: number }[] = [];
  for (const c of COUNT_SQL) {
    const rows = await prisma.$queryRawUnsafe<{ count: number }[]>(c.sql(ids), ids);
    out.push({ label: c.label, n: Number(rows[0]?.count ?? 0) });
  }
  return out;
}

/* ------------------------------------------------------------------ purge */

/**
 * Deletion order, derived from the live foreign-key graph rather than assumed.
 *
 * Three relationships decide most of this order and each has bitten before:
 *   - `evaluation_link_targets.reviewer_assignment_id` is NO ACTION, so targets must
 *     go before assignments (this exact FK once broke the test teardown);
 *   - `employees.line_manager_id` is a self-reference, so it is nulled before the
 *     rows are removed;
 *   - `employees.user_id` points at users, so employees go before users.
 * Everything marked CASCADE below is deleted anyway, so the order stays correct even
 * if a cascade is changed later.
 */
const DELETE_STEPS: { label: string; sql: string }[] = [
  // --- feedback graph (deepest first) ---
  { label: 'feedback responses', sql: `DELETE FROM feedback_responses WHERE assignment_id IN (SELECT id FROM reviewer_assignments WHERE organization_id = ANY($1::uuid[]))` },
  { label: 'evaluation link targets', sql: `DELETE FROM evaluation_link_targets WHERE link_id IN (SELECT id FROM evaluation_links WHERE organization_id = ANY($1::uuid[]))` },
  { label: 'evaluation links', sql: `DELETE FROM evaluation_links WHERE organization_id = ANY($1::uuid[])` },
  { label: 'reviewer assignments', sql: `DELETE FROM reviewer_assignments WHERE organization_id = ANY($1::uuid[])` },
  { label: 'appraisal participants', sql: `DELETE FROM appraisal_participants WHERE cycle_id IN (SELECT id FROM appraisal_cycles WHERE organization_id = ANY($1::uuid[]))` },
  { label: 'feedback sources', sql: `DELETE FROM feedback_sources WHERE cycle_id IN (SELECT id FROM appraisal_cycles WHERE organization_id = ANY($1::uuid[]))` },
  { label: 'report schedules', sql: `DELETE FROM report_schedules WHERE organization_id = ANY($1::uuid[])` },
  { label: 'bulk generation runs', sql: `DELETE FROM bulk_generation_runs WHERE organization_id = ANY($1::uuid[])` },
  { label: 'appraisal cycles', sql: `DELETE FROM appraisal_cycles WHERE organization_id = ANY($1::uuid[])` },

  // --- audit (append-only trigger handled by the caller) ---
  { label: 'feedback audit events', sql: `DELETE FROM feedback_audit_events WHERE organization_id = ANY($1::uuid[])` },
  { label: 'audit logs', sql: `DELETE FROM audit_logs WHERE organization_id = ANY($1::uuid[])` },

  // --- integrations & rosters ---
  { label: 'SIS roster snapshots', sql: `DELETE FROM sis_datasets WHERE organization_id = ANY($1::uuid[])` },
  { label: 'SIS sync runs', sql: `DELETE FROM sis_sync_runs WHERE organization_id = ANY($1::uuid[])` },
  { label: 'HR sync runs', sql: `DELETE FROM hr_sync_runs WHERE organization_id = ANY($1::uuid[])` },
  { label: 'identity maps', sql: `DELETE FROM external_identity_maps WHERE organization_id = ANY($1::uuid[])` },
  { label: 'organisation import jobs', sql: `DELETE FROM organization_import_jobs WHERE organization_id = ANY($1::uuid[])` },

  // --- communication ---
  { label: 'notifications', sql: `DELETE FROM notifications WHERE organization_id = ANY($1::uuid[])` },
  { label: 'communication campaigns', sql: `DELETE FROM communication_campaigns WHERE organization_id = ANY($1::uuid[])` },
  { label: 'short links', sql: `DELETE FROM short_links WHERE organization_id = ANY($1::uuid[])` },
  { label: 'user notifications', sql: `DELETE FROM user_notifications WHERE organization_id = ANY($1::uuid[])` },

  // --- workflows ---
  { label: 'workflow tasks', sql: `DELETE FROM workflow_tasks WHERE instance_id IN (SELECT id FROM workflow_instances WHERE organization_id = ANY($1::uuid[]))` },
  { label: 'workflow instances', sql: `DELETE FROM workflow_instances WHERE organization_id = ANY($1::uuid[])` },
  { label: 'workflow steps', sql: `DELETE FROM workflow_steps WHERE definition_id IN (SELECT id FROM workflow_definitions WHERE organization_id = ANY($1::uuid[]))` },
  { label: 'workflow definitions', sql: `DELETE FROM workflow_definitions WHERE organization_id = ANY($1::uuid[])` },

  // --- integrations the client issued to third parties ---
  { label: 'webhook deliveries', sql: `DELETE FROM webhook_deliveries WHERE endpoint_id IN (SELECT id FROM webhook_endpoints WHERE organization_id = ANY($1::uuid[]))` },
  { label: 'webhook endpoints', sql: `DELETE FROM webhook_endpoints WHERE organization_id = ANY($1::uuid[])` },
  { label: 'API keys', sql: `DELETE FROM api_keys WHERE organization_id = ANY($1::uuid[])` },

  // --- development ---
  { label: 'development actions', sql: `DELETE FROM development_actions WHERE organization_id = ANY($1::uuid[])` },

  // --- competency / questionnaire library (the CLIENT'S copy) ---
  { label: 'competency-designation mappings', sql: `DELETE FROM competency_designation_mappings WHERE organization_id = ANY($1::uuid[])` },
  { label: 'rubrics', sql: `DELETE FROM rubrics WHERE organization_id = ANY($1::uuid[])` },
  { label: 'behaviour indicators', sql: `DELETE FROM behaviour_indicators WHERE organization_id = ANY($1::uuid[])` },
  { label: 'proficiency levels', sql: `DELETE FROM proficiency_levels WHERE organization_id = ANY($1::uuid[])` },
  { label: 'competency versions', sql: `DELETE FROM competency_versions WHERE organization_id = ANY($1::uuid[])` },
  { label: 'section questions', sql: `DELETE FROM section_questions WHERE section_id IN (SELECT ts.id FROM template_sections ts JOIN questionnaire_templates t ON t.id = ts.template_id WHERE t.organization_id = ANY($1::uuid[]))` },
  { label: 'template sections', sql: `DELETE FROM template_sections WHERE template_id IN (SELECT id FROM questionnaire_templates WHERE organization_id = ANY($1::uuid[]))` },
  { label: 'questionnaire templates', sql: `DELETE FROM questionnaire_templates WHERE organization_id = ANY($1::uuid[])` },
  { label: 'questions', sql: `DELETE FROM questions WHERE organization_id = ANY($1::uuid[])` },
  { label: 'competencies', sql: `DELETE FROM competencies WHERE organization_id = ANY($1::uuid[])` },
  { label: 'competency categories', sql: `DELETE FROM competency_categories WHERE organization_id = ANY($1::uuid[])` },
  { label: 'rating scale levels', sql: `DELETE FROM rating_scale_levels WHERE rating_scale_id IN (SELECT id FROM rating_scales WHERE organization_id = ANY($1::uuid[]))` },
  { label: 'rating scales', sql: `DELETE FROM rating_scales WHERE organization_id = ANY($1::uuid[])` },

  // --- people ---
  { label: 'matrix manager links', sql: `DELETE FROM employee_matrix_managers WHERE employee_id IN (SELECT id FROM employees WHERE organization_id = ANY($1::uuid[])) OR manager_id IN (SELECT id FROM employees WHERE organization_id = ANY($1::uuid[]))` },
  // The self-reference must be broken before the rows go, or the delete order matters.
  { label: 'employee reporting lines (nulled)', sql: `UPDATE employees SET line_manager_id = NULL WHERE organization_id = ANY($1::uuid[])` },
  { label: 'employees', sql: `DELETE FROM employees WHERE organization_id = ANY($1::uuid[])` },
  { label: 'designation promotion paths (nulled)', sql: `UPDATE designations SET promotion_to_id = NULL WHERE organization_id = ANY($1::uuid[])` },
  { label: 'designations', sql: `DELETE FROM designations WHERE organization_id = ANY($1::uuid[])` },
  { label: 'department hierarchy (nulled)', sql: `UPDATE departments SET parent_id = NULL WHERE organization_id = ANY($1::uuid[])` },
  { label: 'departments', sql: `DELETE FROM departments WHERE organization_id = ANY($1::uuid[])` },

  // --- settings ---
  { label: 'configurations', sql: `DELETE FROM configurations WHERE organization_id = ANY($1::uuid[])` },
  { label: 'feature flags', sql: `DELETE FROM feature_flags WHERE organization_id = ANY($1::uuid[])` },
  { label: 'system settings', sql: `DELETE FROM system_settings WHERE organization_id = ANY($1::uuid[])` },

  // --- auth & sessions (users last of the people tables) ---
  { label: 'login attempts', sql: `DELETE FROM login_attempts WHERE organization_id = ANY($1::uuid[])` },
  { label: 'OTP codes', sql: `DELETE FROM otp_codes WHERE organization_id = ANY($1::uuid[])` },
  { label: 'password reset tokens', sql: `DELETE FROM password_reset_tokens WHERE organization_id = ANY($1::uuid[])` },
  { label: 'MFA backup codes', sql: `DELETE FROM mfa_backup_codes WHERE mfa_secret_id IN (SELECT s.id FROM mfa_secrets s JOIN users u ON u.id = s.user_id WHERE u.organization_id = ANY($1::uuid[]))` },
  { label: 'MFA secrets', sql: `DELETE FROM mfa_secrets WHERE user_id IN (SELECT id FROM users WHERE organization_id = ANY($1::uuid[]))` },
  { label: 'trusted devices', sql: `DELETE FROM trusted_devices WHERE user_id IN (SELECT id FROM users WHERE organization_id = ANY($1::uuid[]))` },
  { label: 'password history', sql: `DELETE FROM password_history WHERE user_id IN (SELECT id FROM users WHERE organization_id = ANY($1::uuid[]))` },
  { label: 'refresh tokens (sessions)', sql: `DELETE FROM refresh_tokens WHERE organization_id = ANY($1::uuid[])` },
  { label: 'user role assignments', sql: `DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE organization_id = ANY($1::uuid[]))` },
  { label: 'users', sql: `DELETE FROM users WHERE organization_id = ANY($1::uuid[])` },
  { label: 'role permission grants', sql: `DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE organization_id = ANY($1::uuid[]))` },
  { label: 'roles', sql: `DELETE FROM roles WHERE organization_id = ANY($1::uuid[])` },

  // --- the organisations themselves: campuses reference their root, so children first ---
  { label: 'campuses', sql: `DELETE FROM organizations WHERE id = ANY($1::uuid[]) AND parent_org_id IS NOT NULL` },
  { label: 'organisations', sql: `DELETE FROM organizations WHERE id = ANY($1::uuid[])` },
];

/** Resolve the target organisation ids: one root plus its campuses, or everything. */
async function resolveTargets(slug: string | undefined, all: boolean): Promise<{ ids: string[]; names: string[] }> {
  if (all) {
    const rows = await prisma.organization.findMany({ select: { id: true, name: true, slug: true, orgType: true } });
    return { ids: rows.map((r) => r.id), names: rows.map((r) => `${r.name} (${r.slug}${r.orgType === 'campus' ? ', campus' : ''})`) };
  }
  const root = await prisma.organization.findFirst({ where: { slug: slug!.toLowerCase() }, select: { id: true, name: true, slug: true } });
  if (!root) throw new Error(`No organisation with slug "${slug}". Use --all to target every organisation, or check the spelling.`);
  // Campuses are organizations rows pointing at the root — NOT a separate table.
  const campuses = await prisma.organization.findMany({ where: { parentOrgId: root.id }, select: { id: true, name: true, slug: true } });
  return {
    ids: [...campuses.map((c) => c.id), root.id],
    names: [`${root.name} (${root.slug})`, ...campuses.map((c) => `${c.name} (${c.slug}, campus)`)],
  };
}

/** Post-purge integrity: nothing left behind, nothing global destroyed. */
export async function integrityReport(ids: string[]): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;

  const [{ count: perms }] = await prisma.$queryRawUnsafe<{ count: number }[]>(`SELECT count(*)::int FROM permissions`);
  lines.push(`  permissions (global, must be > 0) ......... ${perms}`);
  if (Number(perms) === 0) { ok = false; lines.push('  !! permissions table is empty — provisioning will refuse to run'); }

  const [{ count: mig }] = await prisma.$queryRawUnsafe<{ count: number }[]>(`SELECT count(*)::int FROM schema_migrations`);
  lines.push(`  schema_migrations (must be > 0) ........... ${mig}`);
  if (Number(mig) === 0) ok = false;

  if (ids.length > 0) {
    const remaining = await countAll(ids);
    const left = remaining.filter((r) => r.n > 0);
    lines.push(`  rows left for the purged organisation(s) .. ${left.length === 0 ? '0 — clean' : left.map((l) => `${l.label}=${l.n}`).join(', ')}`);
    if (left.length > 0) ok = false;
  }

  // Orphans: rows whose owning organisation no longer exists.
  const orphanChecks: [string, string][] = [
    ['employees', `SELECT count(*)::int FROM employees e LEFT JOIN organizations o ON o.id = e.organization_id WHERE o.id IS NULL`],
    ['users', `SELECT count(*)::int FROM users u LEFT JOIN organizations o ON o.id = u.organization_id WHERE o.id IS NULL`],
    ['appraisal_cycles', `SELECT count(*)::int FROM appraisal_cycles c LEFT JOIN organizations o ON o.id = c.organization_id WHERE o.id IS NULL`],
    ['reviewer_assignments', `SELECT count(*)::int FROM reviewer_assignments r LEFT JOIN appraisal_cycles c ON c.id = r.cycle_id WHERE c.id IS NULL`],
    ['feedback_responses', `SELECT count(*)::int FROM feedback_responses f LEFT JOIN reviewer_assignments r ON r.id = f.assignment_id WHERE r.id IS NULL`],
    ['questions', `SELECT count(*)::int FROM questions q LEFT JOIN organizations o ON o.id = q.organization_id WHERE o.id IS NULL`],
  ];
  const orphans: string[] = [];
  for (const [name, sql] of orphanChecks) {
    const [{ count }] = await prisma.$queryRawUnsafe<{ count: number }[]>(sql);
    if (Number(count) > 0) { orphans.push(`${name}=${count}`); ok = false; }
  }
  lines.push(`  orphaned rows ............................. ${orphans.length === 0 ? 'none' : orphans.join(', ')}`);
  return { ok, lines };
}

/* -------------------------------------------------------------------- run */

export async function purgeClient(opts: { slug?: string; all: boolean; dryRun: boolean }): Promise<string[]> {
  const { ids, names } = await resolveTargets(opts.slug, opts.all);
  const target = describeTarget();
  const removed: string[] = [];

  console.log('');
  console.log('  ┌─────────────────────────────────────────────────────────────');
  console.log(`  │  ${opts.dryRun ? 'DRY RUN — nothing will be changed' : 'PURGE — this permanently deletes data'}`);
  console.log('  ├─────────────────────────────────────────────────────────────');
  console.log(`  │  database   ${target.database}  on  ${target.host}`);
  console.log(`  │  target     ${names.join('\n  │             ')}`);
  console.log('  └─────────────────────────────────────────────────────────────');
  console.log('');

  const before = await countAll(ids);
  console.log('  Records in scope:');
  for (const c of before) if (c.n > 0) console.log(`    ${c.label.padEnd(36, '.')} ${c.n}`);
  if (before.every((c) => c.n === 0)) console.log('    (nothing — this organisation is already empty)');

  console.log('');
  console.log('  Retained (never touched):');
  console.log('    the database schema and schema_migrations');
  console.log('    the global permissions catalogue');
  console.log('    any organisation NOT listed above');

  if (opts.dryRun) {
    console.log('');
    console.log('  Dry run complete. Nothing was changed.');
    console.log(`  To apply:  npm run db:purge-client -- --force ${opts.all ? '--all' : `--slug ${opts.slug}`}`);
    return removed;
  }

  console.log('');
  console.log('  Deleting…');
  await prisma.$transaction(async (tx) => {
    // `feedback_audit_events` carries an append-only trigger that raises on DELETE.
    // The immutability is intentional for a running system; for a client handover the
    // previous customer's feedback trail must not remain, so the trigger is lifted
    // for the length of this transaction only and restored before it commits.
    await tx.$executeRawUnsafe(`ALTER TABLE feedback_audit_events DISABLE TRIGGER trg_feedback_audit_events_no_mutate`);
    try {
      for (const step of DELETE_STEPS) {
        const n = await tx.$executeRawUnsafe(step.sql, ids);
        if (n > 0) { console.log(`    ${step.label.padEnd(36, '.')} ${n}`); removed.push(`${step.label}=${n}`); }
      }
    } finally {
      await tx.$executeRawUnsafe(`ALTER TABLE feedback_audit_events ENABLE TRIGGER trg_feedback_audit_events_no_mutate`);
    }
  }, { timeout: 120_000 });

  console.log('');
  console.log('  Integrity check:');
  const report = await integrityReport(ids);
  for (const l of report.lines) console.log(l);
  console.log('');
  console.log(report.ok ? '  ✓ Purge complete and consistent.' : '  ! Purge finished but the checks above found problems.');
  if (!report.ok) process.exitCode = 1;
  return removed;
}

async function main(): Promise<void> {
  const slug = arg('slug');
  const all = has('all');
  const dryRun = has('dry-run');
  const force = has('force');

  if (!slug && !all) {
    throw new Error(
      'Name a target explicitly:\n' +
      '  --slug <slug>   one organisation and its campuses\n' +
      '  --all           every organisation in this database\n' +
      'Add --dry-run to see what would be removed, or --force to apply it.',
    );
  }
  if (!dryRun && !force) {
    throw new Error('Refusing to delete without --force. Run with --dry-run first to see what would go.');
  }

  const target = describeTarget();
  if (!dryRun) assertEnvironmentAllowed(target.database, target.raw);

  await purgeClient({ slug, all, dryRun });
}

if (require.main === module) {
  main()
    .catch((e) => { console.error(`\n  ✗ ${(e as Error).message}\n`); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
