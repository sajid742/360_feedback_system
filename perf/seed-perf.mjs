/**
 * Performance dataset generator — Enterprise 360.
 *
 * Scales a demo-seeded tenant up to production shape:
 *   800 employees (real reporting tree, spread over the seeded campuses/departments/designations)
 *   one login password shared by every synthetic employee, so JMeter can authenticate as any of them
 *
 * SAFETY
 *   - Refuses to run unless PERF_CONFIRM=yes AND the database name contains "perf".
 *     This is the guard that stops it ever touching a real database.
 *   - Only INSERTS. It never updates or deletes anything the demo seed created.
 *   - All names are synthetic ("Perf Employee 0123"); e-mails are on the reserved
 *     .test TLD (RFC 2606) so they can never route to a real mailbox.
 *
 * Roles are assigned so the load model has the right permission mix:
 *   ~2%  HR/Admin        (dashboards, cycle management, reports)
 *   ~12% Manager         (team reports, reporting-scope reads)
 *   ~86% Employee        (their own reviews)
 *
 * Usage:  PERF_CONFIRM=yes node perf/seed-perf.mjs [targetEmployees]
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';

const TARGET = Number(process.argv[2] ?? 800);
const ORG_SLUG = process.env.PERF_ORG_SLUG ?? 'care';
const PASSWORD = process.env.PERF_PASSWORD ?? 'PerfTest!2026';
const EMAIL_DOMAIN = 'perf.carepvtltd.test'; // .test is reserved — never resolves

const prisma = new PrismaClient();

function guard() {
  const url = process.env.DATABASE_URL ?? '';
  const db = (url.split('/').pop() ?? '').split('?')[0];
  if (process.env.PERF_CONFIRM !== 'yes') {
    throw new Error('Refusing to run: set PERF_CONFIRM=yes to confirm this is a throwaway database.');
  }
  if (!/perf/i.test(db)) {
    throw new Error(`Refusing to run against database "${db}" — the name must contain "perf". This guard exists so the generator can never be pointed at production.`);
  }
  return db;
}

async function main() {
  const db = guard();
  const t0 = Date.now();
  console.log(`target ${TARGET} employees | database ${db}`);

  const org = await prisma.organization.findFirst({ where: { slug: ORG_SLUG, orgType: { not: 'campus' } } })
    ?? await prisma.organization.findFirst({ where: { slug: ORG_SLUG } });
  if (!org) throw new Error(`Organization "${ORG_SLUG}" not found — run db:bootstrap-tenant first.`);

  const [departments, designations, campuses, roles, existing] = await Promise.all([
    prisma.department.findMany({ where: { organizationId: org.id, deletedAt: null }, select: { id: true } }),
    prisma.designation.findMany({ where: { organizationId: org.id, deletedAt: null }, select: { id: true, level: true } }),
    prisma.organization.findMany({ where: { parentOrgId: org.id, orgType: 'campus' }, select: { id: true } }),
    prisma.role.findMany({ where: { organizationId: org.id }, select: { id: true, name: true } }),
    prisma.employee.count({ where: { organizationId: org.id, deletedAt: null } }),
  ]);

  console.log(`existing: ${existing} employees | ${departments.length} departments | ${designations.length} designations | ${campuses.length} campuses`);
  const toCreate = Math.max(0, TARGET - existing);
  if (toCreate === 0) { console.log('already at target — nothing to do'); return; }

  const roleId = (name) => roles.find((r) => r.name === name)?.id ?? null;
  const R_HR = roleId('HR/Admin') ?? roleId('HR Admin');
  const R_MGR = roleId('Manager');
  const R_EMP = roleId('Employee');
  if (!R_EMP) throw new Error('System roles missing — run db:seed and db:bootstrap-tenant first.');

  // One bcrypt round-trip, reused. Hashing 800 passwords individually costs ~90s at
  // cost 10 and tells us nothing: every synthetic user shares the same password.
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  // Seniority: designation levels drive who can manage whom.
  const byLevel = [...designations].sort((a, b) => (a.level ?? 99) - (b.level ?? 99));
  const pick = (arr, i) => (arr.length ? arr[i % arr.length] : null);

  const users = [];
  const employees = [];
  const userRoles = [];
  const empIds = [];

  for (let i = 0; i < toCreate; i++) {
    const n = String(existing + i + 1).padStart(4, '0');
    const userId = randomUUID();
    const empId = randomUUID();
    empIds.push(empId);

    users.push({
      id: userId,
      organizationId: org.id,
      email: `perf.emp${n}@${EMAIL_DOMAIN}`,
      passwordHash,
      fullName: `Perf Employee ${n}`,
      status: 'active',
      mustChangePassword: false,
    });

    // Deterministic role mix — see header.
    const bucket = i % 50;
    const role = bucket === 0 && R_HR ? R_HR : bucket < 7 && R_MGR ? R_MGR : R_EMP;
    userRoles.push({ userId, roleId: role });

    employees.push({
      id: empId,
      organizationId: org.id,
      userId,
      employeeCode: `PERF${n}`,
      departmentId: pick(departments, i)?.id ?? null,
      designationId: pick(byLevel, i)?.id ?? null,
      campusId: pick(campuses, i)?.id ?? null,
      lineManagerId: null, // wired below, once every row exists
      joinDate: new Date(2020 + (i % 6), i % 12, 1 + (i % 28)),
      status: 'active',
    });
  }

  console.log(`inserting ${users.length} users…`);
  for (let i = 0; i < users.length; i += 500) await prisma.user.createMany({ data: users.slice(i, i + 500) });
  console.log(`inserting ${employees.length} employees…`);
  for (let i = 0; i < employees.length; i += 500) await prisma.employee.createMany({ data: employees.slice(i, i + 500) });
  console.log(`assigning roles…`);
  for (let i = 0; i < userRoles.length; i += 500) await prisma.userRole.createMany({ data: userRoles.slice(i, i + 500), skipDuplicates: true });

  /*
   * Reporting tree: a branching factor of 8, so ~100 managers each with ~8 reports.
   * This shape matters — ScopeService walks the subtree with a recursive CTE for every
   * Manager-scoped request, and a flat or a pathological tree would make that either
   * trivially cheap or absurdly expensive. Eight is a realistic span of control.
   */
  console.log('wiring the reporting tree…');
  const updates = [];
  for (let i = 1; i < empIds.length; i++) {
    const parent = empIds[Math.floor((i - 1) / 8)];
    updates.push(prisma.$executeRaw`UPDATE employees SET line_manager_id = ${parent}::uuid WHERE id = ${empIds[i]}::uuid`);
    if (updates.length >= 200) { await Promise.all(updates.splice(0)); }
  }
  if (updates.length) await Promise.all(updates);

  const total = await prisma.employee.count({ where: { organizationId: org.id, deletedAt: null } });
  console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${total} employees in "${ORG_SLUG}"`);
  console.log(`login: any of perf.emp0001..${String(total).padStart(4, '0')}@${EMAIL_DOMAIN} / ${PASSWORD} (org slug "${ORG_SLUG}")`);
}

main()
  .catch((e) => { console.error(e.message ?? e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
