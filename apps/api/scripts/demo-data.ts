/**
 * Demo dataset — one rich, interconnected organisation.
 *
 * Runs AFTER `db:sample`, which already builds the CARE Pvt. Ltd. organisation: 23 departments,
 * 39 designations, 50 employees with a single-rooted reporting tree, 3 competencies
 * with proficiency levels, and a published questionnaire. This script does not
 * duplicate any of that; it enriches the SAME organisation so every major feature
 * has meaningful data behind it:
 *
 *   campuses (+ department and employee assignment) · four feedback cycles across
 *   completed / active / upcoming · self, manager, peer, subordinate and parent
 *   quadrants · multiple evaluators per quadrant · mixed completion statuses ·
 *   varied scores producing high / medium / low performers, blind spots and
 *   competency gaps · qualitative comments · HR calibration and results release ·
 *   a full SIS roster (students, parents, classes, subjects, teachers) with teachers
 *   mapped to employees · parent evaluation links · HR sync history · communication
 *   and in-app notification records · audit trail · rubrics · development actions.
 *
 * Deliberate choices:
 *  - Scores are NEVER hand-written. Responses are inserted and then the real
 *    `ScoringService.compute()` is run, so the weighted-average rule, the
 *    calibration override rule and the participant status all come from product
 *    code rather than from this script's idea of them.
 *  - Feedback is generated from a per-employee performance profile plus per-quadrant
 *    and per-competency offsets, so the dashboards, heatmaps and blind-spot analysis
 *    have real variance instead of noise.
 *  - Anonymity is respected by construction: some quadrants deliberately have fewer
 *    reviewers than the org threshold so suppression is demonstrable, and nothing
 *    here writes reviewer identity anywhere it would not normally appear.
 *
 * Idempotent: re-running is a no-op once the marker cycle exists.
 */
import 'dotenv/config';
import { PrismaClient, Prisma } from '@prisma/client';
import { ScoringService } from '../src/appraisal/services/scoring.service';
import type { SisSnapshot } from '../src/sis-integration/sis-snapshot.types';

const SLUG = process.env.SAMPLE_ORG_SLUG ?? 'care';
const MARKER_CYCLE = 'Annual Review 2026';
/** Demo-only artefact used as the idempotency marker — `sample-data` never creates it. */
const MARKER_UPCOMING = 'Mid-Year Review 2027';

const prisma = new PrismaClient();

/* ------------------------------------------------------------------ *
 * Deterministic pseudo-randomness: a demo dataset must look varied but
 * reproduce identically on every machine, or screenshots and support
 * conversations stop matching what the customer sees.
 * ------------------------------------------------------------------ */
let seed = 20260815;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
const clamp5 = (n: number): number => Math.max(1, Math.min(5, Math.round(n)));

/* ------------------------------------------------------------------ *
 * Campuses
 * ------------------------------------------------------------------ */
const CAMPUSES = [
  { name: 'CARE Taxila Campus', slug: 'taxila', units: ['CARE University', 'Schools & Colleges', 'Administration & HR', 'Academics & Staff Development', 'Admissions', 'HR', 'IT', 'Accounts', 'Administration', 'Procurement', 'Transport', 'Maintenance & Horticulture'] },
  { name: 'CARE Rawalpindi Campus', slug: 'rawalpindi', units: ['CARE Institute of Health Sciences', 'CARE Dental College', 'Pre-School', 'Junior School', 'Day Care Centre'] },
  { name: 'CARE Wah Cantt Campus', slug: 'wah-cantt', units: ['CARE School for Girls', 'Margalla Branch', 'CARE School for Boys', 'Examinations Cell', 'Security'] },
];

/* ------------------------------------------------------------------ *
 * Performance profiles — drive every generated rating so the dashboards
 * show a believable spread rather than everyone at 4.
 * ------------------------------------------------------------------ */
type Profile = { base: number; label: 'high' | 'solid' | 'mixed' | 'developing' };
const PROFILES: Profile[] = [
  { base: 4.6, label: 'high' },
  { base: 4.1, label: 'solid' },
  { base: 3.4, label: 'mixed' },
  { base: 2.7, label: 'developing' },
];

/** Per-quadrant lean: how a rater group tends to differ from the base. */
const QUADRANT_LEAN: Record<string, number> = { self: 0.5, manager: -0.1, peer: 0, subordinate: -0.2, parent: 0.2 };

const COMMENTS_STRENGTH = [
  'Keeps the team informed and sets clear priorities each week.',
  'Handles difficult conversations calmly and fairly.',
  'Reliable under pressure — deadlines are met without drama.',
  'Mentors junior colleagues generously and patiently.',
  'Brings structure to messy problems and follows through.',
];
const COMMENTS_DEVELOPMENT = [
  'Could delegate more instead of absorbing the work personally.',
  'Written updates sometimes arrive late, which slows the rest of us down.',
  'Would benefit from involving the team earlier in planning decisions.',
  'Occasionally moves on before checking the detail is right.',
  'More visible presence across the other campus would help.',
];
const COMMENTS_PARENT = [
  'My child looks forward to this class and talks about it at home.',
  'Communication about homework and progress has been consistent.',
  'Very approachable at parent meetings and quick to respond.',
  'Would appreciate a little more feedback on assessments.',
];

/** Every cycle this script creates. The reset below deletes exactly these and nothing else. */
const DEMO_CYCLES = [
  'Annual Review 2024', 'Annual Review 2025', MARKER_CYCLE, MARKER_UPCOMING, 'Engagement Pulse 2026',
];

/**
 * Remove the demo content this script previously created for one organization, so it
 * can be regenerated from the CURRENT code.
 *
 * WHY THIS EXISTS. `db:demo` is idempotent by design: it stops the moment its marker
 * cycle exists, so restarting a stack never duplicates or overwrites data. The
 * side-effect is that a database seeded by an OLDER version of this script keeps that
 * older data for ever — rebuilding the image changes nothing, because the guard fires
 * before any seeding runs. That is exactly how a Docker volume ends up still showing
 * guardian names ("Khan Sahib") that the script stopped generating.
 *
 * SAFETY. This is deliberately narrow. It deletes only artefacts keyed to the demo
 * cycles listed above plus the demo SIS roster, all scoped to ONE organization, and it
 * only runs when explicitly asked for (`--force` / `DEMO_RESEED=true`). It never
 * touches employees, users, roles, competencies, questionnaires or any cycle a person
 * created. A normal start never calls it.
 */
async function resetDemo(orgId: string): Promise<void> {
  console.log(`▸ Resetting demo content for "${SLUG}" (deliberate --force)`);
  const cycles = await prisma.appraisalCycle.findMany({
    where: { organizationId: orgId, name: { in: DEMO_CYCLES } },
    select: { id: true, name: true },
  });
  const cycleIds = cycles.map((c) => c.id);

  if (cycleIds.length > 0) {
    // FK order: link targets -> links -> responses -> assignments -> participants -> sources.
    await prisma.$executeRawUnsafe(
      `DELETE FROM evaluation_link_targets WHERE link_id IN (SELECT id FROM evaluation_links WHERE cycle_id = ANY($1::uuid[]))`, cycleIds);
    await prisma.$executeRawUnsafe(`DELETE FROM evaluation_links WHERE cycle_id = ANY($1::uuid[])`, cycleIds);
    await prisma.$executeRawUnsafe(
      `DELETE FROM feedback_responses WHERE assignment_id IN (SELECT id FROM reviewer_assignments WHERE cycle_id = ANY($1::uuid[]))`, cycleIds);
    await prisma.$executeRawUnsafe(`DELETE FROM reviewer_assignments WHERE cycle_id = ANY($1::uuid[])`, cycleIds);
    await prisma.$executeRawUnsafe(`DELETE FROM appraisal_participants WHERE cycle_id = ANY($1::uuid[])`, cycleIds);
    await prisma.$executeRawUnsafe(`DELETE FROM feedback_sources WHERE cycle_id = ANY($1::uuid[])`, cycleIds);
    await prisma.$executeRawUnsafe(`DELETE FROM report_schedules WHERE cycle_id = ANY($1::uuid[])`, cycleIds);
    await prisma.$executeRawUnsafe(`DELETE FROM bulk_generation_runs WHERE cycle_id = ANY($1::uuid[])`, cycleIds);
    await prisma.$executeRawUnsafe(`DELETE FROM appraisal_cycles WHERE id = ANY($1::uuid[])`, cycleIds);
    console.log(`  removed ${cycles.length} demo cycle(s): ${cycles.map((c) => c.name).join(', ')}`);
  }

  // The SIS roster and its teacher->employee identity maps: this is the data that
  // carries the guardian names, so a reset that skipped it would fix nothing.
  const sis = await prisma.sisDataset.deleteMany({ where: { organizationId: orgId } });
  const maps = await prisma.externalIdentityMap.deleteMany({ where: { organizationId: orgId, externalType: 'teacher' } });
  await prisma.sisSyncRun.deleteMany({ where: { organizationId: orgId } });
  await prisma.hrSyncRun.deleteMany({ where: { organizationId: orgId } });
  console.log(`  removed ${sis.count} SIS roster snapshot(s) and ${maps.count} teacher identity map(s)`);

  // Demo notifications/campaigns, so the outbox does not keep messages about cycles
  // that no longer exist.
  await prisma.notification.deleteMany({ where: { organizationId: orgId } });
  await prisma.communicationCampaign.deleteMany({ where: { organizationId: orgId } });

  // In-app notifications and the demo short link. Both are re-created below, and
  // neither is keyed to a cycle, so without this a reseed either stacks duplicate
  // bell entries or (for the short link, whose `code` is unique) fails outright.
  await prisma.userNotification.deleteMany({ where: { organizationId: orgId } });
  await prisma.shortLink.deleteMany({ where: { organizationId: orgId } });
}

async function main(): Promise<void> {
  const org = await prisma.organization.findFirst({ where: { slug: SLUG, orgType: 'root', deletedAt: null } });
  if (!org) throw new Error(`Organization "${SLUG}" not found — run db:bootstrap-tenant and db:sample first.`);
  const orgId = org.id;

  // `--force` (or DEMO_RESEED=true) regenerates demo content from the current code.
  const force = process.argv.includes('--force') || process.env.DEMO_RESEED === 'true';

  const existing = await prisma.appraisalCycle.findFirst({ where: { organizationId: orgId, name: MARKER_UPCOMING, deletedAt: null } });
  if (existing && !force) {
    console.log(`Demo data already present for "${SLUG}" (cycle "${MARKER_UPCOMING}" exists). Nothing to do.`);
    console.log('To regenerate it from the current code:  npm run db:demo -- --force');
    return;
  }
  if (existing && force) await resetDemo(orgId);

  const admin = await prisma.user.findFirst({ where: { organizationId: orgId, email: process.env.BOOTSTRAP_EMAIL ?? 'sajidq@carepvtltd.com' } })
    ?? await prisma.user.findFirstOrThrow({ where: { organizationId: orgId, deletedAt: null } });
  const actor = admin.id;

  console.log('▸ RBAC roles for the workforce');
  await seedRoles(orgId);

  console.log('▸ Campuses');
  const campusIdByUnit = await seedCampuses(orgId);

  console.log('▸ Extra competencies & questions');
  await seedExtraCompetencies(orgId, actor);

  console.log('▸ Rubrics & development actions');
  await seedRubricsAndDevelopment(orgId, actor);

  console.log('▸ Feedback cycles');
  const cycles = await seedCycles(orgId, actor);

  console.log('▸ Participants, evaluators and feedback');
  await seedFeedback(orgId, actor, cycles);

  console.log('▸ Engagement pulse (eNPS)');
  await seedEngagementPulse(orgId, actor);

  console.log('▸ Student information system roster');
  const snapshot = await seedSis(orgId, actor, campusIdByUnit);

  console.log('▸ Parent evaluations');
  await seedParentEvaluations(orgId, actor, cycles.active.id, snapshot);

  console.log('▸ HR integration history');
  await seedHrHistory(orgId, admin);

  console.log('▸ Communication, notifications and audit trail');
  await seedCommsAndAudit(orgId, admin, cycles);

  console.log('▸ Per-quadrant questionnaire (upcoming cycle)');
  await seedQuadrantQuestionnaire(orgId, actor, cycles);

  console.log('▸ Consolidated parent feedback (upcoming cycle)');
  await seedConsolidatedParentMode(orgId, actor, cycles, snapshot);

  console.log('▸ Organisation branding for outgoing messages');
  await seedBranding(orgId, admin.id);

  console.log('\nDemo data complete.');
}

/* ----------------------------------------------- per-quadrant questionnaire */

/**
 * A quadrant may carry its own questionnaire instead of the cycle's, so different
 * evaluator groups can be asked different questions while still sharing competencies.
 *
 * This is attached to the UPCOMING (draft) cycle on purpose. The scored cycles keep the
 * single shared questionnaire they were answered against — changing those would rewrite
 * what the demo dashboards show, and swapping a quadrant's questionnaire underneath
 * answers that have already been collected is precisely the mistake the manuals warn
 * against — while the draft cycle demonstrates the configuration: a peer questionnaire
 * that asks about the shared "Effective Communication" competency in peer-specific words,
 * plus one competency only peers are asked about.
 *
 * The draft cycle gets its quadrants here rather than in `seedFeedback`, which only
 * builds quadrants for the three cycles it actually collects answers for. Without them
 * there is no peer quadrant to attach anything to — which is exactly how this seed used
 * to fail silently.
 */
async function seedQuadrantQuestionnaire(orgId: string, actor: string, cycles: CycleSet): Promise<void> {
  const shared = await prisma.competency.findFirst({ where: { organizationId: orgId, name: 'Effective Communication', deletedAt: null } });
  if (!shared) throw new Error('Demo seed: competency "Effective Communication" is missing — run db:sample first.');

  const category = await prisma.competencyCategory.findFirstOrThrow({ where: { organizationId: orgId, deletedAt: null } });
  let peerOnly = await prisma.competency.findFirst({ where: { organizationId: orgId, name: 'Knowledge Sharing', deletedAt: null } });
  if (!peerOnly) {
    peerOnly = await prisma.competency.create({
      data: {
        organizationId: orgId,
        categoryId: category.id,
        name: 'Knowledge Sharing',
        description: 'Shares expertise and context with colleagues instead of holding it.',
        createdBy: actor,
        updatedBy: actor,
      },
    });
    // A competency MUST have a live version with proficiency levels: the library card
    // renders the active-or-latest version, and the product's own create endpoint always
    // makes a v1. Inserting the row alone leaves a competency the UI cannot display.
    const version = await prisma.competencyVersion.create({
      data: { organizationId: orgId, competencyId: peerOnly.id, versionLabel: 'v1', status: 'active', createdBy: actor, updatedBy: actor },
    });
    const levels = ['Basic', 'Developing', 'Proficient', 'Advanced', 'Expert'];
    await prisma.proficiencyLevel.createMany({
      data: levels.map((name, li) => ({
        organizationId: orgId,
        versionId: version.id,
        level: li + 1,
        name,
        description: `${name} command of knowledge sharing.`,
      })),
    });
  }

  const template = await prisma.questionnaireTemplate.create({
    data: {
      organizationId: orgId,
      name: 'Peer Perspective 2027',
      description: 'Short questionnaire used only by the Peer quadrant.',
      status: 'published',
      createdBy: actor,
      updatedBy: actor,
    },
  });
  const section = await prisma.templateSection.create({
    data: { templateId: template.id, title: 'Working together', sortOrder: 0 },
  });

  const questions = [
    { text: 'Communicates clearly and openly with colleagues at the same level.', competencyId: shared.id },
    { text: 'Shares knowledge and expertise rather than keeping it to themselves.', competencyId: peerOnly.id },
  ];
  let sortOrder = 0;
  for (const q of questions) {
    const row = await prisma.question.create({
      data: {
        organizationId: orgId,
        competencyId: q.competencyId,
        text: q.text,
        type: 'rating',
        isMandatory: true,
        createdBy: actor,
        updatedBy: actor,
      },
    });
    await prisma.sectionQuestion.create({ data: { sectionId: section.id, questionId: row.id, sortOrder: sortOrder++ } });
  }

  // The draft cycle is being *prepared*, so it needs the same quadrant set an
  // administrator would configure before activating it.
  for (const s of SOURCES) {
    await prisma.feedbackSource.create({
      data: { cycleId: cycles.upcoming.id, code: s.code, label: s.label, weight: s.weight, requiredCount: s.required, isAnonymous: s.anonymous },
    });
  }

  const peerSource = await prisma.feedbackSource.findFirst({ where: { cycleId: cycles.upcoming.id, code: 'peer' } });
  // Throw rather than skip. The previous version guarded with `if (peerSource)` and
  // logged success either way, so the whole feature silently went unseeded while the
  // console said otherwise.
  if (!peerSource) throw new Error('Demo seed: the upcoming cycle has no peer quadrant to attach a questionnaire to.');
  await prisma.feedbackSource.update({ where: { id: peerSource.id }, data: { templateId: template.id } });

  console.log(`   "${MARKER_UPCOMING}": ${SOURCES.length} quadrants; Peer answers "${template.name}" (1 shared + 1 peer-only competency), the rest inherit the cycle questionnaire`);
}

/* ---------------------------------------------------------------- branding */

/**
 * Branding used by every outgoing e-mail/SMS/WhatsApp template and by the public
 * parent-evaluation page. Without it the sender falls back to the bare organisation
 * name and no reply-to address, which reads like an unconfigured install.
 * Stored in the same `configurations` row the Communication screen writes
 * (module 'communication', key 'branding') — no schema change.
 */
async function seedBranding(orgId: string, actor: string): Promise<void> {
  // The provisioning CLI names every new tenant admin "Administrator" (product
  // default, correct for a real install). For the demo the account belongs to a
  // named person, so the header and audit trail read like a real organisation.
  await prisma.user.updateMany({
    where: { organizationId: orgId, id: actor, fullName: 'Administrator' },
    data: { fullName: 'Sajid Qureshi' },
  });
  const value = {
    organizationName: 'CARE Pvt. Ltd.',
    logoUrl: '',
    primaryColor: '#6d5dfc',
    supportEmail: 'hr@carepvtltd.com',
    footer: 'CARE Pvt. Ltd. · People & Performance · hr@carepvtltd.com',
  };
  const existing = await prisma.configuration.findFirst({
    where: { organizationId: orgId, module: 'communication', key: 'branding', deletedAt: null },
    select: { id: true },
  });
  if (existing) {
    await prisma.configuration.update({ where: { id: existing.id }, data: { value, updatedBy: actor } });
  } else {
    await prisma.configuration.create({
      data: { organizationId: orgId, module: 'communication', key: 'branding', value, createdBy: actor, updatedBy: actor },
    });
  }
}

/* -------------------------------------------------------------------- RBAC */

/**
 * `sample-data` creates 50 users but assigns no roles, so every sample employee is
 * locked out of the product — they cannot even open their own review. (Employees
 * created through the UI get the default role automatically; these are inserted
 * directly.) Roles are assigned here from the org chart itself:
 *
 *   HR/Admin  — the HR Manager and the two Directors who run the programme
 *   Manager   — anyone with direct reports (reporting-scope data access)
 *   Viewer    — one read-only account for demonstrating restricted access
 *   Employee  — everyone else
 */
// E1002 Director Academics and E1006 HR Manager run the feedback programme.
// Deliberately NOT the Director Administration (E1003): the demo needs at least one
// senior manager who does NOT hold executive reporting rights, so restricted-access
// behaviour can be shown.
const HR_ADMIN_CODES = ['E1002', 'E1006'];
// E1012 is the read-only account used to demonstrate the Viewer role.
const VIEWER_CODES = ['E1012'];

async function seedRoles(orgId: string): Promise<void> {
  const roles = await prisma.role.findMany({ where: { organizationId: orgId, deletedAt: null }, select: { id: true, name: true } });
  const roleId = new Map(roles.map((r) => [r.name, r.id]));
  const employees = await prisma.employee.findMany({
    where: { organizationId: orgId, deletedAt: null },
    select: { id: true, userId: true, employeeCode: true, lineManagerId: true },
  });
  const managerIds = new Set(employees.map((e) => e.lineManagerId).filter((x): x is string => Boolean(x)));

  const rows: { userId: string; roleId: string }[] = [];
  for (const e of employees) {
    if (!e.userId) continue;
    const name = HR_ADMIN_CODES.includes(e.employeeCode)
      ? 'HR/Admin'
      : VIEWER_CODES.includes(e.employeeCode)
        ? 'Viewer'
        : managerIds.has(e.id)
          ? 'Manager'
          : 'Employee';
    const id = roleId.get(name);
    if (id) rows.push({ userId: e.userId, roleId: id });
  }
  await prisma.userRole.createMany({ data: rows, skipDuplicates: true });
  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    const n = roles.find((x) => x.id === r.roleId)!.name;
    acc[n] = (acc[n] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`   ${Object.entries(counts).map(([n, c]) => `${n}=${c}`).join(' · ')}`);
}

/* ---------------------------------------------------------------- campuses */

async function seedCampuses(orgId: string): Promise<Map<string, string>> {
  const byUnit = new Map<string, string>();
  for (const c of CAMPUSES) {
    const row =
      (await prisma.organization.findFirst({ where: { parentOrgId: orgId, name: c.name } })) ??
      (await prisma.organization.create({
        data: { name: c.name, slug: `${SLUG}-${c.slug}`, orgType: 'campus', parentOrgId: orgId, status: 'active' },
      }));
    for (const unit of c.units) byUnit.set(unit, row.id);
    // Departments carry the campus so departmental and campus reporting agree.
    await prisma.department.updateMany({
      where: { organizationId: orgId, name: { in: c.units } },
      data: { campusId: row.id },
    });
  }
  // Every employee inherits their department's campus; without this the campus
  // dashboard has nothing to group by.
  const depts = await prisma.department.findMany({ where: { organizationId: orgId, campusId: { not: null } }, select: { id: true, campusId: true } });
  for (const d of depts) {
    await prisma.employee.updateMany({ where: { organizationId: orgId, departmentId: d.id }, data: { campusId: d.campusId } });
  }
  // Anyone left (root-level units) sits with the main campus rather than "Unassigned".
  const main = await prisma.organization.findFirstOrThrow({ where: { parentOrgId: orgId, slug: `${SLUG}-${CAMPUSES[0].slug}` } });
  await prisma.employee.updateMany({ where: { organizationId: orgId, campusId: null }, data: { campusId: main.id } });
  return byUnit;
}

/* --------------------------------------------------------- competencies */

/**
 * `sample-data` ships three competencies. A demo needs enough breadth for the
 * competency × quadrant heatmap and the gap analysis to be worth looking at, so
 * three more are appended to the SAME published questionnaire rather than creating
 * a competing template.
 */
const EXTRA_COMPETENCIES: { category: string; name: string; description: string; question: string }[] = [
  { category: 'Leadership', name: 'Decision Making', description: 'Makes timely, well-reasoned decisions and owns the outcome.', question: 'Makes timely decisions and takes responsibility for the result.' },
  { category: 'Communication', name: 'Collaboration & Teamwork', description: 'Works across departments and campuses to get things done.', question: 'Works effectively with colleagues across departments and campuses.' },
  { category: 'Teaching', name: 'Student & Parent Engagement', description: 'Builds constructive relationships with students and their families.', question: 'Builds constructive relationships with students and parents.' },
];

async function seedExtraCompetencies(orgId: string, actor: string): Promise<void> {
  const scale = await prisma.ratingScale.findFirstOrThrow({ where: { organizationId: orgId, deletedAt: null } });
  const template = await prisma.questionnaireTemplate.findFirstOrThrow({ where: { organizationId: orgId, status: 'published', deletedAt: null }, orderBy: { createdAt: 'asc' } });
  const section = await prisma.templateSection.findFirstOrThrow({ where: { templateId: template.id }, orderBy: { sortOrder: 'asc' } });
  const existingLinks = await prisma.sectionQuestion.count({ where: { sectionId: section.id } });

  for (const [i, c] of EXTRA_COMPETENCIES.entries()) {
    if (await prisma.competency.findFirst({ where: { organizationId: orgId, name: c.name, deletedAt: null } })) continue;
    const category =
      (await prisma.competencyCategory.findFirst({ where: { organizationId: orgId, name: c.category, deletedAt: null } })) ??
      (await prisma.competencyCategory.create({ data: { organizationId: orgId, name: c.category, createdBy: actor, updatedBy: actor } }));
    const competency = await prisma.competency.create({
      data: { organizationId: orgId, categoryId: category.id, name: c.name, description: c.description, createdBy: actor, updatedBy: actor },
    });
    const version = await prisma.competencyVersion.create({
      data: { organizationId: orgId, competencyId: competency.id, versionLabel: 'v1', status: 'active', createdBy: actor, updatedBy: actor },
    });
    const levels = ['Basic', 'Developing', 'Proficient', 'Advanced', 'Expert'];
    await prisma.proficiencyLevel.createMany({
      data: levels.map((name, li) => ({ organizationId: orgId, versionId: version.id, level: li + 1, name, description: `${name} command of ${c.name.toLowerCase()}.` })),
    });
    const question = await prisma.question.create({
      data: { organizationId: orgId, text: c.question, type: 'rating', ratingScaleId: scale.id, competencyId: competency.id, category: c.category, isMandatory: true, createdBy: actor, updatedBy: actor },
    });
    await prisma.sectionQuestion.create({ data: { sectionId: section.id, questionId: question.id, sortOrder: existingLinks + i } });
  }
}

/* ------------------------------------------------------ rubrics & development */

async function seedRubricsAndDevelopment(orgId: string, actor: string): Promise<void> {
  const competencies = await prisma.competency.findMany({ where: { organizationId: orgId, deletedAt: null } });
  const scale = await prisma.ratingScale.findFirst({ where: { organizationId: orgId, deletedAt: null } });
  for (const c of competencies) {
    const exists = await prisma.rubric.findFirst({ where: { organizationId: orgId, competencyId: c.id, deletedAt: null } });
    if (exists) continue;
    await prisma.rubric.create({
      data: {
        organizationId: orgId,
        competencyId: c.id,
        ratingScaleId: scale?.id ?? null,
        title: `${c.name} — rating guide`,
        descriptors: {
          '1': `Rarely demonstrates ${c.name.toLowerCase()}; needs close direction.`,
          '2': `Demonstrates ${c.name.toLowerCase()} inconsistently; needs support.`,
          '3': `Meets expectations for ${c.name.toLowerCase()} in day-to-day work.`,
          '4': `Consistently strong; others rely on them for ${c.name.toLowerCase()}.`,
          '5': `Sets the standard for ${c.name.toLowerCase()} across the organisation.`,
        } as Prisma.InputJsonValue,
        createdBy: actor,
        updatedBy: actor,
      },
    });
  }

  // A few development actions so the Development module is not empty.
  const employees = await prisma.employee.findMany({ where: { organizationId: orgId, deletedAt: null }, take: 8, orderBy: { employeeCode: 'asc' } });
  const titles = [
    ['Effective Communication', 'Lead the weekly campus briefing for one term', 'high'],
    ['Strategic Leadership', 'Shadow the Director Academics on annual planning', 'medium'],
    ['Teaching & Delivery Excellence', 'Complete the classroom observation programme', 'medium'],
    ['Effective Communication', 'Write and circulate a monthly department update', 'low'],
  ];
  for (let i = 0; i < employees.length; i += 1) {
    const [competency, title, priority] = titles[i % titles.length];
    await prisma.developmentAction.create({
      data: {
        organizationId: orgId,
        employeeId: employees[i].id,
        competency,
        title,
        description: 'Agreed during the 360 feedback review.',
        status: i % 3 === 0 ? 'in_progress' : i % 3 === 1 ? 'open' : 'completed',
        priority,
        dueDate: new Date(2026, 5 + (i % 5), 15),
        createdBy: actor,
      },
    });
  }
}

/* ------------------------------------------------------------------ cycles */

interface CycleSet {
  closed2024: { id: string };
  closed2025: { id: string };
  active: { id: string };
  upcoming: { id: string };
}

async function seedCycles(orgId: string, actor: string): Promise<CycleSet> {
  const template = await prisma.questionnaireTemplate.findFirstOrThrow({ where: { organizationId: orgId, status: 'published', deletedAt: null } });
  const scale = await prisma.ratingScale.findFirst({ where: { organizationId: orgId, deletedAt: null } });

  const make = async (name: string, start: string, end: string, status: string) =>
    prisma.appraisalCycle.create({
      data: {
        organizationId: orgId,
        name,
        startDate: new Date(start),
        endDate: new Date(end),
        submissionDeadline: new Date(end),
        status,
        templateId: template.id,
        ratingScaleId: scale?.id ?? null,
        createdBy: actor,
        updatedBy: actor,
      },
    });

  // The cycle `sample-data` ships becomes a small closed pilot, so the demo has one
  // unambiguous active cycle and the pilot still illustrates a completed programme.
  await prisma.appraisalCycle.updateMany({
    where: { organizationId: orgId, name: 'Annual Review 2026' },
    data: { name: 'Leadership Pilot 2025', status: 'closed', startDate: new Date('2025-03-01'), endDate: new Date('2025-06-30') },
  });

  const closed2024 = await make('Annual Review 2024', '2024-01-01', '2024-12-31', 'closed');
  const closed2025 = await make('Annual Review 2025', '2025-01-01', '2025-12-31', 'closed');
  const active = await make(MARKER_CYCLE, '2026-01-01', '2026-12-31', 'active');
  const upcoming = await make('Mid-Year Review 2027', '2027-01-01', '2027-06-30', 'draft');
  return { closed2024, closed2025, active, upcoming };
}


/**
 * Questions belonging to a cycle's questionnaire.
 *
 * Selecting every question in the organisation instead would answer questions that
 * are not on the cycle's form — which the product rejects at submission time
 * (`assertValidResponses`) and which would mix rating scales inside one score.
 */
async function cycleQuestions(cycleId: string): Promise<{ id: string; type: string; competencyId: string | null }[]> {
  const cycle = await prisma.appraisalCycle.findUniqueOrThrow({ where: { id: cycleId }, select: { templateId: true } });
  if (!cycle.templateId) return [];
  const links = await prisma.sectionQuestion.findMany({
    where: { section: { templateId: cycle.templateId } },
    select: { sortOrder: true, question: { select: { id: true, type: true, competencyId: true } } },
    orderBy: { sortOrder: 'asc' },
  });
  return links.map((l) => l.question);
}

/* ---------------------------------------------------------------- feedback */

/** Quadrants per cycle. Weights are relative, matching the bulk-generation convention. */
const SOURCES: { code: string; label: string; weight: number; anonymous: boolean; required: number }[] = [
  { code: 'self', label: 'Self', weight: 1, anonymous: false, required: 1 },
  { code: 'manager', label: 'Line Manager', weight: 2, anonymous: false, required: 1 },
  { code: 'peer', label: 'Peer', weight: 1, anonymous: true, required: 3 },
  { code: 'subordinate', label: 'Subordinate', weight: 1, anonymous: true, required: 3 },
];

async function seedFeedback(orgId: string, actor: string, cycles: CycleSet): Promise<void> {
  const employees = await prisma.employee.findMany({
    where: { organizationId: orgId, deletedAt: null },
    select: { id: true, employeeCode: true, lineManagerId: true, departmentId: true, campusId: true, user: { select: { fullName: true } } },
    orderBy: { employeeCode: 'asc' },
  });
  const reportsOf = new Map<string, string[]>();
  for (const e of employees) {
    if (!e.lineManagerId) continue;
    reportsOf.set(e.lineManagerId, [...(reportsOf.get(e.lineManagerId) ?? []), e.id]);
  }
  const peersOf = (e: (typeof employees)[number]): string[] =>
    (e.lineManagerId ? reportsOf.get(e.lineManagerId) ?? [] : []).filter((id) => id !== e.id);


  // A stable profile + per-competency lean per employee, so an employee reads the
  // same way in every cycle and the trend line is a story rather than noise.
  const profileOf = new Map<string, Profile>();
  const compLean = new Map<string, number[]>();
  employees.forEach((e, i) => {
    profileOf.set(e.id, PROFILES[i % PROFILES.length]);
    compLean.set(e.id, Array.from({ length: 12 }, (_v, ci) => ((i + ci) % 3) - 1));
  });

  const scoring = standaloneScoring();

  const plan: { cycle: { id: string }; count: number; drift: number; closed: boolean }[] = [
    { cycle: cycles.closed2024, count: 14, drift: -0.35, closed: true },
    { cycle: cycles.closed2025, count: 20, drift: -0.15, closed: true },
    { cycle: cycles.active, count: 28, drift: 0, closed: false },
  ];

  for (const { cycle, count, drift, closed } of plan) {
    const cycleQs = await cycleQuestions(cycle.id);
    const ratingQs = cycleQs.filter((q) => q.type === 'rating');
    const textQs = cycleQs.filter((q) => q.type === 'text');
    const sources = new Map<string, string>();
    for (const s of SOURCES) {
      const row = await prisma.feedbackSource.create({
        data: { cycleId: cycle.id, code: s.code, label: s.label, weight: s.weight, requiredCount: s.required, isAnonymous: s.anonymous },
      });
      sources.set(s.code, row.id);
    }

    const cohort = employees.filter((e) => peersOf(e).length > 0 || (reportsOf.get(e.id) ?? []).length > 0).slice(0, count);
    for (const emp of cohort) {
      const participant = await prisma.appraisalParticipant.create({
        data: { cycleId: cycle.id, employeeId: emp.id, status: 'pending', visibility: 'draft' },
      });
      const profile = profileOf.get(emp.id)!;
      const leans = compLean.get(emp.id)!;

      const raters: { sourceCode: string; reviewerId: string | null }[] = [
        { sourceCode: 'self', reviewerId: emp.id },
        { sourceCode: 'manager', reviewerId: emp.lineManagerId ?? null },
      ];
      // Multiple evaluators per quadrant — enough peers to clear the anonymity
      // threshold for most people, deliberately too few for some.
      const peers = peersOf(emp).slice(0, 3 + (rnd() > 0.6 ? 1 : 0));
      const subs = (reportsOf.get(emp.id) ?? []).slice(0, rnd() > 0.5 ? 3 : 2);
      peers.forEach((id) => raters.push({ sourceCode: 'peer', reviewerId: id }));
      subs.forEach((id) => raters.push({ sourceCode: 'subordinate', reviewerId: id }));

      for (const r of raters) {
        if (!r.reviewerId) continue;
        // Mixed completion: the active cycle is deliberately mid-flight.
        const roll = rnd();
        const status = closed ? (roll > 0.06 ? 'submitted' : 'pending') : roll > 0.28 ? 'submitted' : roll > 0.14 ? 'in_progress' : 'pending';
        const assignment = await prisma.reviewerAssignment.create({
          data: {
            organizationId: orgId,
            cycleId: cycle.id,
            participantId: participant.id,
            sourceId: sources.get(r.sourceCode)!,
            reviewerEmployeeId: r.reviewerId,
            reviewerType: 'internal',
            status,
            nominationStatus: 'approved',
            submittedAt: status === 'submitted' ? new Date() : null,
          },
        });
        if (status === 'pending') continue;

        const lean = QUADRANT_LEAN[r.sourceCode] ?? 0;
        const rows: Prisma.FeedbackResponseCreateManyInput[] = ratingQs.map((q, ci) => ({
          assignmentId: assignment.id,
          questionId: q.id,
          ratingValue: clamp5(profile.base + drift + lean + leans[ci] * 0.6 + (rnd() - 0.5) * 0.8),
        }));
        // Written feedback: strengths from raters who scored well, development notes
        // from those who did not. Self answers are attributable; the rest pool.
        if (textQs.length > 0 && status === 'submitted') {
          const avg = rows.reduce((a, b) => a + Number(b.ratingValue ?? 0), 0) / Math.max(1, rows.length);
          rows.push({
            assignmentId: assignment.id,
            questionId: textQs[0].id,
            textValue: r.sourceCode === 'self'
              ? 'I want to keep improving how I plan the term and communicate changes early.'
              : avg >= 4
                ? pick(COMMENTS_STRENGTH)
                : pick(COMMENTS_DEVELOPMENT),
          });
        }
        await prisma.feedbackResponse.createMany({ data: rows, skipDuplicates: true });
      }

      // Real scoring — never a hand-written final score.
      await scoring.compute(participant.id);

      if (closed) {
        await prisma.appraisalParticipant.update({
          where: { id: participant.id },
          data: { visibility: 'released', releasedAt: new Date(), releasedBy: actor, status: 'completed' },
        });
      }
    }
    console.log(`   ${cohort.length} participants in cycle ${cycle.id.slice(0, 8)}`);
  }

  // HR calibration on two participants in the closed 2025 cycle, so the override
  // rule, the audit entry and the "calibrated" badge all have something to show.
  const calibrate = await prisma.appraisalParticipant.findMany({
    where: { cycleId: cycles.closed2025.id, finalScore: { not: null } },
    take: 2,
    orderBy: { finalScore: 'desc' },
  });
  for (const p of calibrate) {
    const adjusted = Math.min(5, Number(p.finalScore) + 0.2);
    await prisma.appraisalParticipant.update({
      where: { id: p.id },
      data: { finalScore: adjusted, calibratedAt: new Date(), status: 'completed', potentialRating: 4 },
    });
    await prisma.feedbackAuditEvent.create({
      data: {
        organizationId: orgId, action: 'score.calibrated', actorUserId: actor, actorName: 'Administrator', actorRole: 'Super Admin',
        cycleId: cycles.closed2025.id, cycleName: 'Annual Review 2025', evaluateeEmployeeId: p.employeeId,
        entityType: 'participant', entityId: p.id,
        previousValue: { finalScore: Number(p.finalScore) } as Prisma.InputJsonValue,
        newValue: { finalScore: adjusted } as Prisma.InputJsonValue,
        reason: 'Moderation panel adjustment',
      },
    });
  }

  // Potential ratings across the active cycle so the nine-box grid is populated.
  const activeParticipants = await prisma.appraisalParticipant.findMany({ where: { cycleId: cycles.active.id, finalScore: { not: null } } });
  for (const p of activeParticipants) {
    const score = Number(p.finalScore);
    await prisma.appraisalParticipant.update({
      where: { id: p.id },
      data: { potentialRating: score >= 4.2 ? 3 : score >= 3.4 ? 2 : 1 },
    });
  }
}

/** ScoringService without the Nest container: real logic, inert audit sinks. */
function standaloneScoring(): ScoringService {
  const noop = { record: async () => undefined } as never;
  return new ScoringService(prisma as never, noop, noop);
}

/* ----------------------------------------------------------- engagement */

/**
 * eNPS is measured on a 0–10 scale, but `assertValidResponses` validates ratings
 * against the CYCLE's rating scale, not the question's. Bolting an eNPS question
 * onto the 1–5 review questionnaire would therefore make that questionnaire
 * unsubmittable. It gets its own scale, questionnaire and short pulse cycle — which
 * is also how a real organisation would run it.
 */
async function seedEngagementPulse(orgId: string, actor: string): Promise<void> {
  const scale = await prisma.ratingScale.create({
    data: {
      organizationId: orgId, name: 'eNPS 0–10', scaleType: 'custom', minValue: 0, maxValue: 10,
      createdBy: actor, updatedBy: actor,
      levels: { create: Array.from({ length: 11 }, (_v, i) => ({ value: i, label: String(i), sortOrder: i })) },
    },
  });
  const question = await prisma.question.create({
    data: {
      organizationId: orgId, text: 'How likely are you to recommend this organisation as a place to work?',
      type: 'rating', ratingScaleId: scale.id, category: 'eNPS', isMandatory: true, createdBy: actor, updatedBy: actor,
    },
  });
  const template = await prisma.questionnaireTemplate.create({
    data: {
      organizationId: orgId, name: 'Engagement Pulse', description: 'Single-question employee net promoter score.',
      status: 'published', version: 1, createdBy: actor, updatedBy: actor,
      sections: { create: [{ title: 'eNPS', sortOrder: 0 }] },
    },
    include: { sections: true },
  });
  await prisma.sectionQuestion.create({ data: { sectionId: template.sections[0].id, questionId: question.id, sortOrder: 0 } });

  const cycle = await prisma.appraisalCycle.create({
    data: {
      organizationId: orgId, name: 'Engagement Pulse 2026', startDate: new Date('2026-03-01'), endDate: new Date('2026-03-31'),
      status: 'closed', templateId: template.id, ratingScaleId: scale.id, createdBy: actor, updatedBy: actor,
    },
  });
  const source = await prisma.feedbackSource.create({
    data: { cycleId: cycle.id, code: 'self', label: 'Self', weight: 1, requiredCount: 1, isAnonymous: false },
  });
  const employees = await prisma.employee.findMany({ where: { organizationId: orgId, deletedAt: null }, select: { id: true }, take: 40, orderBy: { employeeCode: 'asc' } });
  for (const e of employees) {
    const participant = await prisma.appraisalParticipant.create({ data: { cycleId: cycle.id, employeeId: e.id, status: 'completed', visibility: 'released' } });
    const assignment = await prisma.reviewerAssignment.create({
      data: {
        organizationId: orgId, cycleId: cycle.id, participantId: participant.id, sourceId: source.id,
        reviewerEmployeeId: e.id, reviewerType: 'internal', status: 'submitted', nominationStatus: 'approved', submittedAt: new Date(),
      },
    });
    // A believable spread: mostly promoters and passives, a real tail of detractors.
    const roll = rnd();
    const value = roll > 0.55 ? 9 + Math.round(rnd()) : roll > 0.25 ? 7 + Math.round(rnd()) : Math.round(rnd() * 6);
    await prisma.feedbackResponse.create({ data: { assignmentId: assignment.id, questionId: question.id, ratingValue: value } });
  }
  console.log(`   eNPS pulse: ${employees.length} responses on a 0–10 scale`);
}

/* -------------------------------------------------------------------- SIS */

const SUBJECTS = ['Mathematics', 'English Language', 'General Science', 'Social Studies', 'Computer Science', 'Islamiyat', 'Urdu', 'Physics', 'Chemistry', 'Biology'];
const FIRST = ['Ahmed', 'Ayesha', 'Bilal', 'Fatima', 'Hamza', 'Iqra', 'Junaid', 'Kiran', 'Mahnoor', 'Noman', 'Rabia', 'Saad', 'Sana', 'Talha', 'Zara', 'Usman', 'Hira', 'Danish', 'Maryam', 'Faizan'];
const LAST = ['Khan', 'Ahmed', 'Malik', 'Siddiqui', 'Raza', 'Javed', 'Sheikh', 'Qureshi', 'Farooqi', 'Aslam'];
/** A student's family name — the index the guardian names below must agree with. */
const surnameOf = (i: number): string => LAST[Math.floor(i / FIRST.length) % LAST.length];
const name = (i: number): string => `${FIRST[i % FIRST.length]} ${surnameOf(i)}`;

/*
 * Guardian names used to be `${LAST[i % LAST.length]} Sahib` — a DIFFERENT index
 * from the student's surname, so 108 of 120 students had a father whose family
 * name did not match their own, and "Khan Sahib" appeared twelve times with twelve
 * different phone numbers. These pools give each guardian a real given name paired
 * with the student's own surname, so a family reads as a family.
 */
const FATHER_FIRST = ['Tariq', 'Imran', 'Nadeem', 'Shahid', 'Kamran', 'Rashid', 'Waseem', 'Arif', 'Zafar', 'Naveed', 'Aamir', 'Sohail', 'Yasir', 'Adnan', 'Faisal', 'Iftikhar', 'Riaz', 'Shakeel', 'Tanveer', 'Mubashir'];
const MOTHER_FIRST = ['Nusrat', 'Shazia', 'Rubina', 'Farzana', 'Naheed', 'Samina', 'Tahira', 'Yasmin', 'Nasreen', 'Shaista', 'Uzma', 'Rehana', 'Saima', 'Bushra', 'Nighat', 'Asma', 'Shahnaz', 'Kausar', 'Parveen', 'Ghazala'];

/*
 * Mobile numbers that do not read as a counter. The old scheme was
 * `+92321` + (2000000 + i), which produced +923212000000, +923212000001, … —
 * obviously fake at a glance. This spreads across the real Pakistani mobile
 * prefixes and multiplies the index, so the numbers look plausible while staying
 * deterministic (the seed must produce the same roster on every run).
 */
const MOBILE_PREFIX = ['0300', '0301', '0321', '0333', '0334', '0345', '0332', '0308'];
function mobileFor(i: number, seq: number): string {
  const prefix = MOBILE_PREFIX[(i * 3 + seq) % MOBILE_PREFIX.length];
  const body = String(((i * 74207 + seq * 3571 + 1180337) % 9000000) + 1000000);
  return `+92${prefix.slice(1)}${body}`;
}

async function seedSis(orgId: string, actor: string, _campusByUnit: Map<string, string>): Promise<SisSnapshot> {
  const ref = (id: string, code: string, n: string) => ({ id, code, name: n });

  const campuses = CAMPUSES.map((c, i) => ref(`C${i + 1}`, `C${i + 1}`, c.name));
  const faculties = [ref('F1', 'F1', 'Faculty of Science'), ref('F2', 'F2', 'Faculty of Arts')];
  const departments = [ref('D1', 'D1', 'Junior School'), ref('D2', 'D2', 'Senior School'), ref('D3', 'D3', 'Pre-School')];
  const programs = [ref('P1', 'P1', 'Primary Programme'), ref('P2', 'P2', 'Secondary Programme')];
  const sessions = [ref('S2025', 'S2025', '2025-2026')];
  const semesters = [ref('T1', 'T1', 'Term 1'), ref('T2', 'T2', 'Term 2')];
  const classes = ['Grade 4', 'Grade 5', 'Grade 6', 'Grade 7'].map((n, i) => ref(`CL${i + 1}`, `CL${i + 1}`, n));
  const sections = classes.flatMap((c) => ['A', 'B'].map((s) => ref(`${c.id}-${s}`, `${c.code}-${s}`, `${c.name} ${s}`)));
  const subjects = SUBJECTS.map((n, i) => ({ id: `SUB${i + 1}`, code: `SUBJ-${String(i + 1).padStart(3, '0')}`, name: n, department: i < 5 ? 'Junior School' : 'Senior School', program: i < 5 ? 'Primary Programme' : 'Secondary Programme', creditHours: 3, status: 'active' }));

  // Teachers mirror the first 20 employees by code, so identity mapping resolves.
  const staff = await prisma.employee.findMany({
    where: { organizationId: orgId, deletedAt: null },
    select: { id: true, employeeCode: true, user: { select: { fullName: true, email: true } }, designation: { select: { name: true } }, department: { select: { name: true } } },
    orderBy: { employeeCode: 'asc' },
    take: 20,
  });
  const teachers = staff.map((e, i) => ({
    id: `T${100 + i}`,
    employeeCode: e.employeeCode,
    name: e.user.fullName ?? e.employeeCode,
    designation: e.designation?.name ?? 'Teacher',
    department: e.department?.name ?? 'Junior School',
    faculty: i % 2 === 0 ? 'Faculty of Science' : 'Faculty of Arts',
    mobile: `+92300${String(1000000 + i)}`,
    email: e.user.email,
    status: 'active',
  }));

  // Multiple subjects per teacher and multiple sections per subject.
  const teachingAssignments = teachers.flatMap((t, ti) =>
    [0, 1, 2].map((k) => {
      const subject = subjects[(ti + k) % subjects.length];
      const section = sections[(ti * 2 + k) % sections.length];
      const cls = classes.find((c) => section.id.startsWith(c.id))!;
      return {
        id: `TA${ti}-${k}`,
        teacherId: t.id,
        teacher: t.name,
        subjectId: subject.id,
        subject: subject.name,
        subjectCode: subject.code,
        session: sessions[0].name,
        semester: semesters[k % semesters.length].name,
        campus: campuses[ti % campuses.length].name,
        program: subject.program,
        gradeClass: cls.name,
        section: section.name,
        startDate: '2025-08-01',
        endDate: null as string | null,
        status: 'active',
      };
    }),
  );

  const students = Array.from({ length: 120 }, (_v, i) => {
    const section = sections[i % sections.length];
    const cls = classes.find((c) => section.id.startsWith(c.id))!;
    return {
      id: `S${1000 + i}`,
      registrationNo: `REG-2025-${String(i + 1).padStart(4, '0')}`,
      rollNo: `${cls.code}-${String((i % 20) + 1).padStart(3, '0')}`,
      name: name(i),
      gender: i % 2 === 0 ? 'male' : 'female',
      status: 'active',
      program: cls.name.startsWith('Grade 4') || cls.name.startsWith('Grade 5') ? 'Primary Programme' : 'Secondary Programme',
      campus: campuses[i % campuses.length].name,
      currentClass: cls.name,
      currentSection: section.name,
      dateOfBirth: `20${13 + (i % 4)}-0${(i % 9) + 1}-15`,
      admissionDate: '2025-08-01',
      faculty: i % 2 === 0 ? 'Faculty of Science' : 'Faculty of Arts',
      department: cls.name.startsWith('Grade 4') ? 'Junior School' : 'Senior School',
      session: sessions[0].name,
      semester: semesters[0].name,
    };
  });

  // Most students have two guardians, some one — realistic and enough contacts
  // for the parent-feedback workflow.
  const parents = students.flatMap((s, i) => {
    const family = surnameOf(i);
    const father = `${FATHER_FIRST[i % FATHER_FIRST.length]} ${family}`;
    const fatherMobile = mobileFor(i, 1);
    const rows = [{
      id: `PA${i}-1`, studentId: s.id, name: father, relationship: 'father',
      mobile: fatherMobile, whatsapp: fatherMobile,
      // A shared family domain rather than parentNa@example.com — it reads like a
      // household and makes the father/mother pairing obvious in the UI.
      email: `${FATHER_FIRST[i % FATHER_FIRST.length].toLowerCase()}.${family.toLowerCase()}${i}@gmail.com`,
      preferredLanguage: i % 5 === 0 ? 'ur' : 'en', active: true,
      origin: 'sis' as const,
    }];
    if (i % 3 !== 0) {
      const mother = `${MOTHER_FIRST[(i * 7) % MOTHER_FIRST.length]} ${family}`;
      const motherMobile = mobileFor(i, 2);
      rows.push({
        id: `PA${i}-2`, studentId: s.id, name: mother, relationship: 'mother',
        mobile: motherMobile, whatsapp: motherMobile,
        email: `${MOTHER_FIRST[(i * 7) % MOTHER_FIRST.length].toLowerCase()}.${family.toLowerCase()}${i}@gmail.com`,
        preferredLanguage: i % 5 === 0 ? 'ur' : 'en', active: true,
        origin: 'sis' as const,
      });
    }
    return rows;
  });

  const enrollments = students.flatMap((s) => {
    const secTAs = teachingAssignments.filter((ta) => ta.section === s.currentSection).slice(0, 3);
    return secTAs.map((ta) => ({
      id: `EN-${s.id}-${ta.id}`,
      studentId: s.id,
      teachingAssignmentId: ta.id,
      teacher: ta.teacher,
      subject: ta.subject,
      subjectCode: ta.subjectCode,
      gradeClass: ta.gradeClass,
      section: ta.section,
      session: ta.session,
      enrollmentDate: '2025-08-01',
      status: 'active',
    }));
  });

  const snapshot = {
    campuses, faculties, departments, programs, sessions, semesters, classes, sections,
    subjects, teachers, students, parents, teachingAssignments, enrollments,
  } as unknown as SisSnapshot;

  await prisma.sisDataset.upsert({
    where: { organizationId: orgId },
    update: { provider: 'mock', snapshot: snapshot as unknown as Prisma.InputJsonValue, studentCount: students.length, teacherCount: teachers.length, updatedBy: actor },
    create: { organizationId: orgId, provider: 'mock', snapshot: snapshot as unknown as Prisma.InputJsonValue, studentCount: students.length, teacherCount: teachers.length, updatedBy: actor },
  });
  await writeConfig(orgId, 'sis_integration', 'settings', { provider: 'mock', autoSync: false, intervalHours: 24, mockScenario: 'full', lastSyncAt: new Date().toISOString() }, actor);
  await prisma.sisSyncRun.create({
    data: {
      organizationId: orgId, provider: 'mock', mode: 'live', trigger: 'manual', status: 'completed',
      createdBy: actor, createdByName: 'Administrator',
      created: students.length + teachers.length, updated: 0, deactivated: 0, failed: 0, warnings: 0,
      summary: { students: students.length, teachers: teachers.length, parents: parents.length } as Prisma.InputJsonValue,
      startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(),
    },
  });

  // Teacher ↔ employee identity maps — the link the parent workflow depends on.
  for (const t of teachers) {
    const emp = staff.find((e) => e.employeeCode === t.employeeCode);
    if (!emp) continue;
    const exists = await prisma.externalIdentityMap.findFirst({ where: { organizationId: orgId, externalType: 'teacher', externalId: t.id } });
    if (exists) continue;
    await prisma.externalIdentityMap.create({
      data: { organizationId: orgId, externalType: 'teacher', externalId: t.id, externalCode: t.employeeCode, employeeId: emp.id, active: true, createdBy: actor },
    });
  }
  console.log(`   ${students.length} students · ${parents.length} guardians · ${teachers.length} teachers · ${teachingAssignments.length} teaching assignments · ${enrollments.length} enrolments`);
  return snapshot;
}

/* ------------------------------------------------------- parent evaluations */

async function seedParentEvaluations(orgId: string, _actor: string, cycleId: string, snapshot: SisSnapshot): Promise<void> {
  const { createHash, randomBytes } = await import('node:crypto');
  const source = await prisma.feedbackSource.create({
    data: { cycleId, code: 'parent', label: 'Parents', weight: 1, requiredCount: 3, isAnonymous: true },
  });
  const template = await prisma.questionnaireTemplate.findFirstOrThrow({ where: { organizationId: orgId, status: 'published', deletedAt: null } });
  const cycleQs = await cycleQuestions(cycleId);
  const ratingQs = cycleQs.filter((q) => q.type === 'rating');
  const textQs = cycleQs.filter((q) => q.type === 'text');

  // Three teachers receive parent feedback; two get enough responses to clear the
  // anonymity threshold, one deliberately does not.
  const targets = (snapshot.teachers as unknown as { id: string; employeeCode: string; name: string }[]).slice(0, 3);
  const counts = [4, 3, 2];

  for (let ti = 0; ti < targets.length; ti += 1) {
    const teacher = targets[ti];
    const map = await prisma.externalIdentityMap.findFirst({ where: { organizationId: orgId, externalType: 'teacher', externalId: teacher.id, active: true } });
    if (!map) continue;
    let participant = await prisma.appraisalParticipant.findFirst({ where: { cycleId, employeeId: map.employeeId } });
    if (!participant) participant = await prisma.appraisalParticipant.create({ data: { cycleId, employeeId: map.employeeId, status: 'pending', visibility: 'draft' } });

    const students = (snapshot.students as unknown as { id: string; name: string; currentClass?: string; currentSection?: string }[]).slice(ti * 6, ti * 6 + counts[ti]);
    for (const student of students) {
      const guardian = (snapshot.parents as unknown as { id: string; studentId: string; name: string; whatsapp?: string | null }[]).find((p) => p.studentId === student.id);
      const raw = randomBytes(24).toString('base64url');
      const assignment = await prisma.reviewerAssignment.create({
        data: {
          organizationId: orgId, cycleId, participantId: participant.id, sourceId: source.id,
          reviewerEmployeeId: null, reviewerType: 'external',
          // The guardian's actual name, not a constant. Every parent reviewer used to
          // read "Parent (secure link)", which made nine rows indistinguishable in the
          // admin views. This is a DISPLAY field for administrators; report anonymity
          // is enforced separately by min_responses_to_show in ReportsService and is
          // unaffected. The consolidated seeder below already did this correctly.
          externalRef: guardian?.id ?? student.id, externalName: guardian?.name ?? `Parent of ${student.name}`,
          status: 'submitted', nominationStatus: 'approved', submittedAt: new Date(),
        },
      });
      await prisma.evaluationLink.create({
        data: {
          organizationId: orgId,
          tokenHash: createHash('sha256').update(raw).digest('hex'),
          studentId: student.id, studentName: student.name,
          parentId: guardian?.id ?? null, parentName: guardian?.name ?? null,
          recipient: guardian?.whatsapp ?? null,
          teacherId: teacher.id, teacherName: teacher.name,
          className: student.currentClass ?? null, sectionName: student.currentSection ?? null,
          templateId: template.id, employeeId: map.employeeId,
          reviewerAssignmentId: assignment.id, cycleId,
          status: 'completed', sendChannel: 'whatsapp',
          sentAt: new Date(Date.now() - 3 * 86_400_000),
          openedAt: new Date(Date.now() - 2 * 86_400_000),
          completedAt: new Date(Date.now() - 86_400_000),
          expiresAt: new Date(Date.now() + 30 * 86_400_000),
        },
      });
      const rows: Prisma.FeedbackResponseCreateManyInput[] = ratingQs.map((q) => ({
        assignmentId: assignment.id, questionId: q.id, ratingValue: clamp5(4 + (rnd() - 0.5) * 1.6),
      }));
      if (textQs[0]) rows.push({ assignmentId: assignment.id, questionId: textQs[0].id, textValue: pick(COMMENTS_PARENT) });
      await prisma.feedbackResponse.createMany({ data: rows, skipDuplicates: true });
    }
    await standaloneScoring().compute(participant.id);
  }
  console.log(`   parent feedback for ${targets.length} teachers (${counts.join(', ')} responses — the last stays below the anonymity threshold)`);
}

/* --------------------------------------- consolidated parent feedback mode */

/**
 * Demonstrates the alternative parent workflow: ONE form per student covering every
 * teacher that child has, instead of one link per teacher.
 *
 * Configured on the UPCOMING (draft) cycle, alongside the per-quadrant questionnaire
 * example, and for the same reason: the scored cycles keep the parent feedback they
 * were actually given. Nothing here changes a historical score.
 *
 * The consolidated form asks exactly one question about each teacher, so the Parents
 * quadrant gets its own single-question questionnaire — which is also the shape the
 * product validates when an administrator switches the mode on.
 */
async function seedConsolidatedParentMode(orgId: string, actor: string, cycles: CycleSet, snapshot: SisSnapshot): Promise<void> {
  const category = await prisma.competencyCategory.findFirstOrThrow({ where: { organizationId: orgId, deletedAt: null } });
  let competency = await prisma.competency.findFirst({ where: { organizationId: orgId, name: 'Parent Experience', deletedAt: null } });
  if (!competency) {
    competency = await prisma.competency.create({
      data: {
        organizationId: orgId,
        categoryId: category.id,
        name: 'Parent Experience',
        description: 'How parents rate their overall experience of a teacher.',
        createdBy: actor,
        updatedBy: actor,
      },
    });
    const version = await prisma.competencyVersion.create({
      data: { organizationId: orgId, competencyId: competency.id, versionLabel: 'v1', status: 'active', createdBy: actor, updatedBy: actor },
    });
    await prisma.proficiencyLevel.createMany({
      data: ['Basic', 'Developing', 'Proficient', 'Advanced', 'Expert'].map((name, li) => ({
        organizationId: orgId,
        versionId: version.id,
        level: li + 1,
        name,
        description: `${name} parent experience.`,
      })),
    });
  }

  const template = await prisma.questionnaireTemplate.create({
    data: {
      organizationId: orgId,
      name: 'Parent Experience 2027',
      description: 'One question, asked about each of a student\'s teachers on a single consolidated form.',
      status: 'published',
      createdBy: actor,
      updatedBy: actor,
    },
  });
  const section = await prisma.templateSection.create({ data: { templateId: template.id, title: 'Your child\'s teachers', sortOrder: 0 } });
  const question = await prisma.question.create({
    data: {
      organizationId: orgId,
      competencyId: competency.id,
      text: "How would you rate this teacher based on your child's learning experience and your overall interaction with the teacher?",
      type: 'rating',
      isMandatory: true,
      createdBy: actor,
      updatedBy: actor,
    },
  });
  await prisma.sectionQuestion.create({ data: { sectionId: section.id, questionId: question.id, sortOrder: 0 } });

  // The draft cycle's quadrants are created by seedQuadrantQuestionnaire; add Parents.
  const source = await prisma.feedbackSource.create({
    data: {
      cycleId: cycles.upcoming.id,
      code: 'parent',
      label: 'Parents',
      weight: 1,
      requiredCount: 3,
      isAnonymous: true,
      templateId: template.id,
      parentMode: 'consolidated',
      parentRequireAll: false,
    },
  });

  // One consolidated link per student for the first few students, so the admin screen
  // and the completion tracking have something real to show. Tokens are hashed only,
  // like every other link.
  const { createHash, randomBytes } = await import('node:crypto');
  const students = snapshot.students.slice(0, 3);
  let generated = 0;
  let coveredTeachers = 0;
  for (const student of students) {
    const asgIds = new Set(snapshot.enrollments.filter((e) => e.studentId === student.id).map((e) => e.teachingAssignmentId));
    const rows = snapshot.teachingAssignments.filter((a) => asgIds.has(a.id));
    // Deduplicate by teacher: a teacher who takes this child for two subjects must be
    // rated once, not twice, or their average and anonymity count are both inflated.
    const byTeacher = new Map<string, { teacherId: string; teacher: string; subjects: string[]; assignmentId: string }>();
    for (const a of rows) {
      const seen = byTeacher.get(a.teacherId);
      if (seen) { if (a.subject && !seen.subjects.includes(a.subject)) seen.subjects.push(a.subject); continue; }
      byTeacher.set(a.teacherId, { teacherId: a.teacherId, teacher: a.teacher, subjects: a.subject ? [a.subject] : [], assignmentId: a.id });
    }
    const guardian = snapshot.parents.find((p) => p.studentId === student.id);
    const resolved: { t: { teacherId: string; teacher: string; subjects: string[]; assignmentId: string }; employeeId: string }[] = [];
    for (const t of byTeacher.values()) {
      const map = await prisma.externalIdentityMap.findFirst({
        where: { organizationId: orgId, externalType: 'teacher', externalId: t.teacherId, active: true },
        select: { employeeId: true },
      });
      if (map?.employeeId) resolved.push({ t, employeeId: map.employeeId });
    }
    if (resolved.length === 0) continue;

    const raw = randomBytes(24).toString('base64url');
    const link = await prisma.evaluationLink.create({
      data: {
        organizationId: orgId,
        tokenHash: createHash('sha256').update(raw).digest('hex'),
        mode: 'consolidated',
        studentId: student.id,
        studentName: student.name,
        parentId: guardian?.id ?? null,
        parentName: guardian?.name ?? null,
        recipient: guardian?.whatsapp ?? guardian?.mobile ?? null,
        teacherId: null,
        className: student.currentClass ?? null,
        sectionName: student.currentSection ?? null,
        templateId: template.id,
        cycleId: cycles.upcoming.id,
        status: 'sent',
        sendChannel: 'whatsapp',
        sentAt: new Date(Date.now() - 2 * 86_400_000),
        oneTime: true,
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
        createdBy: actor,
      },
    });
    let order = 0;
    for (const { t, employeeId } of resolved) {
      let participant = await prisma.appraisalParticipant.findFirst({ where: { cycleId: cycles.upcoming.id, employeeId }, select: { id: true } });
      if (!participant) participant = await prisma.appraisalParticipant.create({ data: { cycleId: cycles.upcoming.id, employeeId }, select: { id: true } });
      const assignment = await prisma.reviewerAssignment.create({
        data: {
          organizationId: orgId,
          cycleId: cycles.upcoming.id,
          participantId: participant.id,
          sourceId: source.id,
          reviewerEmployeeId: null,
          reviewerType: 'external',
          externalRef: link.id,
          externalName: guardian?.name ?? `Parent of ${student.name}`,
          nominationStatus: 'approved',
          status: 'pending',
        },
      });
      await prisma.evaluationLinkTarget.create({
        data: {
          linkId: link.id,
          teacherId: t.teacherId,
          teacherName: t.teacher,
          subjectNames: t.subjects.join(', ') || null,
          teachingAssignmentId: t.assignmentId,
          employeeId,
          reviewerAssignmentId: assignment.id,
          sortOrder: order++,
        },
      });
      coveredTeachers++;
    }
    generated++;
  }
  console.log(`   "${MARKER_UPCOMING}" Parents quadrant uses the consolidated form; ${generated} student form(s) covering ${coveredTeachers} teacher rating(s), awaiting the parents`);
}

/* ------------------------------------------------------------- HR history */

async function seedHrHistory(orgId: string, admin: { id: string }): Promise<void> {
  await writeConfig(orgId, 'hr_integration', 'settings', { mode: 'internal', provider: 'mock', autoSync: false, intervalHours: 24, mockScenario: 'full', lastSyncAt: new Date(Date.now() - 86_400_000).toISOString() }, admin.id);
  for (const [i, run] of [
    { mode: 'dry_run', created: 6, updated: 0, deactivated: 0 },
    { mode: 'live', created: 6, updated: 0, deactivated: 0 },
    { mode: 'live', created: 0, updated: 2, deactivated: 1 },
  ].entries()) {
    await prisma.hrSyncRun.create({
      data: {
        organizationId: orgId, provider: 'mock', mode: run.mode, trigger: i === 2 ? 'scheduled' : 'manual', status: 'completed',
        createdBy: admin.id, createdByName: 'Administrator',
        created: run.created, updated: run.updated, deactivated: run.deactivated, failed: 0, warnings: 0,
        summary: { note: 'Mock HR provider' } as Prisma.InputJsonValue,
        startedAt: new Date(Date.now() - (3 - i) * 86_400_000), finishedAt: new Date(Date.now() - (3 - i) * 86_400_000 + 5_000),
      },
    });
  }
}

/* ------------------------------------- communication, notifications, audit */

async function seedCommsAndAudit(orgId: string, admin: { id: string; email: string }, cycles: CycleSet): Promise<void> {
  const employees = await prisma.employee.findMany({
    where: { organizationId: orgId, deletedAt: null },
    select: { id: true, userId: true, user: { select: { email: true, fullName: true } } },
    take: 14, orderBy: { employeeCode: 'asc' },
  });

  // Delivery records across every channel and every terminal status.
  const rows: Prisma.NotificationCreateManyInput[] = [];
  employees.forEach((e, i) => {
    const channel = i % 3 === 0 ? 'email' : i % 3 === 1 ? 'whatsapp' : 'sms';
    const status = i % 7 === 0 ? 'failed' : i % 5 === 0 ? 'queued' : 'sent';
    rows.push({
      organizationId: orgId,
      channel: channel as never,
      recipient: channel === 'email' ? e.user.email ?? '' : `+9230012345${String(i).padStart(2, '0')}`,
      subject: channel === 'email' ? 'Your 360 feedback is due' : null,
      body: `Hello ${e.user.fullName ?? ''}, you have outstanding 360 feedback for Annual Review 2026.`,
      templateKey: 'appraisal.reminder',
      status,
      provider: channel === 'email' ? 'smtp' : channel === 'sms' ? 'twilio' : 'meta',
      providerMessageId: status === 'sent' ? `demo-${i}-${Date.now()}` : null,
      error: status === 'failed' ? 'Recipient mailbox unavailable' : null,
      sentAt: status === 'sent' ? new Date(Date.now() - i * 3_600_000) : null,
      createdBy: admin.id,
    });
  });
  rows.push({
    organizationId: orgId, channel: 'email' as never, recipient: admin.email,
    subject: 'Annual Review 2026 has started', body: 'The 2026 feedback cycle is now open. Reviewers have been notified.',
    templateKey: 'cycle.started', status: 'sent', provider: 'smtp', providerMessageId: `demo-cycle-${Date.now()}`, sentAt: new Date(), createdBy: admin.id,
  });
  await prisma.notification.createMany({ data: rows });

  // `code` is globally unique, so this has to be an upsert rather than a create.
  // As a create it aborted the second `db:demo --force` run with a unique-constraint
  // violation — and it did so at the very END, after the roster, the cycles and all
  // the feedback had already been written, leaving a half-seeded database.
  await prisma.shortLink.upsert({
    where: { code: 'demo360' },
    update: { organizationId: orgId, targetUrl: 'http://localhost:5173/appraisal', clicks: 12, createdBy: admin.id },
    create: { organizationId: orgId, code: 'demo360', targetUrl: 'http://localhost:5173/appraisal', clicks: 12, createdBy: admin.id },
  });

  // In-app notifications, some read, some not.
  const inApp: Prisma.UserNotificationCreateManyInput[] = [];
  employees.slice(0, 10).forEach((e, i) => {
    inApp.push({
      organizationId: orgId, userId: e.userId!, type: 'review_assigned',
      title: 'You have feedback to complete', body: 'Annual Review 2026 — 2 reviews outstanding.',
      link: '/appraisal', readAt: i % 3 === 0 ? new Date() : null,
    });
  });
  // The administrator is who a demo is given from, so their bell must not be empty.
  const adminAlerts: [string, string, string, string][] = [
    ['cycle_started', 'Annual Review 2026 is active', '28 participants and their reviewers have been notified.', '/appraisal'],
    ['review_pending', '57 reviews still outstanding', 'Reminders are scheduled daily at 08:00.', '/appraisal'],
    ['results_released', 'Annual Review 2025 results released', '20 participants can now see their reports.', '/reports'],
    ['sis_sync', 'Student roster synced', '120 students and 20 teachers imported from the SIS.', '/student-integration'],
    ['hr_sync', 'HR sync completed', '2 employees updated, 1 deactivated.', '/hr-integration'],
    ['calibration', 'Calibration recorded', '2 scores were adjusted by the moderation panel.', '/appraisal'],
  ];
  adminAlerts.forEach(([type, title, body, link], i) => {
    inApp.push({ organizationId: orgId, userId: admin.id, type, title, body, link, readAt: i > 3 ? new Date() : null });
  });
  await prisma.userNotification.createMany({ data: inApp });

  // Generic audit log.
  const auditRows: Prisma.AuditLogCreateManyInput[] = [
    { organizationId: orgId, userId: admin.id, action: 'appraisal.cycle.create', entityType: 'appraisal_cycle', entityId: cycles.active.id, newValue: { name: MARKER_CYCLE } as Prisma.InputJsonValue },
    { organizationId: orgId, userId: admin.id, action: 'appraisal.cycle.activate', entityType: 'appraisal_cycle', entityId: cycles.active.id, newValue: { status: 'active' } as Prisma.InputJsonValue },
    { organizationId: orgId, userId: admin.id, action: 'organization.sis.sync', entityType: 'organization', entityId: orgId, newValue: { provider: 'mock' } as Prisma.InputJsonValue },
    { organizationId: orgId, userId: admin.id, action: 'organization.hr.sync', entityType: 'organization', entityId: orgId, newValue: { provider: 'mock', mode: 'live' } as Prisma.InputJsonValue },
  ];
  await prisma.auditLog.createMany({ data: auditRows });

  // Feedback-specific, append-only trail across the lifecycle.
  const participants = await prisma.appraisalParticipant.findMany({ where: { cycleId: cycles.active.id }, take: 6, include: { employee: { select: { id: true, user: { select: { fullName: true } } } } } });
  const events: Prisma.FeedbackAuditEventCreateManyInput[] = [
    { organizationId: orgId, action: 'cycle.created', actorUserId: admin.id, actorName: 'Administrator', actorRole: 'Super Admin', cycleId: cycles.active.id, cycleName: MARKER_CYCLE, entityType: 'cycle', entityId: cycles.active.id },
    { organizationId: orgId, action: 'cycle.started', actorUserId: admin.id, actorName: 'Administrator', actorRole: 'Super Admin', cycleId: cycles.active.id, cycleName: MARKER_CYCLE, entityType: 'cycle', entityId: cycles.active.id },
    { organizationId: orgId, action: 'cycle.closed', actorUserId: admin.id, actorName: 'Administrator', actorRole: 'Super Admin', cycleId: cycles.closed2025.id, cycleName: 'Annual Review 2025', entityType: 'cycle', entityId: cycles.closed2025.id },
  ];
  for (const p of participants) {
    events.push({
      organizationId: orgId, action: 'results.viewed', actorUserId: admin.id, actorName: 'Administrator', actorRole: 'Super Admin',
      cycleId: cycles.active.id, cycleName: MARKER_CYCLE,
      evaluateeEmployeeId: p.employee.id, evaluateeName: p.employee.user.fullName,
      entityType: 'report', entityId: p.employee.id, newValue: { report: 'individual' } as Prisma.InputJsonValue,
    });
  }
  const released = await prisma.appraisalParticipant.findMany({ where: { cycleId: cycles.closed2025.id, visibility: 'released' }, take: 5, include: { employee: { select: { id: true, user: { select: { fullName: true } } } } } });
  for (const p of released) {
    events.push({
      organizationId: orgId, action: 'results.released', actorUserId: admin.id, actorName: 'Administrator', actorRole: 'Super Admin',
      cycleId: cycles.closed2025.id, cycleName: 'Annual Review 2025',
      evaluateeEmployeeId: p.employee.id, evaluateeName: p.employee.user.fullName,
      entityType: 'participant', entityId: p.id,
    });
  }
  await prisma.feedbackAuditEvent.createMany({ data: events });
  console.log(`   ${rows.length} delivery records · ${inApp.length} in-app notifications · ${auditRows.length} audit logs · ${events.length} feedback audit events`);
}

/* ------------------------------------------------------------------ utils */

async function writeConfig(orgId: string, module: string, key: string, value: object, actor: string): Promise<void> {
  const existing = await prisma.configuration.findFirst({ where: { organizationId: orgId, module, key, deletedAt: null }, select: { id: true } });
  if (existing) {
    await prisma.configuration.update({ where: { id: existing.id }, data: { value: value as Prisma.InputJsonValue, updatedBy: actor } });
  } else {
    await prisma.configuration.create({ data: { organizationId: orgId, module, key, value: value as Prisma.InputJsonValue, createdBy: actor, updatedBy: actor } });
  }
}

main()
  .catch((e) => { console.error('Demo data failed:', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
