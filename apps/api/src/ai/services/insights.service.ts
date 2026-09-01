import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AiProviderService } from './ai-provider.service';

const DEFAULT_TARGET = 4;
const ALIGN_THRESHOLD = 0.5; // |self − others| below this is "aligned"

/** Positive / negative lexicons for the lightweight comment-sentiment pass.
 *  Deterministic and offline; the LLM provider (when configured) refines the
 *  narrative summary, not these counts. */
const POSITIVE = [
  'excellent', 'great', 'good', 'strong', 'outstanding', 'helpful', 'reliable', 'positive',
  'improved', 'improving', 'proactive', 'collaborative', 'dedicated', 'skilled', 'consistent',
  'supportive', 'effective', 'impressive', 'exceeds', 'above', 'goes above', 'willing', 'excels',
];
const NEGATIVE = [
  'poor', 'weak', 'lacks', 'lacking', 'concern', 'concerns', 'issue', 'issues', 'problem', 'delay',
  'delayed', 'missed', 'inconsistent', 'struggle', 'struggles', 'difficult', 'unreliable', 'below',
  'improve', 'improvement', 'needs', 'slow', 'disengaged', 'negative', 'unclear', 'conflict',
];

export type BlindSpotType = 'blind_spot' | 'hidden_strength' | 'aligned' | 'self_only' | 'no_self';

export interface BlindSpot {
  competency: string;
  selfScore: number | null;
  othersScore: number | null;
  delta: number | null; // self − others
  type: BlindSpotType;
}

export interface Recommendation {
  competency: string;
  priority: 'high' | 'medium' | 'low';
  action: string;
}

export interface Sentiment {
  positive: number;
  neutral: number;
  negative: number;
  score: number; // −1 … +1
  samples: { text: string; sentiment: 'positive' | 'neutral' | 'negative' }[];
}

export interface ReadinessFactor {
  label: string;
  detail: string;
  value: number; // 0 … 100
}

/** AI Insights (Phase 12): blind spots, recommendations, narrative summary,
 *  promotion readiness + comment sentiment. Reads existing appraisal feedback;
 *  no new tables. Heuristic by default, LLM-enhanced when a provider is set. */
@Injectable()
export class InsightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: AiProviderService,
  ) {}

  private cycleFilter(cycleId?: string): Prisma.Sql {
    return cycleId ? Prisma.sql`AND ap.cycle_id = ${cycleId}::uuid` : Prisma.empty;
  }

  // ---------------------------------------------------------------- individual

  async individual(orgId: string, employeeId: string, cycleId?: string): Promise<Record<string, unknown>> {
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, organizationId: orgId, deletedAt: null },
      include: {
        user: { select: { fullName: true, email: true } },
        designation: { select: { name: true } },
        department: { select: { name: true } },
      },
    });
    if (!employee) throw new NotFoundException('Employee not found.');
    const name = employee.user.fullName ?? employee.user.email;

    const target = await this.targetScore(orgId);
    const blindSpots = await this.blindSpots(orgId, employeeId, cycleId);
    const comments = await this.comments(orgId, employeeId, cycleId);
    const sourceCount = await this.sourceCount(orgId, employeeId, cycleId);
    // Verbatim excerpts respect the org's anonymity threshold (F-C8).
    const minResponses = await this.minResponsesToShow(orgId);

    const withOthers = blindSpots.filter((b) => b.othersScore !== null);
    const overall =
      withOthers.length > 0
        ? Math.round((withOthers.reduce((s, b) => s + (b.othersScore ?? 0), 0) / withOthers.length) * 100) / 100
        : null;

    const strengths = [...withOthers].sort((a, b) => (b.othersScore ?? 0) - (a.othersScore ?? 0)).slice(0, 3);
    const weaknesses = [...withOthers].sort((a, b) => (a.othersScore ?? 0) - (b.othersScore ?? 0)).slice(0, 3);
    const sentiment = this.analyzeSentiment(comments, minResponses);
    const recommendations = this.buildRecommendations(blindSpots, target);
    const readiness = this.promotionReadiness(overall, blindSpots, sourceCount, target);

    const heuristicSummary = this.heuristicSummary(name, overall, strengths, weaknesses, blindSpots, readiness, sentiment);
    const aiSummary = await this.aiSummary(orgId, name, {
      overall,
      target,
      blindSpots,
      recommendations,
      readiness,
      sentiment,
    });

    return {
      employee: {
        id: employee.id,
        name,
        designation: employee.designation?.name ?? null,
        department: employee.department?.name ?? null,
      },
      overallScore: overall,
      target,
      hasData: blindSpots.length > 0,
      blindSpots,
      strengths,
      weaknesses,
      recommendations,
      promotionReadiness: readiness,
      sentiment,
      summary: aiSummary ?? heuristicSummary,
      generatedBy: aiSummary ? 'ai' : 'heuristic',
    };
  }

  // --------------------------------------------------------------------- overview

  async overview(orgId: string, cycleId?: string): Promise<Record<string, unknown>> {
    const target = await this.targetScore(orgId);
    const cf = this.cycleFilter(cycleId);

    const scored = await this.prisma.$queryRaw<
      { id: string; name: string; department: string; score: number }[]
    >(Prisma.sql`
      SELECT e.id AS id, COALESCE(u.full_name, u.email) AS name,
             COALESCE(d.name, 'Unassigned') AS department, ap.final_score::float AS score
      FROM appraisal_participants ap
      JOIN appraisal_cycles c ON c.id = ap.cycle_id
      JOIN employees e ON e.id = ap.employee_id
      JOIN users u ON u.id = e.user_id
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE c.organization_id = ${orgId}::uuid AND c.deleted_at IS NULL
        AND ap.final_score IS NOT NULL ${cf}
      ORDER BY ap.final_score ASC`);

    const ready = scored.filter((s) => s.score >= target).length;
    const developing = scored.filter((s) => s.score >= target - 1 && s.score < target).length;
    const notYet = scored.filter((s) => s.score < target - 1).length;

    const atRisk = scored
      .filter((s) => s.score < target - 1)
      .slice(0, 8)
      .map((s) => ({
        employeeId: s.id,
        name: s.name,
        department: s.department,
        score: Math.round(s.score * 100) / 100,
        risk: Math.min(99, Math.round(((target - s.score) / target) * 100)),
        driver: this.riskDriver(s.score, target),
      }));

    const orgComments = await this.orgComments(orgId, cycleId);
    const sentiment = this.analyzeSentiment(orgComments);

    const gapRows = await this.prisma.$queryRaw<{ competency: string; score: number }[]>(Prisma.sql`
      SELECT cmp.name AS competency, round(avg(fr.rating_value), 2)::float AS score
      FROM feedback_responses fr
      JOIN reviewer_assignments ra ON ra.id = fr.assignment_id
      JOIN appraisal_participants ap ON ap.id = ra.participant_id
      JOIN questions q ON q.id = fr.question_id
      JOIN competencies cmp ON cmp.id = q.competency_id
      JOIN feedback_sources fs ON fs.id = ra.source_id
      WHERE ra.organization_id = ${orgId}::uuid AND ra.status = 'submitted'
        AND fs.code <> 'self' AND fr.rating_value IS NOT NULL ${cf}
      GROUP BY cmp.name`);

    const topGaps = gapRows
      .map((r) => ({ competency: r.competency, score: r.score, gap: Math.round((target - r.score) * 100) / 100 }))
      .filter((r) => r.gap > 0)
      .sort((a, b) => b.gap - a.gap)
      .slice(0, 5);

    return {
      target,
      appraised: scored.length,
      readiness: { ready, developing, notYet },
      atRisk,
      topGaps,
      sentiment,
    };
  }

  // ----------------------------------------------------------------- provider status

  async providerStatus(orgId: string): Promise<Record<string, unknown>> {
    const config = await this.provider.getConfig(orgId);
    return { configured: config !== null, model: config?.model ?? null };
  }

  // ------------------------------------------------------------------ data access

  private async blindSpots(orgId: string, employeeId: string, cycleId?: string): Promise<BlindSpot[]> {
    const cf = this.cycleFilter(cycleId);
    const rows = await this.prisma.$queryRaw<
      { competency: string; self_score: number | null; others_score: number | null }[]
    >(Prisma.sql`
      SELECT cmp.name AS competency,
             round(avg(fr.rating_value) FILTER (WHERE fs.code = 'self'), 2)::float AS self_score,
             round(avg(fr.rating_value) FILTER (WHERE fs.code <> 'self'), 2)::float AS others_score
      FROM feedback_responses fr
      JOIN reviewer_assignments ra ON ra.id = fr.assignment_id
      JOIN appraisal_participants ap ON ap.id = ra.participant_id
      JOIN feedback_sources fs ON fs.id = ra.source_id
      JOIN questions q ON q.id = fr.question_id
      JOIN competencies cmp ON cmp.id = q.competency_id
      WHERE ra.organization_id = ${orgId}::uuid AND ap.employee_id = ${employeeId}::uuid
        AND ra.status = 'submitted' AND fr.rating_value IS NOT NULL ${cf}
      GROUP BY cmp.name ORDER BY cmp.name`);

    return rows.map((r) => {
      const self = r.self_score;
      const others = r.others_score;
      let type: BlindSpotType;
      let delta: number | null = null;
      if (self !== null && others !== null) {
        delta = Math.round((self - others) * 100) / 100;
        if (delta >= ALIGN_THRESHOLD) type = 'blind_spot';
        else if (delta <= -ALIGN_THRESHOLD) type = 'hidden_strength';
        else type = 'aligned';
      } else if (self !== null) {
        type = 'self_only';
      } else {
        type = 'no_self';
      }
      return { competency: r.competency, selfScore: self, othersScore: others, delta, type };
    });
  }

  private async comments(orgId: string, employeeId: string, cycleId?: string): Promise<string[]> {
    const cf = this.cycleFilter(cycleId);
    const rows = await this.prisma.$queryRaw<{ text: string }[]>(Prisma.sql`
      SELECT fr.text_value AS text
      FROM feedback_responses fr
      JOIN reviewer_assignments ra ON ra.id = fr.assignment_id
      JOIN appraisal_participants ap ON ap.id = ra.participant_id
      JOIN feedback_sources fs ON fs.id = ra.source_id
      WHERE ra.organization_id = ${orgId}::uuid AND ap.employee_id = ${employeeId}::uuid
        AND ra.status = 'submitted' AND fs.code <> 'self'
        AND fr.text_value IS NOT NULL AND length(trim(fr.text_value)) > 0 ${cf}`);
    return rows.map((r) => r.text);
  }

  private async orgComments(orgId: string, cycleId?: string): Promise<string[]> {
    const cf = this.cycleFilter(cycleId);
    const rows = await this.prisma.$queryRaw<{ text: string }[]>(Prisma.sql`
      SELECT fr.text_value AS text
      FROM feedback_responses fr
      JOIN reviewer_assignments ra ON ra.id = fr.assignment_id
      JOIN appraisal_participants ap ON ap.id = ra.participant_id
      JOIN feedback_sources fs ON fs.id = ra.source_id
      WHERE ra.organization_id = ${orgId}::uuid AND ra.status = 'submitted'
        AND fs.code <> 'self' AND fr.text_value IS NOT NULL
        AND length(trim(fr.text_value)) > 0 ${cf}`);
    return rows.map((r) => r.text);
  }

  private async sourceCount(orgId: string, employeeId: string, cycleId?: string): Promise<number> {
    const cf = this.cycleFilter(cycleId);
    const [row] = await this.prisma.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT count(DISTINCT fs.code)::int AS n
      FROM reviewer_assignments ra
      JOIN appraisal_participants ap ON ap.id = ra.participant_id
      JOIN feedback_sources fs ON fs.id = ra.source_id
      WHERE ra.organization_id = ${orgId}::uuid AND ap.employee_id = ${employeeId}::uuid
        AND ra.status = 'submitted' ${cf}`);
    return row?.n ?? 0;
  }

  private async targetScore(orgId: string): Promise<number> {
    const row = await this.prisma.configuration.findFirst({
      where: { organizationId: orgId, module: 'reports', key: 'target_score', deletedAt: null },
      select: { value: true },
    });
    const value = row?.value;
    return typeof value === 'number' ? value : DEFAULT_TARGET;
  }

  /** Org anonymity threshold — same config key the reports use (F-C4/F-C8). */
  private async minResponsesToShow(orgId: string): Promise<number> {
    const row = await this.prisma.configuration.findFirst({
      where: { organizationId: orgId, module: 'reports', key: 'min_responses_to_show', deletedAt: null },
      select: { value: true },
    });
    const value = row?.value;
    return typeof value === 'number' && value >= 1 ? value : 3;
  }

  // -------------------------------------------------------------------- heuristics

  /**
   * @param minCommentsForSamples verbatim excerpts are only included once at least
   * this many comments exist (F-C8). Below the anonymity threshold a "sample" is
   * effectively one identifiable reviewer's words quoted back, which defeats rater
   * confidentiality. Aggregate counts are always returned.
   */
  private analyzeSentiment(comments: string[], minCommentsForSamples = 0): Sentiment {
    let positive = 0;
    let neutral = 0;
    let negative = 0;
    const allowSamples = comments.length >= minCommentsForSamples;
    const samples: Sentiment['samples'] = [];
    for (const raw of comments) {
      const text = raw.toLowerCase();
      const pos = POSITIVE.reduce((n, w) => (text.includes(w) ? n + 1 : n), 0);
      const neg = NEGATIVE.reduce((n, w) => (text.includes(w) ? n + 1 : n), 0);
      let label: 'positive' | 'neutral' | 'negative';
      if (pos > neg) {
        positive++;
        label = 'positive';
      } else if (neg > pos) {
        negative++;
        label = 'negative';
      } else {
        neutral++;
        label = 'neutral';
      }
      if (allowSamples && samples.length < 4) samples.push({ text: raw.length > 160 ? `${raw.slice(0, 157)}…` : raw, sentiment: label });
    }
    const total = positive + neutral + negative;
    const score = total ? Math.round(((positive - negative) / total) * 100) / 100 : 0;
    return { positive, neutral, negative, score, samples };
  }

  private buildRecommendations(blindSpots: BlindSpot[], target: number): Recommendation[] {
    const recs: Recommendation[] = [];

    // 1) Competency gaps vs target (based on how others rate the employee).
    const gaps = blindSpots
      .filter((b) => b.othersScore !== null && b.othersScore < target)
      .map((b) => ({ competency: b.competency, gap: Math.round((target - (b.othersScore ?? 0)) * 100) / 100 }))
      .sort((a, b) => b.gap - a.gap);
    for (const g of gaps) {
      recs.push({
        competency: g.competency,
        priority: g.gap >= 1 ? 'high' : g.gap >= 0.5 ? 'medium' : 'low',
        action: `Prioritise development in ${g.competency} — currently ${g.gap} below the target of ${target}. Assign focused training and a stretch goal, then re-measure next cycle.`,
      });
    }

    // 2) Self-awareness gaps (largest overrating blind spots).
    const overrated = blindSpots
      .filter((b) => b.type === 'blind_spot' && b.delta !== null)
      .sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0));
    for (const b of overrated.slice(0, 2)) {
      recs.push({
        competency: b.competency,
        priority: (b.delta ?? 0) >= 1 ? 'high' : 'medium',
        action: `Close the self-awareness gap in ${b.competency}: self-rating is ${b.delta} higher than how others rate it. Share anonymised peer feedback and coach on concrete examples.`,
      });
    }

    // De-duplicate by competency, keep the highest priority, cap at 5.
    const order = { high: 0, medium: 1, low: 2 } as const;
    const byComp = new Map<string, Recommendation>();
    for (const r of recs) {
      const existing = byComp.get(r.competency);
      if (!existing || order[r.priority] < order[existing.priority]) byComp.set(r.competency, r);
    }
    return [...byComp.values()].sort((a, b) => order[a.priority] - order[b.priority]).slice(0, 5);
  }

  private promotionReadiness(
    overall: number | null,
    blindSpots: BlindSpot[],
    sourceCount: number,
    target: number,
  ): { score: number; band: 'Ready' | 'Developing' | 'Not yet'; factors: ReadinessFactor[] } {
    // Performance (0–55): how others rate the employee relative to a 5-point scale.
    const performancePct = overall !== null ? Math.max(0, Math.min(1, overall / 5)) : 0;
    const performance = performancePct * 55;

    // Self-awareness (0–20): smaller average self↔others divergence is better.
    const deltas = blindSpots.filter((b) => b.delta !== null).map((b) => Math.abs(b.delta as number));
    const avgDelta = deltas.length ? deltas.reduce((s, d) => s + d, 0) / deltas.length : 1;
    const selfAwarenessPct = Math.max(0, 1 - Math.min(avgDelta / 2, 1));
    const selfAwareness = selfAwarenessPct * 20;

    // Feedback coverage (0–15): breadth of distinct feedback sources (target ≥3).
    const coveragePct = Math.min(sourceCount / 3, 1);
    const coverage = coveragePct * 15;

    // Consistency (0–10): low spread across competencies (others' view).
    const others = blindSpots.filter((b) => b.othersScore !== null).map((b) => b.othersScore as number);
    const consistencyPct = others.length > 1 ? Math.max(0, 1 - Math.min(this.stdev(others) / 1.5, 1)) : others.length ? 1 : 0;
    const consistency = consistencyPct * 10;

    const score = Math.max(0, Math.min(100, Math.round(performance + selfAwareness + coverage + consistency)));
    const band = score >= 75 ? 'Ready' : score >= 55 ? 'Developing' : 'Not yet';

    return {
      score,
      band,
      factors: [
        { label: 'Performance', detail: overall !== null ? `Avg ${overall} vs target ${target}` : 'No scored feedback', value: Math.round(performancePct * 100) },
        { label: 'Self-awareness', detail: `Avg self↔others gap ${Math.round(avgDelta * 100) / 100}`, value: Math.round(selfAwarenessPct * 100) },
        { label: 'Feedback coverage', detail: `${sourceCount} source${sourceCount === 1 ? '' : 's'} of 3`, value: Math.round(coveragePct * 100) },
        { label: 'Consistency', detail: others.length > 1 ? 'Spread across competencies' : 'Insufficient data', value: Math.round(consistencyPct * 100) },
      ],
    };
  }

  private riskDriver(score: number, target: number): string {
    const gap = Math.round((target - score) * 100) / 100;
    if (score < target - 2) return `Overall score ${score} is well below target (${target}) — gap of ${gap}.`;
    return `Overall score ${score} is below target (${target}) by ${gap}; monitor and support.`;
  }

  private heuristicSummary(
    name: string,
    overall: number | null,
    strengths: BlindSpot[],
    weaknesses: BlindSpot[],
    blindSpots: BlindSpot[],
    readiness: { score: number; band: string },
    sentiment: Sentiment,
  ): string {
    if (overall === null) {
      return `${name} has no scored 360° feedback yet for this cycle, so AI insights are unavailable. Once reviewers submit their assessments, blind-spot, readiness and recommendation analysis will appear here.`;
    }
    const parts: string[] = [];
    parts.push(`${name} has an overall 360° score of ${overall} across ${blindSpots.length} competencies.`);
    if (strengths[0]) parts.push(`The strongest area is ${strengths[0].competency} (${strengths[0].othersScore}).`);
    if (weaknesses[0] && weaknesses[0].competency !== strengths[0]?.competency) {
      parts.push(`The main development area is ${weaknesses[0].competency} (${weaknesses[0].othersScore}).`);
    }
    const topBlind = blindSpots
      .filter((b) => b.type === 'blind_spot')
      .sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0))[0];
    const hidden = blindSpots
      .filter((b) => b.type === 'hidden_strength')
      .sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0))[0];
    if (topBlind) parts.push(`A notable blind spot is ${topBlind.competency}, where the self-rating exceeds others' by ${topBlind.delta}.`);
    if (hidden) parts.push(`Conversely, ${hidden.competency} is a hidden strength — others rate it ${Math.abs(hidden.delta ?? 0)} above the self-assessment.`);
    const total = sentiment.positive + sentiment.neutral + sentiment.negative;
    if (total > 0) {
      parts.push(`Written feedback skews ${sentiment.score > 0.15 ? 'positive' : sentiment.score < -0.15 ? 'negative' : 'neutral'} (${sentiment.positive} positive / ${sentiment.negative} negative of ${total} comments).`);
    }
    parts.push(`Promotion readiness is assessed at ${readiness.score}/100 — "${readiness.band}".`);
    return parts.join(' ');
  }

  /** Ask the configured LLM to write the narrative summary from the computed
   *  facts. Returns null when no provider is set or the call fails. */
  private async aiSummary(
    orgId: string,
    name: string,
    data: {
      overall: number | null;
      target: number;
      blindSpots: BlindSpot[];
      recommendations: Recommendation[];
      readiness: { score: number; band: string };
      sentiment: Sentiment;
    },
  ): Promise<string | null> {
    if (data.overall === null) return null;
    const system =
      'You are an HR analytics assistant. Write a concise, professional 360° feedback summary (4–6 sentences) for a manager. Use ONLY the JSON facts provided — never invent numbers. Be balanced and constructive. Return plain prose, no headings or markdown.';
    const user = JSON.stringify({
      employee: name,
      overallScore: data.overall,
      targetScore: data.target,
      blindSpots: data.blindSpots,
      recommendations: data.recommendations,
      promotionReadiness: data.readiness,
      sentiment: { positive: data.sentiment.positive, neutral: data.sentiment.neutral, negative: data.sentiment.negative, score: data.sentiment.score },
    });
    return this.provider.complete(orgId, system, user);
  }

  private stdev(values: number[]): number {
    if (values.length < 2) return 0;
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
  }
}
