/**
 * Teardown for the black-box API suite.
 *
 * The suite creates real cycles, questionnaires, questions and competencies in the demo
 * tenant it runs against, all named with a `regr-` prefix or a millisecond stamp. Nothing
 * removed them, so every `npm test` permanently added roughly four cycles, two templates
 * and two competencies — 42 cycles had accumulated in the reference tenant before this
 * existed, cluttering every cycle picker in the application.
 *
 * The suite itself stays black-box over HTTP; only this teardown touches the database,
 * because the product deliberately offers no hard-delete endpoint for a cycle (feedback
 * history is meant to survive). Deleting through SQL here is the honest way to leave the
 * tenant as we found it.
 *
 * `feedback_audit_events` is left alone on purpose: a database trigger makes it
 * append-only, and an immutable record that these operations happened is correct. Its
 * rows carry denormalised cycle names, so they still read properly afterwards.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Names this suite generates. Nothing else in a seeded tenant matches these. */
const CYCLE_LIKE = 'regr-%';
const TEMPLATE_LIKE = 'regr-%';
/** Competencies are named `<Something> <13-digit stamp>`, e.g. "Shared Communication 1787225869724". */
const COMPETENCY_RE = '1[0-9]{12}';

export async function cleanupTestArtifacts() {
  let PrismaClient;
  try {
    ({ PrismaClient } = require('@prisma/client'));
  } catch {
    console.warn('cleanup: @prisma/client not resolvable — skipping teardown');
    return { skipped: true };
  }

  const prisma = new PrismaClient();
  try {
    const [cycles, templates, competencies] = await prisma.$transaction(async (tx) => {
      // Cycles and everything hanging off them. Parent evaluation links come first:
      // evaluation_link_targets holds a foreign key to reviewer_assignments, so the
      // assignments cannot be deleted while a target still points at one.
      await tx.$executeRawUnsafe(`
        DELETE FROM evaluation_link_targets WHERE link_id IN (
          SELECT l.id FROM evaluation_links l
          JOIN appraisal_cycles c ON c.id = l.cycle_id WHERE c.name LIKE $1)`, CYCLE_LIKE);
      await tx.$executeRawUnsafe(`
        DELETE FROM evaluation_links WHERE cycle_id IN (SELECT id FROM appraisal_cycles WHERE name LIKE $1)`, CYCLE_LIKE);
      await tx.$executeRawUnsafe(`
        DELETE FROM feedback_responses WHERE assignment_id IN (
          SELECT ra.id FROM reviewer_assignments ra
          JOIN appraisal_cycles c ON c.id = ra.cycle_id WHERE c.name LIKE $1)`, CYCLE_LIKE);
      await tx.$executeRawUnsafe(`
        DELETE FROM reviewer_assignments WHERE cycle_id IN (SELECT id FROM appraisal_cycles WHERE name LIKE $1)`, CYCLE_LIKE);
      await tx.$executeRawUnsafe(`
        DELETE FROM appraisal_participants WHERE cycle_id IN (SELECT id FROM appraisal_cycles WHERE name LIKE $1)`, CYCLE_LIKE);
      await tx.$executeRawUnsafe(`
        DELETE FROM feedback_sources WHERE cycle_id IN (SELECT id FROM appraisal_cycles WHERE name LIKE $1)`, CYCLE_LIKE);
      await tx.$executeRawUnsafe(`
        DELETE FROM report_schedules WHERE cycle_id IN (SELECT id FROM appraisal_cycles WHERE name LIKE $1)`, CYCLE_LIKE);
      const c = await tx.$executeRawUnsafe(`DELETE FROM appraisal_cycles WHERE name LIKE $1`, CYCLE_LIKE);

      // Questionnaires, their sections and the questions only they used.
      await tx.$executeRawUnsafe(`
        DELETE FROM feedback_responses WHERE question_id IN (
          SELECT sq.question_id FROM section_questions sq
          JOIN template_sections ts ON ts.id = sq.section_id
          JOIN questionnaire_templates t ON t.id = ts.template_id WHERE t.name LIKE $1)`, TEMPLATE_LIKE);
      await tx.$executeRawUnsafe(`
        CREATE TEMP TABLE _doomed_questions ON COMMIT DROP AS
        SELECT DISTINCT sq.question_id AS id FROM section_questions sq
        JOIN template_sections ts ON ts.id = sq.section_id
        JOIN questionnaire_templates t ON t.id = ts.template_id WHERE t.name LIKE $1`, TEMPLATE_LIKE);
      await tx.$executeRawUnsafe(`
        DELETE FROM section_questions WHERE section_id IN (
          SELECT ts.id FROM template_sections ts
          JOIN questionnaire_templates t ON t.id = ts.template_id WHERE t.name LIKE $1)`, TEMPLATE_LIKE);
      await tx.$executeRawUnsafe(`
        DELETE FROM template_sections WHERE template_id IN (SELECT id FROM questionnaire_templates WHERE name LIKE $1)`, TEMPLATE_LIKE);
      // A cycle or quadrant may still point at one of these templates.
      await tx.$executeRawUnsafe(`
        UPDATE appraisal_cycles SET template_id = NULL WHERE template_id IN (SELECT id FROM questionnaire_templates WHERE name LIKE $1)`, TEMPLATE_LIKE);
      await tx.$executeRawUnsafe(`
        UPDATE feedback_sources SET template_id = NULL WHERE template_id IN (SELECT id FROM questionnaire_templates WHERE name LIKE $1)`, TEMPLATE_LIKE);
      const t = await tx.$executeRawUnsafe(`DELETE FROM questionnaire_templates WHERE name LIKE $1`, TEMPLATE_LIKE);
      await tx.$executeRawUnsafe(`DELETE FROM questions WHERE id IN (SELECT id FROM _doomed_questions)`);

      // Competencies the suite invented, plus their versions and levels.
      await tx.$executeRawUnsafe(`
        CREATE TEMP TABLE _doomed_comps ON COMMIT DROP AS SELECT id FROM competencies WHERE name ~ $1`, COMPETENCY_RE);
      await tx.$executeRawUnsafe(`DELETE FROM rubrics WHERE competency_id IN (SELECT id FROM _doomed_comps)`);
      await tx.$executeRawUnsafe(`DELETE FROM competency_designation_mappings WHERE competency_id IN (SELECT id FROM _doomed_comps)`);
      await tx.$executeRawUnsafe(`UPDATE questions SET competency_id = NULL WHERE competency_id IN (SELECT id FROM _doomed_comps)`);
      await tx.$executeRawUnsafe(`
        DELETE FROM behaviour_indicators WHERE version_id IN (
          SELECT id FROM competency_versions WHERE competency_id IN (SELECT id FROM _doomed_comps))`);
      await tx.$executeRawUnsafe(`
        DELETE FROM proficiency_levels WHERE version_id IN (
          SELECT id FROM competency_versions WHERE competency_id IN (SELECT id FROM _doomed_comps))`);
      await tx.$executeRawUnsafe(`DELETE FROM competency_versions WHERE competency_id IN (SELECT id FROM _doomed_comps)`);
      const k = await tx.$executeRawUnsafe(`DELETE FROM competencies WHERE id IN (SELECT id FROM _doomed_comps)`);

      return [c, t, k];
    });

    if (cycles || templates || competencies) {
      console.log(`cleanup: removed ${cycles} test cycle(s), ${templates} questionnaire(s), ${competencies} competenc${competencies === 1 ? 'y' : 'ies'}`);
    }
    return { cycles, templates, competencies };
  } catch (err) {
    // Teardown must never turn a green run red.
    console.warn(`cleanup: skipped (${err.message})`);
    return { error: err.message };
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}
