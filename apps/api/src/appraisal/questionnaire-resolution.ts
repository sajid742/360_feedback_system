import type { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../common/prisma/prisma.service';

type Db = PrismaService | PrismaClient;

/**
 * Which questionnaire a given quadrant uses, and which competencies each quadrant of a
 * cycle therefore assesses.
 *
 * A cycle has always carried ONE questionnaire (`appraisal_cycles.template_id`) shared by
 * every quadrant. A quadrant may now carry its own (`feedback_sources.template_id`), so
 * different evaluator groups can be asked different questions. The rule is deliberately
 * simple and is applied everywhere a form is built or analysed:
 *
 *     quadrant template if set  ->  else the cycle template  ->  else nothing
 *
 * A NULL quadrant template is therefore the pre-existing behaviour, unchanged.
 *
 * Competencies stay in the single global library. A competency assessed by two or more
 * quadrants is comparable across them — that is derived from the questionnaires actually
 * attached, never from a stored "shared" flag, so the configuration cannot drift out of
 * step with the questions people are really answering.
 *
 * Plain functions rather than an injectable service: the appraisal, external-evaluation
 * and reports modules all need this, and none of them should have to import each other.
 */

/** The template a reviewer in this quadrant answers. NULL when neither level defines one. */
export async function resolveTemplateId(db: Db, cycleId: string, sourceId: string | null): Promise<string | null> {
  const [cycle, source] = await Promise.all([
    db.appraisalCycle.findUnique({ where: { id: cycleId }, select: { templateId: true } }),
    sourceId
      ? db.feedbackSource.findUnique({ where: { id: sourceId }, select: { templateId: true } })
      : Promise.resolve(null),
  ]);
  return source?.templateId ?? cycle?.templateId ?? null;
}

/** Question ids belonging to a template — the allow-list for a submission. */
export async function templateQuestionIds(db: Db, templateId: string): Promise<Set<string>> {
  const rows = await db.sectionQuestion.findMany({
    where: { section: { templateId } },
    select: { questionId: true },
  });
  return new Set(rows.map((r) => r.questionId));
}

export interface QuadrantCoverage {
  sourceId: string;
  code: string;
  label: string;
  weight: number;
  /** The template this quadrant actually uses after the fallback rule is applied. */
  effectiveTemplateId: string | null;
  effectiveTemplateName: string | null;
  /** True when the quadrant defines its own questionnaire rather than inheriting the cycle's. */
  ownTemplate: boolean;
  questionCount: number;
  /** Competency ids this quadrant assesses, from the questions in its effective template. */
  competencyIds: string[];
}

export interface CompetencyCoverage {
  competencyId: string;
  competency: string;
  /** Quadrant codes whose questionnaire contains at least one question for this competency. */
  quadrants: string[];
  questionCountByQuadrant: Record<string, number>;
  /** Derived, never stored: assessed by two or more quadrants, so comparable across them. */
  shared: boolean;
}

export interface CycleCoverage {
  cycleId: string;
  cycleTemplateId: string | null;
  cycleTemplateName: string | null;
  /** True when at least one quadrant overrides the cycle questionnaire. */
  mixedQuestionnaires: boolean;
  quadrants: QuadrantCoverage[];
  competencies: CompetencyCoverage[];
  /** Questions in one or more questionnaires that carry no competency. */
  questionsWithoutCompetency: number;
}

/**
 * The competency × quadrant coverage matrix for a cycle, built from CONFIGURATION —
 * the questionnaires attached to each quadrant — not from the responses collected so far.
 *
 * That distinction is what lets a report tell "this quadrant was never asked about this
 * competency" (a blank cell, by design) apart from "this quadrant was asked but too few
 * people answered to show it" (withheld by the anonymity threshold). Before this existed,
 * both looked identical.
 */
export async function cycleCoverage(db: Db, cycleId: string): Promise<CycleCoverage> {
  const cycle = await db.appraisalCycle.findUniqueOrThrow({
    where: { id: cycleId },
    select: { id: true, templateId: true },
  });
  const sources = await db.feedbackSource.findMany({
    where: { cycleId },
    select: { id: true, code: true, label: true, weight: true, templateId: true },
    orderBy: { code: 'asc' },
  });

  const templateIds = [
    ...new Set([cycle.templateId, ...sources.map((s) => s.templateId)].filter((t): t is string => Boolean(t))),
  ];
  const templates = templateIds.length
    ? await db.questionnaireTemplate.findMany({ where: { id: { in: templateIds } }, select: { id: true, name: true } })
    : [];
  const templateName = new Map(templates.map((t) => [t.id, t.name]));

  // Questions per template, with the competency each one measures (may be null).
  const rows = templateIds.length
    ? await db.sectionQuestion.findMany({
        where: { section: { templateId: { in: templateIds } } },
        select: {
          section: { select: { templateId: true } },
          question: { select: { id: true, competencyId: true, competency: { select: { id: true, name: true } } } },
        },
      })
    : [];

  const byTemplate = new Map<string, { questionIds: Set<string>; competencies: Map<string, string>; counts: Map<string, number>; noCompetency: number }>();
  for (const t of templateIds) byTemplate.set(t, { questionIds: new Set(), competencies: new Map(), counts: new Map(), noCompetency: 0 });
  for (const r of rows) {
    const bucket = byTemplate.get(r.section.templateId);
    if (!bucket) continue;
    bucket.questionIds.add(r.question.id);
    if (r.question.competency) {
      bucket.competencies.set(r.question.competency.id, r.question.competency.name);
      bucket.counts.set(r.question.competency.id, (bucket.counts.get(r.question.competency.id) ?? 0) + 1);
    } else {
      bucket.noCompetency += 1;
    }
  }

  const quadrants: QuadrantCoverage[] = sources.map((s) => {
    const effective = s.templateId ?? cycle.templateId ?? null;
    const bucket = effective ? byTemplate.get(effective) : undefined;
    return {
      sourceId: s.id,
      code: s.code,
      label: s.label,
      weight: Number(s.weight),
      effectiveTemplateId: effective,
      effectiveTemplateName: effective ? templateName.get(effective) ?? null : null,
      ownTemplate: Boolean(s.templateId),
      questionCount: bucket?.questionIds.size ?? 0,
      competencyIds: [...(bucket?.competencies.keys() ?? [])],
    };
  });

  const names = new Map<string, string>();
  const byCompetency = new Map<string, { quadrants: string[]; counts: Record<string, number> }>();
  for (const q of quadrants) {
    const bucket = q.effectiveTemplateId ? byTemplate.get(q.effectiveTemplateId) : undefined;
    if (!bucket) continue;
    for (const [id, name] of bucket.competencies) {
      names.set(id, name);
      const entry = byCompetency.get(id) ?? { quadrants: [], counts: {} };
      entry.quadrants.push(q.code);
      entry.counts[q.code] = bucket.counts.get(id) ?? 0;
      byCompetency.set(id, entry);
    }
  }

  const competencies: CompetencyCoverage[] = [...byCompetency.entries()]
    .map(([competencyId, entry]) => ({
      competencyId,
      competency: names.get(competencyId) ?? 'Unknown',
      quadrants: entry.quadrants,
      questionCountByQuadrant: entry.counts,
      shared: entry.quadrants.length >= 2,
    }))
    .sort((a, b) => b.quadrants.length - a.quadrants.length || a.competency.localeCompare(b.competency));

  // Count questions without a competency once per distinct effective template — those
  // answers still count toward the quadrant score but appear in no competency view.
  const effectiveTemplates = [...new Set(quadrants.map((q) => q.effectiveTemplateId).filter((t): t is string => Boolean(t)))];
  const questionsWithoutCompetency = effectiveTemplates.reduce((sum, t) => sum + (byTemplate.get(t)?.noCompetency ?? 0), 0);

  return {
    cycleId: cycle.id,
    cycleTemplateId: cycle.templateId,
    cycleTemplateName: cycle.templateId ? templateName.get(cycle.templateId) ?? null : null,
    mixedQuestionnaires: quadrants.some((q) => q.ownTemplate),
    quadrants,
    competencies,
    questionsWithoutCompetency,
  };
}

/**
 * Competency → quadrant codes that assess it, across every cycle in scope. Used by the
 * individual report, which may span cycles when no cycle filter is applied, to mark a
 * blank cell "not assessed" rather than "withheld".
 */
export async function coverageForCycles(db: Db, cycleIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const cycleId of cycleIds) {
    const coverage = await cycleCoverage(db, cycleId);
    for (const c of coverage.competencies) {
      const set = out.get(c.competency) ?? new Set<string>();
      // Keyed by quadrant LABEL: that is what the report payloads use as the series name.
      for (const code of c.quadrants) {
        const q = coverage.quadrants.find((x) => x.code === code);
        if (q) set.add(q.label);
      }
      out.set(c.competency, set);
    }
  }
  return out;
}
