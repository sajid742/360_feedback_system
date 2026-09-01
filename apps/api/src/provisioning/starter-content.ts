import { PrismaClient } from '@prisma/client';

/**
 * Neutral starter content for a brand-new tenant (F-C2).
 *
 * Previously the ONLY source of rating scales, competencies, questions and a
 * questionnaire template was the fictional demo-school sample-data script. An
 * organization doing a clean install therefore had nothing to build a cycle from:
 * no scale to rate on, no competencies to report against and no review form — so
 * no cycle could be authored or scored at all without a developer.
 *
 * This seeds a deliberately generic, industry-agnostic starter set that an admin
 * can immediately use or rename:
 *   - one 5-point rating scale
 *   - four common competencies (with proficiency levels)
 *   - a published "Standard 360 Review" questionnaire (rating + open-text)
 *
 * Idempotent and additive: if the org already has a rating scale or a template,
 * that part is skipped, so it can never overwrite a customer's own configuration.
 */
const SCALE_LEVELS = [
  { value: 1, label: 'Poor', sortOrder: 1, color: '#ef4444' },
  { value: 2, label: 'Needs Improvement', sortOrder: 2, color: '#f59e0b' },
  { value: 3, label: 'Meets Expectations', sortOrder: 3, color: '#eab308' },
  { value: 4, label: 'Very Good', sortOrder: 4, color: '#84cc16' },
  { value: 5, label: 'Excellent', sortOrder: 5, color: '#10b981' },
];

const PROFICIENCY = [
  { level: 1, name: 'Basic' },
  { level: 2, name: 'Developing' },
  { level: 3, name: 'Proficient' },
  { level: 4, name: 'Advanced' },
  { level: 5, name: 'Expert' },
];

/**
 * Ten generic competencies in three categories — enough to run a real cycle and to
 * show what a library looks like, few enough to read as curated rather than
 * exhaustive. Every one is sector-neutral on purpose.
 *
 * Technical / job knowledge is deliberately ABSENT. It is the one competency that is
 * genuinely role-specific, so a generic default would be wrong for most roles; the
 * client adds their own.
 */
const COMPETENCIES = [
  // ---- Core: expected of everyone ----
  {
    category: 'Core',
    name: 'Communication',
    description: 'Shares information clearly, listens actively and adapts the message to the audience.',
    question: 'Communicates clearly and listens to others',
  },
  {
    category: 'Core',
    name: 'Collaboration & Teamwork',
    description: 'Works effectively with others, shares credit and supports colleagues to reach shared goals.',
    question: 'Works effectively with colleagues to achieve shared goals',
  },
  {
    category: 'Core',
    name: 'Accountability & Delivery',
    description: 'Takes ownership of commitments and delivers quality work on time.',
    question: 'Takes ownership and delivers quality work on time',
  },
  {
    category: 'Core',
    name: 'Integrity & Professionalism',
    description: 'Acts honestly and consistently, respects confidentiality and treats people fairly.',
    question: 'Acts with honesty, fairness and professionalism',
  },
  {
    category: 'Core',
    name: 'Adaptability',
    description: 'Responds constructively to change, and adjusts approach when circumstances or priorities shift.',
    question: 'Responds constructively when priorities or circumstances change',
  },
  // ---- Performance: how work gets done ----
  {
    category: 'Performance',
    name: 'Problem Solving & Decision Making',
    description: 'Analyses situations, weighs options and reaches sound decisions in reasonable time.',
    question: 'Analyses problems well and makes sound, timely decisions',
  },
  {
    category: 'Performance',
    name: 'Planning & Organisation',
    description: 'Sets priorities, plans realistically and manages time and resources to meet commitments.',
    question: 'Plans and prioritises work effectively',
  },
  {
    category: 'Performance',
    name: 'Stakeholder Focus',
    description: 'Understands the needs of customers, colleagues and partners, and responds to them dependably.',
    question: 'Understands and responds to the needs of customers and colleagues',
  },
  // ---- Leadership: expected of those who lead others ----
  {
    category: 'Leadership',
    name: 'Leadership & Developing Others',
    description: 'Sets direction, gives constructive feedback and helps others grow.',
    question: 'Supports, develops and gives constructive feedback to others',
  },
  {
    category: 'Leadership',
    name: 'Innovation & Continuous Improvement',
    description: 'Looks for better ways of working and follows improvements through to a result.',
    question: 'Suggests and follows through on better ways of working',
  },
];

const OPEN_QUESTIONS = [
  'What does this person do well that they should keep doing?',
  'What is the single most useful thing this person could improve?',
];

export interface StarterContentResult {
  ratingScales: number;
  competencies: number;
  questions: number;
  templates: number;
  /** Report/feedback defaults written to `configurations` so they are visible and editable. */
  configurations: number;
  skipped: boolean;
}

/**
 * Defaults the application already falls back to in code, written out explicitly so an
 * administrator can SEE and change them on Settings → Feedback Rules. Left unwritten
 * they still work, but the screen shows nothing and the values look like magic.
 */
const DEFAULT_CONFIGS: { module: string; key: string; value: unknown }[] = [
  // Suppress an anonymous quadrant's breakdown below this many distinct reviewers.
  { module: 'reports', key: 'min_responses_to_show', value: 3 },
  // The score an organisation is aiming at; drives the readiness bands.
  { module: 'reports', key: 'target_score', value: 3.5 },
  // Shared-competency comparison thresholds (Reports → Individual).
  { module: 'reports', key: 'comparison_rules', value: { gapModerate: 0.5, gapPronounced: 1.0, comparisonMinQuadrants: 2 } },
  // Reminder cadence for outstanding reviewers.
  { module: 'reminders', key: 'enabled', value: true },
  { module: 'reminders', key: 'cadence_days', value: 3 },
];

export async function seedStarterContent(prisma: PrismaClient, organizationId: string): Promise<StarterContentResult> {
  const result: StarterContentResult = { ratingScales: 0, competencies: 0, questions: 0, templates: 0, configurations: 0, skipped: false };

  // Never overwrite an existing configuration.
  const existingTemplate = await prisma.questionnaireTemplate.findFirst({
    where: { organizationId, deletedAt: null },
    select: { id: true },
  });
  if (existingTemplate) {
    result.skipped = true;
    return result;
  }

  // ---- Rating scale (reuse one if the org already defined it) ----
  let scale = await prisma.ratingScale.findFirst({ where: { organizationId, deletedAt: null }, select: { id: true } });
  if (!scale) {
    scale = await prisma.ratingScale.create({
      data: {
        organizationId,
        name: 'Standard 5-Point',
        scaleType: '5_point',
        minValue: 1,
        maxValue: 5,
        levels: { create: SCALE_LEVELS },
      },
      select: { id: true },
    });
    result.ratingScales = 1;
  }

  // ---- Competencies (+ an active v1 version with proficiency levels) ----
  const ratingQuestionIds: string[] = [];
  for (const def of COMPETENCIES) {
    let category = await prisma.competencyCategory.findFirst({
      where: { organizationId, name: def.category, deletedAt: null },
      select: { id: true },
    });
    if (!category) {
      category = await prisma.competencyCategory.create({
        data: { organizationId, name: def.category },
        select: { id: true },
      });
    }
    const existingComp = await prisma.competency.findFirst({
      where: { organizationId, name: def.name, deletedAt: null },
      select: { id: true },
    });
    const comp =
      existingComp ??
      (await prisma.competency.create({
        data: { organizationId, categoryId: category.id, name: def.name, description: def.description },
        select: { id: true },
      }));
    if (!existingComp) {
      await prisma.competencyVersion.create({
        data: {
          organizationId,
          competencyId: comp.id,
          versionLabel: 'v1',
          status: 'active',
          proficiencyLevels: { create: PROFICIENCY.map((p) => ({ organizationId, level: p.level, name: p.name })) },
        },
      });
      result.competencies += 1;
    }
    const question = await prisma.question.create({
      data: {
        organizationId,
        text: def.question,
        type: 'rating',
        category: def.category,
        ratingScaleId: scale.id,
        competencyId: comp.id,
      },
      select: { id: true },
    });
    ratingQuestionIds.push(question.id);
    result.questions += 1;
  }

  // ---- Open-text questions (qualitative feedback) ----
  const openQuestionIds: string[] = [];
  for (const text of OPEN_QUESTIONS) {
    const q = await prisma.question.create({
      data: { organizationId, text, type: 'text', category: 'Open Feedback' },
      select: { id: true },
    });
    openQuestionIds.push(q.id);
    result.questions += 1;
  }

  // ---- Published questionnaire template ----
  const template = await prisma.questionnaireTemplate.create({
    data: {
      organizationId,
      name: 'Standard 360 Review',
      description: 'Starter review form covering core competencies and open feedback. Edit or clone to suit your organization.',
      status: 'published',
    },
    select: { id: true },
  });
  const coreSection = await prisma.templateSection.create({
    data: { templateId: template.id, title: 'Core Competencies', sortOrder: 0 },
    select: { id: true },
  });
  const openSection = await prisma.templateSection.create({
    data: { templateId: template.id, title: 'Open Feedback', sortOrder: 1 },
    select: { id: true },
  });
  await prisma.sectionQuestion.createMany({
    data: [
      ...ratingQuestionIds.map((questionId, i) => ({ sectionId: coreSection.id, questionId, sortOrder: i })),
      ...openQuestionIds.map((questionId, i) => ({ sectionId: openSection.id, questionId, sortOrder: i })),
    ],
  });
  result.templates = 1;

  /* ---- Parent / external feedback (schools and similar) ----
   *
   * Two templates, because the product collects parent feedback in two shapes and the
   * consolidated one has a hard structural requirement. Both are ordinary editable
   * templates — an organisation that does not collect parent feedback simply ignores
   * or deletes them.
   */
  const parentQ = await prisma.question.createManyAndReturn({
    data: [
      { organizationId, text: 'Communicates clearly and promptly with parents', type: 'rating', category: 'Parent Feedback', ratingScaleId: scale.id },
      { organizationId, text: 'Treats my child fairly and with respect', type: 'rating', category: 'Parent Feedback', ratingScaleId: scale.id },
      { organizationId, text: 'Helps my child learn and make progress', type: 'rating', category: 'Parent Feedback', ratingScaleId: scale.id },
      { organizationId, text: 'Is there anything else you would like to share?', type: 'text', category: 'Parent Feedback' },
    ],
    select: { id: true },
  });
  result.questions += parentQ.length;

  const parentTemplate = await prisma.questionnaireTemplate.create({
    data: {
      organizationId,
      name: 'Parent / External Feedback',
      description: 'Short, plain-language form for a parent or external stakeholder giving feedback about one person. Edit the wording to suit your setting.',
      status: 'published',
    },
    select: { id: true },
  });
  const parentSection = await prisma.templateSection.create({
    data: { templateId: parentTemplate.id, title: 'Your experience', sortOrder: 0 },
    select: { id: true },
  });
  await prisma.sectionQuestion.createMany({
    data: parentQ.map((q, i) => ({ sectionId: parentSection.id, questionId: q.id, sortOrder: i })),
  });
  result.templates += 1;

  /*
   * The consolidated form asks the SAME question about every teacher a child has, on
   * one page. The feature refuses a quadrant whose questionnaire does not hold exactly
   * one rating question, so this template deliberately contains one and only one.
   */
  const consolidatedQ = await prisma.question.create({
    data: {
      organizationId,
      text: 'Overall, how would you rate this teacher?',
      type: 'rating',
      category: 'Parent Feedback',
      ratingScaleId: scale.id,
    },
    select: { id: true },
  });
  result.questions += 1;

  const consolidatedTemplate = await prisma.questionnaireTemplate.create({
    data: {
      organizationId,
      name: 'Consolidated Parent Feedback',
      description: 'One rating per teacher on a single mobile-friendly page. Attach to a cycle\'s Parents quadrant and set its mode to Consolidated. Must contain exactly one rating question.',
      status: 'published',
    },
    select: { id: true },
  });
  const consolidatedSection = await prisma.templateSection.create({
    data: { templateId: consolidatedTemplate.id, title: 'Rate each teacher', sortOrder: 0 },
    select: { id: true },
  });
  await prisma.sectionQuestion.create({
    data: { sectionId: consolidatedSection.id, questionId: consolidatedQ.id, sortOrder: 0 },
  });
  result.templates += 1;

  /* ---- Report and feedback defaults, written so they are visible in Settings ---- */
  for (const c of DEFAULT_CONFIGS) {
    const exists = await prisma.configuration.findFirst({
      where: { organizationId, module: c.module, key: c.key, deletedAt: null },
      select: { id: true },
    });
    if (exists) continue;
    await prisma.configuration.create({
      data: { organizationId, module: c.module, key: c.key, value: c.value as object },
    });
    result.configurations += 1;
  }

  return result;
}
