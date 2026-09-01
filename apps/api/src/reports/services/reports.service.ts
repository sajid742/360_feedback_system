import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/auth/current-user';
import { REPORTS_PERMISSIONS } from '../reports.permissions';
import { coverageForCycles } from '../../appraisal/questionnaire-resolution';

const DEFAULT_TARGET = 4;
const DEFAULT_MIN_RESPONSES = 3;

/**
 * Shared-competency comparison thresholds, on the rating scale's own units.
 *
 * These reuse the magnitudes already applied by the gap-vs-target report and the
 * self-vs-others panel (0.5 moderate / 1.0 pronounced), so no two parts of the product
 * call the same difference by different names. All five are admin-editable through the
 * existing Feedback Rules settings, stored in the same `configurations` rows.
 *
 * On a 5-point scale with a handful of raters per quadrant, differences below ~0.5 are
 * noise, which is why the default for a "moderate" gap sits there.
 */
const DEFAULT_GAP_MODERATE = 0.5;
const DEFAULT_GAP_PRONOUNCED = 1.0;
const DEFAULT_CONSENSUS_SD_LOW = 0.3;
const DEFAULT_CONSENSUS_SD_HIGH = 0.75;
const DEFAULT_COMPARISON_MIN_QUADRANTS = 2;

/** Who may see org-wide aggregate reports (F15). Default preserves prior behaviour. */
export type AggregateVisibility = 'all_report_viewers' | 'executives_only';
const DEFAULT_AGGREGATE_VISIBILITY: AggregateVisibility = 'all_report_viewers';

/** Read-only analytics over appraisal data. Everything is tenant-scoped and
 *  (optionally) cycle-scoped. Aggregations use raw SQL for multi-join efficiency. */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private cycleFilter(cycleId?: string): Prisma.Sql {
    return cycleId ? Prisma.sql`AND ap.cycle_id = ${cycleId}::uuid` : Prisma.empty;
  }

  /**
   * Confidentiality guard: minimum distinct reviewers before a rater-source
   * breakdown is shown, so individuals can't be identified. Configurable
   * (reports/min_responses_to_show, default 3). The 'self' source is exempt —
   * it is the employee's own rating and is never confidential.
   */
  private async minResponses(orgId: string): Promise<number> {
    const row = await this.prisma.configuration.findFirst({
      where: { organizationId: orgId, module: 'reports', key: 'min_responses_to_show', deletedAt: null },
      select: { value: true },
    });
    const value = row?.value;
    return typeof value === 'number' && value >= 1 ? value : DEFAULT_MIN_RESPONSES;
  }

  /** Distinct-reviewer counts per feedback source for one appraisee. */
  private async sourceCounts(
    orgId: string,
    employeeId: string,
    cycleId?: string,
  ): Promise<Map<string, { code: string; reviewers: number; anonymous: boolean }>> {
    const cf = this.cycleFilter(cycleId);
    // `is_anonymous` is carried because it now decides whether the small-sample
    // threshold applies at all — see `suppressed()`.
    const rows = await this.prisma.$queryRaw<{ source: string; code: string; reviewers: number; anonymous: boolean }[]>(Prisma.sql`
      SELECT fs.label AS source, fs.code AS code,
             bool_or(fs.is_anonymous) AS anonymous,
             count(DISTINCT COALESCE(ra.reviewer_employee_id::text, ra.id::text))::int AS reviewers
      FROM reviewer_assignments ra
      JOIN appraisal_participants ap ON ap.id = ra.participant_id
      JOIN feedback_sources fs ON fs.id = ra.source_id
      WHERE ra.organization_id = ${orgId}::uuid AND ap.employee_id = ${employeeId}::uuid
        AND ra.status = 'submitted' ${cf}
      GROUP BY fs.label, fs.code`);
    return new Map(rows.map((r) => [r.source, { code: r.code, reviewers: r.reviewers, anonymous: r.anonymous }]));
  }

  /**
   * Whether the small-sample threshold applies to EVERY quadrant, or only to the
   * ones actually collected anonymously. Default `false` = anonymous quadrants only.
   * Set `reports/suppress_all_sources` to true to restore the previous behaviour.
   */
  private async suppressAllSources(orgId: string): Promise<boolean> {
    const row = await this.prisma.configuration.findFirst({
      where: { organizationId: orgId, module: 'reports', key: 'suppress_all_sources', deletedAt: null },
      select: { value: true },
    });
    return row?.value === true;
  }

  /**
   * True when a source's breakdown must be hidden (non-self and below the threshold).
   *
   * `unlocked` is set for callers holding `reports.confidential.view` (HR/Admin, and
   * a Manager within their own reporting line). The threshold exists so the APPRAISEE
   * cannot infer who said what; it was never meant to blind the people who run the
   * programme. Nothing else changes: the counts, the scores, the stored data and what
   * every other caller sees are identical, and no reviewer identity is returned here
   * in either case.
   */
  private suppressed(
    counts: Map<string, { code: string; reviewers: number; anonymous: boolean }>,
    source: string,
    min: number,
    unlocked = false,
    suppressAll = false,
  ): boolean {
    const c = counts.get(source);
    if (!c) return false;
    if (unlocked) return false;
    if (c.code === 'self') return false;
    // The threshold exists so an ANONYMOUS rater cannot be identified from a small
    // sample. A quadrant configured as attributed (is_anonymous = false) makes no
    // such promise — a Line Manager quadrant has exactly one reviewer by definition
    // and the appraisee already knows who it is, so hiding the score protected
    // nobody and simply lost data. That mattered little with one manager quadrant;
    // with several manager levels it would have hidden all of them. Organisations
    // that want the old blanket behaviour set reports/suppress_all_sources = true.
    if (!suppressAll && !c.anonymous) return false;
    return c.reviewers < min;
  }

  async institutional(orgId: string, cycleId?: string): Promise<Record<string, unknown>> {
    const cf = this.cycleFilter(cycleId);
    const [summary] = await this.prisma.$queryRaw<
      { total: number; started: number; completed: number; avg_score: number | null }[]
    >(Prisma.sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE ap.status <> 'pending')::int AS started,
             count(ap.final_score)::int AS completed,
             round(avg(ap.final_score), 2)::float AS avg_score
      FROM appraisal_participants ap
      JOIN appraisal_cycles c ON c.id = ap.cycle_id
      WHERE c.organization_id = ${orgId}::uuid AND c.deleted_at IS NULL ${cf}`);

    const [dist] = await this.prisma.$queryRaw<{ b1: number; b2: number; b3: number; b4: number }[]>(Prisma.sql`
      SELECT count(*) FILTER (WHERE ap.final_score < 2)::int AS b1,
             count(*) FILTER (WHERE ap.final_score >= 2 AND ap.final_score < 3)::int AS b2,
             count(*) FILTER (WHERE ap.final_score >= 3 AND ap.final_score < 4)::int AS b3,
             count(*) FILTER (WHERE ap.final_score >= 4)::int AS b4
      FROM appraisal_participants ap JOIN appraisal_cycles c ON c.id = ap.cycle_id
      WHERE c.organization_id = ${orgId}::uuid AND ap.final_score IS NOT NULL ${cf}`);

    // Performance (F-P4): this used to select EVERY scored participant ordered by
    // score and then `.slice(0,5)` / `.slice(-5)` in JavaScript — thousands of rows
    // fetched and sorted to display ten names. Two small LIMIT queries return exactly
    // what is rendered.
    const [topPerformers, bottomPerformers] = await Promise.all([
      this.prisma.$queryRaw<{ name: string; score: number }[]>(Prisma.sql`
        SELECT COALESCE(u.full_name, u.email) AS name, ap.final_score::float AS score
        FROM appraisal_participants ap JOIN appraisal_cycles c ON c.id = ap.cycle_id
        JOIN employees e ON e.id = ap.employee_id JOIN users u ON u.id = e.user_id
        WHERE c.organization_id = ${orgId}::uuid AND ap.final_score IS NOT NULL ${cf}
        ORDER BY ap.final_score DESC LIMIT 5`),
      this.prisma.$queryRaw<{ name: string; score: number }[]>(Prisma.sql`
        SELECT COALESCE(u.full_name, u.email) AS name, ap.final_score::float AS score
        FROM appraisal_participants ap JOIN appraisal_cycles c ON c.id = ap.cycle_id
        JOIN employees e ON e.id = ap.employee_id JOIN users u ON u.id = e.user_id
        WHERE c.organization_id = ${orgId}::uuid AND ap.final_score IS NOT NULL ${cf}
        ORDER BY ap.final_score ASC LIMIT 5`),
    ]);

    const total = summary?.total ?? 0;
    return {
      participation: {
        total,
        started: summary?.started ?? 0,
        completed: summary?.completed ?? 0,
        completionPct: total ? Math.round(((summary?.completed ?? 0) / total) * 100) : 0,
      },
      avgScore: summary?.avg_score ?? null,
      distribution: [
        { bucket: '1–2', count: dist?.b1 ?? 0 },
        { bucket: '2–3', count: dist?.b2 ?? 0 },
        { bucket: '3–4', count: dist?.b3 ?? 0 },
        { bucket: '4–5', count: dist?.b4 ?? 0 },
      ],
      topPerformers,
      bottomPerformers,
      enps: await this.enps(orgId, cycleId),
    };
  }

  /** eNPS / pulse score over questions categorised 'eNPS' (0–10 scale). Null when none. */
  async enps(orgId: string, cycleId?: string): Promise<Record<string, unknown> | null> {
    const cf = this.cycleFilter(cycleId);
    // Performance (F-P4): previously every eNPS rating row was loaded into JavaScript
    // just to count three buckets. Postgres aggregates them and returns one row.
    const [agg] = await this.prisma.$queryRaw<{ total: number; promoters: number; detractors: number }[]>(Prisma.sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE fr.rating_value >= 9)::int AS promoters,
             count(*) FILTER (WHERE fr.rating_value <= 6)::int AS detractors
      FROM feedback_responses fr
      JOIN reviewer_assignments ra ON ra.id = fr.assignment_id
      JOIN appraisal_participants ap ON ap.id = ra.participant_id
      JOIN questions q ON q.id = fr.question_id
      WHERE ra.organization_id = ${orgId}::uuid AND ra.status = 'submitted'
        AND lower(q.category) = 'enps' AND fr.rating_value IS NOT NULL ${cf}`);
    const total = agg?.total ?? 0;
    if (total === 0) return null;
    const promoters = agg.promoters;
    const detractors = agg.detractors;
    const passives = total - promoters - detractors;
    return {
      score: Math.round(((promoters - detractors) / total) * 100),
      promoters,
      passives,
      detractors,
      responses: total,
    };
  }

  /** Nine-box grid data (NH-1): performance (final score) × potential (manual rating). */
  async nineBox(orgId: string, cycleId?: string): Promise<Record<string, unknown>> {
    const cf = this.cycleFilter(cycleId);
    const rows = await this.prisma.$queryRaw<{ id: string; name: string; performance: number; potential: number }[]>(Prisma.sql`
      SELECT e.id AS id, COALESCE(u.full_name, u.email) AS name,
             ap.final_score::float AS performance, ap.potential_rating::float AS potential
      FROM appraisal_participants ap
      JOIN appraisal_cycles c ON c.id = ap.cycle_id
      JOIN employees e ON e.id = ap.employee_id
      JOIN users u ON u.id = e.user_id
      WHERE c.organization_id = ${orgId}::uuid AND c.deleted_at IS NULL
        AND ap.final_score IS NOT NULL AND ap.potential_rating IS NOT NULL ${cf}
      ORDER BY name`);
    const scale = await this.ratingBounds(orgId);
    return {
      scaleMax: scale.max,
      employees: rows.map((r) => ({ employeeId: r.id, name: r.name, performance: r.performance, potential: r.potential })),
    };
  }

  /** Max value of the org's primary rating scale (for bucketing), default 5. */
  private async ratingBounds(orgId: string): Promise<{ max: number }> {
    const scale = await this.prisma.ratingScale.findFirst({
      where: { organizationId: orgId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { maxValue: true },
    });
    return { max: scale ? Number(scale.maxValue) : 5 };
  }

  async departmental(orgId: string, cycleId?: string): Promise<Record<string, unknown>[]> {
    const cf = this.cycleFilter(cycleId);
    const rows = await this.prisma.$queryRaw<
      { department: string; participants: number; completed: number; avg_score: number | null }[]
    >(Prisma.sql`
      SELECT COALESCE(d.name, 'Unassigned') AS department,
             count(ap.id)::int AS participants,
             count(ap.final_score)::int AS completed,
             round(avg(ap.final_score), 2)::float AS avg_score
      FROM appraisal_participants ap JOIN appraisal_cycles c ON c.id = ap.cycle_id
      JOIN employees e ON e.id = ap.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE c.organization_id = ${orgId}::uuid ${cf}
      GROUP BY COALESCE(d.name, 'Unassigned') ORDER BY 1`);
    return rows.map((r) => ({
      department: r.department,
      participants: r.participants,
      completed: r.completed,
      avgScore: r.avg_score,
      completionPct: r.participants ? Math.round((r.completed / r.participants) * 100) : 0,
    }));
  }

  /** Campus rollup (campuses are organizations with org_type='campus'). */
  async campus(orgId: string, cycleId?: string): Promise<Record<string, unknown>[]> {
    const cf = this.cycleFilter(cycleId);
    const rows = await this.prisma.$queryRaw<
      { campus: string; participants: number; completed: number; avg_score: number | null }[]
    >(Prisma.sql`
      SELECT COALESCE(cmp.name, 'Unassigned') AS campus,
             count(ap.id)::int AS participants,
             count(ap.final_score)::int AS completed,
             round(avg(ap.final_score), 2)::float AS avg_score
      FROM appraisal_participants ap
      JOIN appraisal_cycles c ON c.id = ap.cycle_id
      JOIN employees e ON e.id = ap.employee_id
      LEFT JOIN organizations cmp ON cmp.id = e.campus_id
      WHERE c.organization_id = ${orgId}::uuid AND c.deleted_at IS NULL ${cf}
      GROUP BY COALESCE(cmp.name, 'Unassigned') ORDER BY 1`);
    return rows.map((r) => ({
      campus: r.campus,
      participants: r.participants,
      completed: r.completed,
      avgScore: r.avg_score,
      completionPct: r.participants ? Math.round((r.completed / r.participants) * 100) : 0,
    }));
  }

  /**
   * Executive dashboard bundle (NH executive): org KPIs + cross-cycle trend +
   * department & campus comparison + readiness distribution + at-risk list +
   * top organisation-wide gaps. Composes the existing aggregates in one call.
   */
  async executive(orgId: string, cycleId?: string): Promise<Record<string, unknown>> {
    const target = await this.targetScore(orgId);
    const cf = this.cycleFilter(cycleId);

    const [summary] = await this.prisma.$queryRaw<
      { total: number; completed: number; avg_score: number | null }[]
    >(Prisma.sql`
      SELECT count(*)::int AS total,
             count(ap.final_score)::int AS completed,
             round(avg(ap.final_score), 2)::float AS avg_score
      FROM appraisal_participants ap
      JOIN appraisal_cycles c ON c.id = ap.cycle_id
      WHERE c.organization_id = ${orgId}::uuid AND c.deleted_at IS NULL ${cf}`);

    const scored = await this.prisma.$queryRaw<{ id: string; name: string; unit: string; score: number }[]>(Prisma.sql`
      SELECT e.id AS id, COALESCE(u.full_name, u.email) AS name,
             COALESCE(d.name, 'Unassigned') AS unit, ap.final_score::float AS score
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
      .slice(0, 6)
      // `employeeId` is already selected for this row set; carrying it lets the widget
      // drill into the person actually clicked instead of the whole at-risk band.
      .map((s) => ({ employeeId: s.id, name: s.name, unit: s.unit, score: Math.round(s.score * 100) / 100 }));

    const orgAvg = await this.orgAvgByCompetency(orgId, cycleId);
    const topGaps = [...orgAvg.entries()]
      .map(([competency, score]) => ({ competency, score, gap: Math.round((target - score) * 100) / 100 }))
      .filter((r) => r.gap > 0)
      .sort((a, b) => b.gap - a.gap)
      .slice(0, 5);

    const total = summary?.total ?? 0;
    const completed = summary?.completed ?? 0;
    return {
      target,
      kpis: {
        participants: total,
        completed,
        completionPct: total ? Math.round((completed / total) * 100) : 0,
        avgScore: summary?.avg_score ?? null,
        enps: await this.enps(orgId, cycleId),
      },
      readiness: { ready, developing, notYet },
      trend: await this.trend(orgId),
      byDepartment: await this.departmental(orgId, cycleId),
      byCampus: await this.campus(orgId, cycleId),
      atRisk,
      topGaps,
    };
  }

  /**
   * HR dashboard bundle: operational view for HR administrators — pending reviews
   * by department, department performance comparison, training needs by competency
   * (employees scoring below target on a competency), and calibration status by
   * department. Composed from the same aggregates so it stays consistent with the
   * executive view.
   */
  async hr(orgId: string, cycleId?: string): Promise<Record<string, unknown>> {
    const target = await this.targetScore(orgId);
    const cf = this.cycleFilter(cycleId);

    const byDepartment = await this.departmental(orgId, cycleId);

    const pendingByDepartment = await this.prisma.$queryRaw<{ department: string; pending: number }[]>(Prisma.sql`
      SELECT COALESCE(d.name, 'Unassigned') AS department, count(*)::int AS pending
      FROM reviewer_assignments ra
      JOIN appraisal_participants ap ON ap.id = ra.participant_id
      JOIN appraisal_cycles c ON c.id = ap.cycle_id
      JOIN employees e ON e.id = ap.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE ra.organization_id = ${orgId}::uuid AND ra.status <> 'submitted'
        AND ra.nomination_status = 'approved' AND c.deleted_at IS NULL ${cf}
      GROUP BY 1 ORDER BY 2 DESC`);

    // Employees whose average score on a competency falls below target — one
    // "training need" per (employee, competency), rolled up by competency.
    const trainingNeeds = await this.prisma.$queryRaw<{ competency: string; count: number }[]>(Prisma.sql`
      SELECT competency, count(*)::int AS count FROM (
        SELECT cmp.name AS competency, ap.employee_id, avg(fr.rating_value) AS score
        FROM feedback_responses fr
        JOIN reviewer_assignments ra ON ra.id = fr.assignment_id AND ra.status = 'submitted'
        JOIN appraisal_participants ap ON ap.id = ra.participant_id
        JOIN appraisal_cycles c ON c.id = ap.cycle_id
        JOIN questions q ON q.id = fr.question_id
        JOIN competencies cmp ON cmp.id = q.competency_id
        WHERE ra.organization_id = ${orgId}::uuid AND fr.rating_value IS NOT NULL AND c.deleted_at IS NULL ${cf}
        GROUP BY cmp.name, ap.employee_id
      ) t WHERE t.score < ${target} GROUP BY competency ORDER BY count DESC`);

    const pendingTotal = pendingByDepartment.reduce((s, r) => s + Number(r.pending), 0);
    const trainingTotal = trainingNeeds.reduce((s, r) => s + Number(r.count), 0);
    const deptsWithPeople = byDepartment.filter((d) => (d.participants as number) > 0);
    const deptsCompleted = deptsWithPeople.filter((d) => (d.completionPct as number) === 100).length;
    const calibrationPct = deptsWithPeople.length ? Math.round((deptsCompleted / deptsWithPeople.length) * 100) : 0;
    const scoredDepts = byDepartment.filter((d) => d.avgScore != null);
    const avgDeptPerformance = scoredDepts.length
      ? Math.round((scoredDepts.reduce((s, d) => s + (d.avgScore as number), 0) / scoredDepts.length) * 100) / 100
      : null;

    return {
      target,
      kpis: {
        pending: pendingTotal,
        avgDeptPerformance,
        trainingNeeds: trainingTotal,
        calibrationPct,
        departmentsCompleted: deptsCompleted,
        departmentsTotal: deptsWithPeople.length,
      },
      pendingByDepartment: pendingByDepartment.map((r) => ({ department: r.department, pending: Number(r.pending) })),
      byDepartment,
      trainingNeeds: trainingNeeds.map((r) => ({ competency: r.competency, count: Number(r.count) })),
    };
  }

  /* ======================================================================= *
   * Drill-down: underlying records behind a dashboard element. Each returns a
   * generic { columns, rows } grid the UI renders as a searchable/sortable table.
   * ======================================================================= */

  /** Participant-level records — behind KPI cards, readiness, dept/campus bars. */
  async drilldownParticipants(
    orgId: string,
    opts: { cycleId?: string; department?: string; campus?: string; band?: string },
  ): Promise<Record<string, unknown>> {
    const target = await this.targetScore(orgId);
    const cf = this.cycleFilter(opts.cycleId);
    const rows = await this.prisma.$queryRaw<
      { employeeId: string; name: string; department: string; campus: string; designation: string | null; status: string; score: number | null; cycle: string }[]
    >(Prisma.sql`
      SELECT e.id AS "employeeId",
             COALESCE(u.full_name, u.email) AS name,
             COALESCE(d.name, 'Unassigned') AS department,
             COALESCE(cmp.name, 'Unassigned') AS campus,
             dg.name AS designation,
             ap.status AS status,
             ap.final_score::float AS score,
             c.name AS cycle
      FROM appraisal_participants ap
      JOIN appraisal_cycles c ON c.id = ap.cycle_id
      JOIN employees e ON e.id = ap.employee_id
      JOIN users u ON u.id = e.user_id
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN organizations cmp ON cmp.id = e.campus_id
      LEFT JOIN designations dg ON dg.id = e.designation_id
      WHERE c.organization_id = ${orgId}::uuid AND c.deleted_at IS NULL ${cf}
      ORDER BY ap.final_score DESC NULLS LAST, name ASC`);

    const filtered = rows.filter((r) => {
      if (opts.department && r.department !== opts.department) return false;
      if (opts.campus && r.campus !== opts.campus) return false;
      if (opts.band) {
        const s = r.score;
        if (opts.band === 'scored' && s == null) return false;
        if (opts.band === 'pending' && s != null) return false;
        if (opts.band === 'ready' && !(s != null && s >= target)) return false;
        if (opts.band === 'developing' && !(s != null && s >= target - 1 && s < target)) return false;
        if (opts.band === 'atrisk' && !(s != null && s < target - 1)) return false;
      }
      return true;
    });

    return {
      columns: [
        { key: 'name', label: 'Employee' },
        { key: 'department', label: 'Department' },
        { key: 'campus', label: 'Campus' },
        { key: 'designation', label: 'Designation' },
        { key: 'status', label: 'Status' },
        { key: 'score', label: 'Final score', numeric: true },
      ],
      // `employeeId` is carried on the row but not declared as a column, so the grid
      // renders exactly as before while the UI can drill from a row to that person's
      // 360 profile. It is an internal id already visible to anyone who can open the
      // individual report, and the report itself re-checks scope and release.
      rows: filtered.map((r) => ({
        employeeId: r.employeeId,
        name: r.name,
        department: r.department,
        campus: r.campus,
        designation: r.designation ?? '—',
        status: r.status,
        score: r.score ?? null,
      })),
    };
  }

  /** Outstanding reviewer assignments — behind "Pending reviews". */
  async drilldownPending(orgId: string, opts: { cycleId?: string; department?: string }): Promise<Record<string, unknown>> {
    const cf = this.cycleFilter(opts.cycleId);
    const rows = await this.prisma.$queryRaw<
      { appraisee: string; department: string; reviewer: string; source: string; status: string }[]
    >(Prisma.sql`
      SELECT COALESCE(au.full_name, au.email) AS appraisee,
             COALESCE(d.name, 'Unassigned') AS department,
             COALESCE(ru.full_name, ru.email, ra.external_name, 'External') AS reviewer,
             fs.label AS source,
             ra.status AS status
      FROM reviewer_assignments ra
      JOIN appraisal_participants ap ON ap.id = ra.participant_id
      JOIN appraisal_cycles c ON c.id = ap.cycle_id
      JOIN employees ae ON ae.id = ap.employee_id
      JOIN users au ON au.id = ae.user_id
      LEFT JOIN departments d ON d.id = ae.department_id
      JOIN feedback_sources fs ON fs.id = ra.source_id
      LEFT JOIN employees re ON re.id = ra.reviewer_employee_id
      LEFT JOIN users ru ON ru.id = re.user_id
      WHERE ra.organization_id = ${orgId}::uuid AND ra.status <> 'submitted'
        AND ra.nomination_status = 'approved' AND c.deleted_at IS NULL ${cf}
      ORDER BY department, appraisee`);

    const filtered = opts.department ? rows.filter((r) => r.department === opts.department) : rows;
    return {
      columns: [
        { key: 'appraisee', label: 'Employee' },
        { key: 'department', label: 'Department' },
        { key: 'reviewer', label: 'Reviewer' },
        { key: 'source', label: 'Source' },
        { key: 'status', label: 'Status' },
      ],
      rows: filtered,
    };
  }

  /** Employee × competency records — behind top gaps / training needs. */
  async drilldownCompetency(
    orgId: string,
    opts: { cycleId?: string; competency?: string; belowTarget?: boolean },
  ): Promise<Record<string, unknown>> {
    const target = await this.targetScore(orgId);
    const cf = this.cycleFilter(opts.cycleId);
    const compFilter = opts.competency ? Prisma.sql`AND cmp.name = ${opts.competency}` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<{ employeeId: string; name: string; department: string; competency: string; score: number }[]>(Prisma.sql`
      SELECT e.id AS "employeeId",
             COALESCE(u.full_name, u.email) AS name,
             COALESCE(d.name, 'Unassigned') AS department,
             cmp.name AS competency,
             round(avg(fr.rating_value), 2)::float AS score
      FROM feedback_responses fr
      JOIN reviewer_assignments ra ON ra.id = fr.assignment_id AND ra.status = 'submitted'
      JOIN appraisal_participants ap ON ap.id = ra.participant_id
      JOIN appraisal_cycles c ON c.id = ap.cycle_id
      JOIN employees e ON e.id = ap.employee_id
      JOIN users u ON u.id = e.user_id
      LEFT JOIN departments d ON d.id = e.department_id
      JOIN questions q ON q.id = fr.question_id
      JOIN competencies cmp ON cmp.id = q.competency_id
      WHERE ra.organization_id = ${orgId}::uuid AND fr.rating_value IS NOT NULL AND c.deleted_at IS NULL ${cf} ${compFilter}
      GROUP BY e.id, COALESCE(u.full_name, u.email), COALESCE(d.name, 'Unassigned'), cmp.name
      ORDER BY score ASC`);

    const filtered = (opts.belowTarget ? rows.filter((r) => r.score < target) : rows).map((r) => ({
      employeeId: r.employeeId,
      name: r.name,
      department: r.department,
      competency: r.competency,
      score: r.score,
      gap: Math.round((target - r.score) * 100) / 100,
    }));
    return {
      columns: [
        { key: 'name', label: 'Employee' },
        { key: 'department', label: 'Department' },
        { key: 'competency', label: 'Competency' },
        { key: 'score', label: 'Score', numeric: true },
        { key: 'gap', label: 'Gap vs target', numeric: true },
      ],
      rows: filtered,
    };
  }

  async trend(orgId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.$queryRaw<
      { cycle_id: string; cycle: string; avg_score: number | null; participants: number; completed: number }[]
    >(Prisma.sql`
      SELECT c.id AS cycle_id,
             c.name AS cycle,
             round(avg(ap.final_score), 2)::float AS avg_score,
             count(ap.id)::int AS participants,
             count(ap.final_score)::int AS completed
      FROM appraisal_cycles c LEFT JOIN appraisal_participants ap ON ap.cycle_id = c.id
      WHERE c.organization_id = ${orgId}::uuid AND c.deleted_at IS NULL
      GROUP BY c.id, c.name, c.start_date ORDER BY c.start_date`);
    return rows.map((r) => ({
      // cycleId lets the trend chart drill into the clicked cycle; the chart itself
      // still plots by cycle name.
      cycleId: r.cycle_id,
      cycle: r.cycle,
      avgScore: r.avg_score,
      participants: r.participants,
      completionPct: r.participants ? Math.round((r.completed / r.participants) * 100) : 0,
    }));
  }

  async heatmap(orgId: string, cycleId?: string): Promise<Record<string, unknown>> {
    const cf = this.cycleFilter(cycleId);
    const min = await this.minResponses(orgId);
    const rows = await this.prisma.$queryRaw<{ competency: string; department: string; score: number; reviewers: number }[]>(Prisma.sql`
      SELECT cmp.name AS competency, COALESCE(d.name, 'Unassigned') AS department,
             round(avg(fr.rating_value), 2)::float AS score,
             count(DISTINCT COALESCE(ra.reviewer_employee_id::text, ra.id::text))::int AS reviewers
      FROM feedback_responses fr
      JOIN reviewer_assignments ra ON ra.id = fr.assignment_id
      JOIN appraisal_participants ap ON ap.id = ra.participant_id
      JOIN employees e ON e.id = ap.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      JOIN questions q ON q.id = fr.question_id
      JOIN competencies cmp ON cmp.id = q.competency_id
      WHERE ra.organization_id = ${orgId}::uuid AND ra.status = 'submitted'
        AND fr.rating_value IS NOT NULL ${cf}
      GROUP BY cmp.name, COALESCE(d.name, 'Unassigned')`);

    const competencies = [...new Set(rows.map((r) => r.competency))].sort();
    const departments = [...new Set(rows.map((r) => r.department))].sort();
    // Hide any competency×department cell backed by fewer than `min` reviewers.
    const cell = new Map(rows.map((r) => [`${r.competency}|${r.department}`, r.reviewers >= min ? r.score : null]));
    const data: [number, number, number | null][] = [];
    competencies.forEach((comp, ci) => {
      departments.forEach((dep, di) => {
        data.push([di, ci, cell.get(`${comp}|${dep}`) ?? null]);
      });
    });
    return { competencies, departments, data };
  }

  /**
   * True when the employee has at least one released participant record (optionally
   * for a specific cycle). Backs the release gate that hides results from
   * self/subordinate viewers until HR releases them (DEF-01). The caller has already
   * verified org-scoped access to the employee, so filtering by employeeId is safe.
   */
  async hasReleasedResults(_orgId: string, employeeId: string, cycleId?: string): Promise<boolean> {
    const count = await this.prisma.appraisalParticipant.count({
      where: { employeeId, visibility: 'released', ...(cycleId ? { cycleId } : {}) },
    });
    return count > 0;
  }

  /**
   * The two things an employee-level 360 drill-down needs that no existing endpoint
   * returns: the person's score across cycles, and how complete each feedback source
   * ("quadrant") is.
   *
   * Everything else the drill-down shows — overall score, per-source scores with
   * anonymity suppression, per-competency scores, strengths, development areas and
   * the competency radar with its organisation benchmark — already comes from
   * `individual()` and `radar()`, which the caller uses unchanged. Nothing here
   * recalculates a score: the trend reads the same `final_score` column the rest of
   * the product treats as authoritative (so an HR calibration override is reflected),
   * and the status counts are assignment counts, not ratings.
   *
   * No reviewer identity is selected or returned — only counts per source.
   */
  async employeeDrilldown(orgId: string, employeeId: string, cycleId?: string): Promise<Record<string, unknown>> {
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (!employee) throw new NotFoundException('Employee not found.');

    // Score per cycle the employee actually participated in, oldest first. Cycles
    // where nothing was scored yet are included with a null score so the executive
    // can see participation as well as performance.
    const trend = await this.prisma.$queryRaw<{ cycleId: string; cycle: string; score: number | null }[]>(Prisma.sql`
      SELECT c.id AS "cycleId", c.name AS cycle, ap.final_score::float AS score
      FROM appraisal_participants ap
      JOIN appraisal_cycles c ON c.id = ap.cycle_id
      WHERE ap.employee_id = ${employeeId}::uuid
        AND c.organization_id = ${orgId}::uuid
        AND c.deleted_at IS NULL
      ORDER BY c.start_date ASC`);

    // Reviewer coverage per source: how many assignments exist and how many came
    // back. Counts only — never who. `expected` is the source's configured minimum
    // so an executive can see "2 of 3 peers responded" without seeing any peer.
    const cf = cycleId ? Prisma.sql`AND ap.cycle_id = ${cycleId}::uuid` : Prisma.empty;
    const status = await this.prisma.$queryRaw<
      { source: string; code: string; assigned: number; submitted: number; required: number }[]
    >(Prisma.sql`
      SELECT fs.label AS source,
             fs.code AS code,
             count(*)::int AS assigned,
             count(*) FILTER (WHERE ra.status = 'submitted')::int AS submitted,
             max(fs.required_count)::int AS required
      FROM reviewer_assignments ra
      JOIN feedback_sources fs ON fs.id = ra.source_id
      JOIN appraisal_participants ap ON ap.id = ra.participant_id
      JOIN appraisal_cycles c ON c.id = ap.cycle_id
      WHERE ap.employee_id = ${employeeId}::uuid
        AND c.organization_id = ${orgId}::uuid
        AND c.deleted_at IS NULL ${cf}
      GROUP BY fs.label, fs.code
      ORDER BY fs.label ASC`);

    return {
      trend: trend.map((t) => ({ cycleId: t.cycleId, cycle: t.cycle, score: t.score })),
      sourceStatus: status.map((r) => ({
        source: r.source,
        code: r.code,
        assigned: r.assigned,
        submitted: r.submitted,
        pending: r.assigned - r.submitted,
        required: r.required,
        completionPct: r.assigned ? Math.round((r.submitted / r.assigned) * 100) : 0,
      })),
    };
  }

  async individual(orgId: string, employeeId: string, cycleId?: string, unlocked = false): Promise<Record<string, unknown>> {
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, organizationId: orgId, deletedAt: null },
      include: {
        user: { select: { fullName: true, email: true } },
        designation: { select: { name: true } },
        // Department is carried so the report can benchmark the employee against
        // their own unit using the existing competency×department heatmap, instead
        // of only against the whole organisation.
        department: { select: { name: true } },
      },
    });
    if (!employee) throw new NotFoundException('Employee not found.');

    const byCompetency = await this.byCompetency(orgId, employeeId, cycleId);
    const rawSources = await this.bySource(orgId, employeeId, cycleId);
    const min = await this.minResponses(orgId);
    const suppressAll = await this.suppressAllSources(orgId);
    const counts = await this.sourceCounts(orgId, employeeId, cycleId);
    const bySource = rawSources.map((s) => {
      const hidden = this.suppressed(counts, s.source, min, unlocked, suppressAll);
      return {
        source: s.source,
        score: hidden ? null : s.score,
        reviewers: counts.get(s.source)?.reviewers ?? 0,
        suppressed: hidden,
      };
    });
    const sorted = [...byCompetency].sort((a, b) => b.score - a.score);
    // Overall score must agree with every other surface (F-H8).
    //
    // This used to be the unweighted mean of the competency means, while the
    // dashboards, nine-box, my-team and even this report's own "previous" figure all
    // use the stored weighted `finalScore`. The same person therefore showed two
    // different overall scores depending on the screen, and the trend arrow compared
    // unlike quantities. It also ignored HR calibration entirely. Use the stored
    // score, falling back to the competency mean only when nothing has been scored.
    const competencyMean =
      byCompetency.length > 0
        ? Math.round((byCompetency.reduce((s, c) => s + c.score, 0) / byCompetency.length) * 100) / 100
        : null;
    const overall = (await this.currentFinalScore(orgId, employeeId, cycleId)) ?? competencyMean;

    return {
      employee: {
        id: employee.id,
        name: employee.user.fullName ?? employee.user.email,
        designation: employee.designation?.name ?? null,
        department: employee.department?.name ?? null,
      },
      overallScore: overall,
      previousOverall: await this.previousOverall(orgId, employeeId, cycleId),
      minResponses: min,
      /** True when this caller is seeing sub-threshold quadrants that others cannot. */
      confidentialUnlocked: unlocked,
      byCompetency,
      bySource,
      strengths: sorted.slice(0, 3),
      weaknesses: sorted.slice(-3).reverse(),
      gap: await this.gap(orgId, employeeId, cycleId),
      comments: await this.comments(orgId, employeeId, min, cycleId, unlocked),
    };
  }

  /**
   * Anonymised written feedback grouped by question (F-C7).
   *
   * Reviewers answer open-text questions and those answers were stored but never
   * shown anywhere — the single most valued output of a 360 programme was collected
   * and then silently discarded from the reporting surface.
   *
   * Confidentiality rules, mirroring the numeric suppression:
   *  - reviewer identity is never returned (no name, no id, no ordering by reviewer);
   *  - self answers are separated out and always attributable to the appraisee;
   *  - all other sources are POOLED, so a comment cannot be traced to one source;
   *  - the pooled set is withheld entirely until it reaches the org's minimum-response
   *    threshold, because one or two comments identify their author;
   *  - comments are returned in a stable, content-independent order.
   */
  private async comments(
    orgId: string,
    employeeId: string,
    min: number,
    cycleId?: string,
    unlocked = false,
  ): Promise<{
    question: string;
    self: string[];
    others: string[];
    othersCount: number;
    suppressed: boolean;
  }[]> {
    const cf = this.cycleFilter(cycleId);
    const rows = await this.prisma.$queryRaw<
      { question: string; is_self: boolean; text: string }[]
    >(Prisma.sql`
      SELECT q.text AS question,
             (fs.code = 'self') AS is_self,
             trim(fr.text_value) AS text
      FROM feedback_responses fr
      JOIN questions q ON q.id = fr.question_id
      JOIN reviewer_assignments ra ON ra.id = fr.assignment_id
      JOIN appraisal_participants ap ON ap.id = ra.participant_id
      JOIN appraisal_cycles c ON c.id = ap.cycle_id
      JOIN feedback_sources fs ON fs.id = ra.source_id
      WHERE ra.organization_id = ${orgId}::uuid
        AND ap.employee_id = ${employeeId}::uuid
        AND ra.status = 'submitted'
        AND c.deleted_at IS NULL
        AND fr.text_value IS NOT NULL
        AND length(trim(fr.text_value)) > 0 ${cf}
      ORDER BY q.text ASC, trim(fr.text_value) ASC`);

    const byQuestion = new Map<string, { self: string[]; others: string[] }>();
    for (const r of rows) {
      const bucket = byQuestion.get(r.question) ?? { self: [], others: [] };
      (r.is_self ? bucket.self : bucket.others).push(r.text);
      byQuestion.set(r.question, bucket);
    }
    return [...byQuestion.entries()].map(([question, b]) => {
      const suppressed = !unlocked && b.others.length > 0 && b.others.length < min;
      return {
        question,
        self: b.self,
        others: suppressed ? [] : b.others,
        othersCount: b.others.length,
        suppressed,
      };
    });
  }

  async radar(orgId: string, employeeId: string, cycleId?: string, unlocked = false): Promise<Record<string, unknown>> {
    const cf = this.cycleFilter(cycleId);
    const rows = await this.prisma.$queryRaw<{ competency: string; source: string; score: number }[]>(Prisma.sql`
      SELECT cmp.name AS competency, fs.label AS source, round(avg(fr.rating_value), 2)::float AS score
      FROM feedback_responses fr
      JOIN reviewer_assignments ra ON ra.id = fr.assignment_id
      JOIN appraisal_participants ap ON ap.id = ra.participant_id
      JOIN feedback_sources fs ON fs.id = ra.source_id
      JOIN questions q ON q.id = fr.question_id
      JOIN competencies cmp ON cmp.id = q.competency_id
      WHERE ra.organization_id = ${orgId}::uuid AND ap.employee_id = ${employeeId}::uuid
        AND ra.status = 'submitted' AND fr.rating_value IS NOT NULL ${cf}
      GROUP BY cmp.name, fs.label`);

    const min = await this.minResponses(orgId);
    const suppressAll = await this.suppressAllSources(orgId);
    const counts = await this.sourceCounts(orgId, employeeId, cycleId);
    const allSources = [...new Set(rows.map((r) => r.source))].sort();
    // Drop entire rater-source series that fall below the confidentiality threshold.
    const sources = allSources.filter((s) => !this.suppressed(counts, s, min, unlocked, suppressAll));
    const withheld = allSources.filter((s) => this.suppressed(counts, s, min, unlocked, suppressAll));
    const cell = new Map(rows.map((r) => [`${r.competency}|${r.source}`, r.score]));

    // Which quadrants were ASKED about each competency, from the questionnaires attached
    // to the cycle's quadrants. Without this a blank cell is ambiguous: it could mean
    // "too few responses to show" or "this group was never asked". Configuration answers
    // that; responses alone cannot.
    const coverage = await this.competencyCoverage(orgId, employeeId, cycleId);
    const competencies = [...new Set([...rows.map((r) => r.competency), ...coverage.keys()])].sort();

    const series = sources.map((source) => ({
      name: source,
      values: competencies.map((comp) => cell.get(`${comp}|${source}`) ?? null),
    }));
    // Benchmark overlay: organisation-wide average per competency (HV-4).
    const orgAvg = await this.orgAvgByCompetency(orgId, cycleId);
    if (competencies.some((c) => orgAvg.has(c))) {
      series.push({ name: 'Organisation average', values: competencies.map((c) => orgAvg.get(c) ?? null) });
    }
    return {
      competencies,
      series,
      /** Quadrant labels assessing each competency — lets a blank cell be labelled. */
      assessedBy: Object.fromEntries(competencies.map((c) => [c, [...(coverage.get(c) ?? [])]])),
      /** Quadrants present but held back by the anonymity threshold for this employee. */
      withheldSources: withheld,
      minResponses: min,
      confidentialUnlocked: unlocked,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Shared-competency comparison (gap / blind spot / consensus)          */
  /* ------------------------------------------------------------------ */

  /** The five comparison thresholds, admin-editable, with their defaults. */
  async comparisonRules(orgId: string): Promise<{
    gapModerate: number;
    gapPronounced: number;
    consensusSdLow: number;
    consensusSdHigh: number;
    comparisonMinQuadrants: number;
  }> {
    const rows = await this.prisma.configuration.findMany({
      where: {
        organizationId: orgId,
        module: 'reports',
        key: { in: ['gap_moderate', 'gap_pronounced', 'consensus_sd_low', 'consensus_sd_high', 'comparison_min_quadrants'] },
        deletedAt: null,
      },
      select: { key: true, value: true },
    });
    const num = (key: string, fallback: number): number => {
      const v = rows.find((r) => r.key === key)?.value;
      return typeof v === 'number' && v >= 0 ? v : fallback;
    };
    return {
      gapModerate: num('gap_moderate', DEFAULT_GAP_MODERATE),
      gapPronounced: num('gap_pronounced', DEFAULT_GAP_PRONOUNCED),
      consensusSdLow: num('consensus_sd_low', DEFAULT_CONSENSUS_SD_LOW),
      consensusSdHigh: num('consensus_sd_high', DEFAULT_CONSENSUS_SD_HIGH),
      comparisonMinQuadrants: Math.max(2, Math.floor(num('comparison_min_quadrants', DEFAULT_COMPARISON_MIN_QUADRANTS))),
    };
  }

  /**
   * How different evaluator groups see the SAME competency.
   *
   * Only competencies assessed by two or more quadrants can be compared — that is what
   * makes a competency "shared", and it is derived from the questionnaires attached to
   * the quadrants rather than from a stored flag that could drift.
   *
   * Rules that keep a verdict honest:
   *  - a quadrant withheld by the anonymity threshold contributes NOTHING; it is not
   *    quietly treated as a zero or dropped silently, it is reported as withheld;
   *  - a competency a quadrant was never asked about is "not assessed", not a gap;
   *  - fewer than `comparisonMinQuadrants` visible quadrants produces scores but no
   *    verdict, so a single group's view is never presented as a comparison;
   *  - every row carries the reviewer count behind each quadrant, so a 0.6 difference
   *    between two single-rater quadrants cannot masquerade as a finding.
   *
   * Self is reported alongside the others but excluded from the consensus spread, since
   * it is one person's view of themselves; it drives the blind-spot verdict instead.
   */
  async sharedCompetencies(
    orgId: string,
    employeeId: string,
    cycleId?: string,
    unlocked = false,
  ): Promise<Record<string, unknown>> {
    const cf = this.cycleFilter(cycleId);
    const rows = await this.prisma.$queryRaw<{ competency: string; source: string; code: string; score: number; reviewers: number }[]>(Prisma.sql`
      SELECT cmp.name AS competency, fs.label AS source, fs.code AS code,
             round(avg(fr.rating_value), 2)::float AS score,
             count(DISTINCT COALESCE(ra.reviewer_employee_id::text, ra.id::text))::int AS reviewers
      FROM feedback_responses fr
      JOIN reviewer_assignments ra ON ra.id = fr.assignment_id
      JOIN appraisal_participants ap ON ap.id = ra.participant_id
      JOIN feedback_sources fs ON fs.id = ra.source_id
      JOIN questions q ON q.id = fr.question_id
      JOIN competencies cmp ON cmp.id = q.competency_id
      WHERE ra.organization_id = ${orgId}::uuid AND ap.employee_id = ${employeeId}::uuid
        AND ra.status = 'submitted' AND fr.rating_value IS NOT NULL ${cf}
      GROUP BY cmp.name, fs.label, fs.code`);

    const rules = await this.comparisonRules(orgId);
    const min = await this.minResponses(orgId);
    const suppressAll = await this.suppressAllSources(orgId);
    const counts = await this.sourceCounts(orgId, employeeId, cycleId);
    const coverage = await this.competencyCoverage(orgId, employeeId, cycleId);
    const target = await this.targetScore(orgId);

    const byCompetency = new Map<string, { source: string; code: string; score: number; reviewers: number; withheld: boolean }[]>();
    for (const r of rows) {
      const withheld = this.suppressed(counts, r.source, min, unlocked, suppressAll);
      const list = byCompetency.get(r.competency) ?? [];
      list.push({ source: r.source, code: r.code, score: r.score, reviewers: r.reviewers, withheld });
      byCompetency.set(r.competency, list);
    }

    const items = [...byCompetency.entries()].map(([competency, all]) => {
      const assessedBy = [...(coverage.get(competency) ?? new Set(all.map((a) => a.source)))];
      const visible = all.filter((a) => !a.withheld);
      const others = visible.filter((a) => a.code !== 'self');
      const self = visible.find((a) => a.code === 'self') ?? null;

      type QuadrantCell = {
        source: string;
        code: string;
        score: number | null;
        reviewers: number;
        /** scored | withheld by the threshold | asked but nobody answered */
        state: 'scored' | 'withheld' | 'no_responses';
      };
      const quadrants: QuadrantCell[] = all.map((a) => ({
        source: a.source,
        code: a.code,
        score: a.withheld ? null : a.score,
        reviewers: a.reviewers,
        state: a.withheld ? 'withheld' : 'scored',
      }));
      // Quadrants asked about this competency that returned nothing at all.
      for (const label of assessedBy) {
        if (!quadrants.some((q) => q.source === label)) {
          quadrants.push({ source: label, code: '', score: null, reviewers: 0, state: 'no_responses' });
        }
      }

      const comparable = others.length >= rules.comparisonMinQuadrants;
      const values = others.map((o) => o.score);
      const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
      const sd =
        values.length > 1 && mean !== null
          ? Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length)
          : null;
      const highest = others.length ? others.reduce((a, b) => (b.score > a.score ? b : a)) : null;
      const lowest = others.length ? others.reduce((a, b) => (b.score < a.score ? b : a)) : null;
      const spread = highest && lowest ? Math.round((highest.score - lowest.score) * 100) / 100 : null;
      const selfGap = self && mean !== null ? Math.round((self.score - mean) * 100) / 100 : null;

      const findings: { kind: string; label: string; detail: string }[] = [];
      if (selfGap !== null && Math.abs(selfGap) >= rules.gapModerate) {
        const pronounced = Math.abs(selfGap) >= rules.gapPronounced;
        findings.push(
          selfGap > 0
            ? {
                kind: 'blind_spot',
                label: pronounced ? 'Blind spot (pronounced)' : 'Blind spot',
                detail: `Rates themselves ${selfGap.toFixed(2)} above how other groups rate them.`,
              }
            : {
                kind: 'hidden_strength',
                label: pronounced ? 'Hidden strength (pronounced)' : 'Hidden strength',
                detail: `Other groups rate them ${Math.abs(selfGap).toFixed(2)} above their own view.`,
              },
        );
      }
      if (comparable && spread !== null && spread >= rules.gapPronounced && highest && lowest) {
        findings.push({
          kind: 'needs_investigation',
          label: 'Perspectives differ sharply',
          detail: `${highest.source} ${highest.score.toFixed(2)} vs ${lowest.source} ${lowest.score.toFixed(2)} — a ${spread.toFixed(2)} gap.`,
        });
      }
      if (comparable && sd !== null && sd >= rules.consensusSdHigh) {
        findings.push({ kind: 'divergent', label: 'Divergent perception', detail: `Spread across groups is wide (SD ${sd.toFixed(2)}).` });
      }
      if (comparable && sd !== null && sd <= rules.consensusSdLow) {
        const consistentlyStrong = others.every((o) => o.score >= target);
        findings.push(
          consistentlyStrong
            ? { kind: 'consistent_strength', label: 'Consistent strength', detail: `Every group scores at or above the target of ${target}.` }
            : { kind: 'consensus', label: 'Groups agree', detail: `Groups see this similarly (SD ${sd.toFixed(2)}).` },
        );
      }

      return {
        competency,
        shared: assessedBy.length >= 2,
        assessedBy,
        comparable,
        quadrants: quadrants.sort((a, b) => a.source.localeCompare(b.source)),
        othersMean: mean === null ? null : Math.round(mean * 100) / 100,
        selfScore: self?.score ?? null,
        selfGap,
        spread,
        sd: sd === null ? null : Math.round(sd * 100) / 100,
        highest: highest ? { source: highest.source, score: highest.score } : null,
        lowest: lowest ? { source: lowest.source, score: lowest.score } : null,
        findings,
      };
    });

    // Shared first, then widest disagreement — the order someone reads them in.
    items.sort((a, b) => Number(b.shared) - Number(a.shared) || (b.spread ?? -1) - (a.spread ?? -1) || a.competency.localeCompare(b.competency));
    return { rules, target, minResponses: min, confidentialUnlocked: unlocked, items };
  }

  /** Cycles this employee took part in — the scope a coverage lookup must cover. */
  private async participatingCycleIds(orgId: string, employeeId: string, cycleId?: string): Promise<string[]> {
    if (cycleId) return [cycleId];
    const rows = await this.prisma.appraisalParticipant.findMany({
      where: { employeeId, cycle: { organizationId: orgId, deletedAt: null } },
      select: { cycleId: true },
    });
    return [...new Set(rows.map((r) => r.cycleId))];
  }

  /** competency name -> quadrant labels whose questionnaire covers it. */
  private async competencyCoverage(orgId: string, employeeId: string, cycleId?: string): Promise<Map<string, Set<string>>> {
    const cycles = await this.participatingCycleIds(orgId, employeeId, cycleId);
    if (cycles.length === 0) return new Map();
    return coverageForCycles(this.prisma, cycles);
  }

  async gap(orgId: string, employeeId: string, cycleId?: string): Promise<Record<string, unknown>[]> {
    const target = await this.targetScore(orgId);
    const current = await this.byCompetency(orgId, employeeId, cycleId);
    return current.map((c) => {
      const gap = Math.round((target - c.score) * 100) / 100;
      return {
        competency: c.competency,
        current: c.score,
        expected: target,
        gap,
        priority: gap >= 1 ? 'high' : gap >= 0.5 ? 'medium' : 'low',
      };
    });
  }

  /**
   * Competency scores across ALL quadrants combined.
   *
   * `quadrants` is the number of rater groups that contributed. It matters once quadrants
   * can carry different questionnaires: a competency only the line manager was asked about
   * produces a single-perspective number that would otherwise read as an all-round score.
   * Reports show the count so nobody mistakes one for the other.
   */
  private async byCompetency(orgId: string, employeeId: string, cycleId?: string): Promise<{ competency: string; score: number; quadrants: number }[]> {
    const cf = this.cycleFilter(cycleId);
    return this.prisma.$queryRaw<{ competency: string; score: number; quadrants: number }[]>(Prisma.sql`
      SELECT cmp.name AS competency, round(avg(fr.rating_value), 2)::float AS score,
             count(DISTINCT ra.source_id)::int AS quadrants
      FROM feedback_responses fr
      JOIN reviewer_assignments ra ON ra.id = fr.assignment_id
      JOIN appraisal_participants ap ON ap.id = ra.participant_id
      JOIN questions q ON q.id = fr.question_id
      JOIN competencies cmp ON cmp.id = q.competency_id
      WHERE ra.organization_id = ${orgId}::uuid AND ap.employee_id = ${employeeId}::uuid
        AND ra.status = 'submitted' AND fr.rating_value IS NOT NULL ${cf}
      GROUP BY cmp.name ORDER BY cmp.name`);
  }

  private async bySource(orgId: string, employeeId: string, cycleId?: string): Promise<{ source: string; score: number }[]> {
    const cf = this.cycleFilter(cycleId);
    return this.prisma.$queryRaw<{ source: string; score: number }[]>(Prisma.sql`
      SELECT fs.label AS source, round(avg(fr.rating_value), 2)::float AS score
      FROM feedback_responses fr
      JOIN reviewer_assignments ra ON ra.id = fr.assignment_id
      JOIN appraisal_participants ap ON ap.id = ra.participant_id
      JOIN feedback_sources fs ON fs.id = ra.source_id
      WHERE ra.organization_id = ${orgId}::uuid AND ap.employee_id = ${employeeId}::uuid
        AND ra.status = 'submitted' AND fr.rating_value IS NOT NULL ${cf}
      GROUP BY fs.label ORDER BY fs.label`);
  }

  /** Organisation-wide average rating per competency (benchmark overlay). */
  private async orgAvgByCompetency(orgId: string, cycleId?: string): Promise<Map<string, number>> {
    const cf = this.cycleFilter(cycleId);
    const rows = await this.prisma.$queryRaw<{ competency: string; score: number }[]>(Prisma.sql`
      SELECT cmp.name AS competency, round(avg(fr.rating_value), 2)::float AS score
      FROM feedback_responses fr
      JOIN reviewer_assignments ra ON ra.id = fr.assignment_id
      JOIN appraisal_participants ap ON ap.id = ra.participant_id
      JOIN questions q ON q.id = fr.question_id
      JOIN competencies cmp ON cmp.id = q.competency_id
      WHERE ra.organization_id = ${orgId}::uuid AND ra.status = 'submitted'
        AND fr.rating_value IS NOT NULL ${cf}
      GROUP BY cmp.name`);
    return new Map(rows.map((r) => [r.competency, r.score]));
  }

  /** The employee's overall score in the cycle immediately before the latest one. */
  /**
   * The authoritative weighted score for this employee in the selected cycle (or the
   * most recent cycle when none is selected) — the same `final_score` the dashboards
   * read, so every surface agrees and HR calibration is respected (F-H8).
   */
  private async currentFinalScore(orgId: string, employeeId: string, cycleId?: string): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<{ score: number }[]>(Prisma.sql`
      SELECT ap.final_score::float AS score
      FROM appraisal_participants ap
      JOIN appraisal_cycles c ON c.id = ap.cycle_id
      WHERE c.organization_id = ${orgId}::uuid AND ap.employee_id = ${employeeId}::uuid
        AND ap.final_score IS NOT NULL AND c.deleted_at IS NULL
        ${cycleId ? Prisma.sql`AND ap.cycle_id = ${cycleId}::uuid` : Prisma.empty}
      ORDER BY c.start_date DESC`);
    return rows[0]?.score ?? null;
  }

  private async previousOverall(orgId: string, employeeId: string, cycleId?: string): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<{ score: number }[]>(Prisma.sql`
      SELECT ap.final_score::float AS score
      FROM appraisal_participants ap
      JOIN appraisal_cycles c ON c.id = ap.cycle_id
      WHERE c.organization_id = ${orgId}::uuid AND ap.employee_id = ${employeeId}::uuid
        AND ap.final_score IS NOT NULL AND c.deleted_at IS NULL
        ${cycleId ? Prisma.sql`AND ap.cycle_id <> ${cycleId}::uuid` : Prisma.empty}
      ORDER BY c.start_date DESC`);
    // With a selected cycle: most recent *other* cycle. Otherwise: the prior one.
    const index = cycleId ? 0 : 1;
    return rows[index]?.score ?? null;
  }

  /**
   * Manager rollup: a compact 360° summary for each of the current user's direct
   * reports (HV-1). Uses the existing line-manager hierarchy; returns an empty
   * set when the caller isn't a people manager.
   */
  async myTeam(orgId: string, userId: string, cycleId?: string): Promise<Record<string, unknown>> {
    const me = await this.prisma.employee.findFirst({
      where: { userId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (!me) return { isManager: false, reports: [] };
    const reports = await this.prisma.employee.findMany({
      where: { lineManagerId: me.id, organizationId: orgId, deletedAt: null },
      include: { user: { select: { fullName: true, email: true } }, designation: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const target = await this.targetScore(orgId);
    const team = await Promise.all(
      reports.map(async (r) => {
        const comps = await this.byCompetency(orgId, r.id, cycleId);
        const overall = comps.length ? Math.round((comps.reduce((s, c) => s + c.score, 0) / comps.length) * 100) / 100 : null;
        const sorted = [...comps].sort((a, b) => b.score - a.score);
        return {
          employeeId: r.id,
          name: r.user.fullName ?? r.user.email,
          designation: r.designation?.name ?? null,
          overallScore: overall,
          target,
          topStrength: sorted[0]?.competency ?? null,
          focusArea: sorted.length ? sorted[sorted.length - 1].competency : null,
          belowTarget: overall !== null && overall < target,
          competenciesRated: comps.length,
        };
      }),
    );
    return { isManager: true, target, reports: team };
  }

  /** Target/expected competency score (config 'reports'/'target_score', default 4). */
  private async targetScore(orgId: string): Promise<number> {
    const row = await this.prisma.configuration.findFirst({
      where: { organizationId: orgId, module: 'reports', key: 'target_score', deletedAt: null },
      select: { value: true },
    });
    const value = row?.value;
    return typeof value === 'number' ? value : DEFAULT_TARGET;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback rules (F-C4)                                               */
  /* ------------------------------------------------------------------ */
  /**
   * The two numbers that define a 360 programme — the anonymity threshold and the
   * target score — were previously only settable by a developer writing raw config
   * keys, so an organization could not run its own programme. They are exposed here
   * as typed, admin-editable settings over the SAME existing configuration store, so
   * nothing about how they are consumed at runtime changes.
   */
  async getFeedbackRules(orgId: string): Promise<Record<string, unknown>> {
    const comparison = await this.comparisonRules(orgId);
    return {
      targetScore: await this.targetScore(orgId),
      minResponsesToShow: await this.minResponses(orgId),
      aggregateVisibility: await this.aggregateVisibility(orgId),
      // Shared-competency comparison thresholds (same config store, same screen).
      ...comparison,
      defaults: {
        targetScore: DEFAULT_TARGET,
        minResponsesToShow: DEFAULT_MIN_RESPONSES,
        aggregateVisibility: DEFAULT_AGGREGATE_VISIBILITY,
        gapModerate: DEFAULT_GAP_MODERATE,
        gapPronounced: DEFAULT_GAP_PRONOUNCED,
        consensusSdLow: DEFAULT_CONSENSUS_SD_LOW,
        consensusSdHigh: DEFAULT_CONSENSUS_SD_HIGH,
        comparisonMinQuadrants: DEFAULT_COMPARISON_MIN_QUADRANTS,
      },
    };
  }

  /**
   * Who may see organisation-wide aggregate reports — department/campus scorecards,
   * trends and heatmaps (F15).
   *
   * These carry no individual's score, so many organisations are happy for every
   * report viewer to see them; others treat "which department scored lowest" as
   * management information. Rather than guess, this is a setting. The default keeps
   * the existing behaviour so no one's dashboards change under them on upgrade.
   */
  async aggregateVisibility(orgId: string): Promise<AggregateVisibility> {
    const row = await this.prisma.configuration.findFirst({
      where: { organizationId: orgId, module: 'reports', key: 'aggregate_visibility', deletedAt: null },
      select: { value: true },
    });
    return row?.value === 'executives_only' ? 'executives_only' : DEFAULT_AGGREGATE_VISIBILITY;
  }

  /** Throw 403 when org-wide aggregates are restricted and the caller isn't privileged. */
  async assertAggregateVisible(user: AuthUser): Promise<void> {
    if ((user.permissions ?? []).includes(REPORTS_PERMISSIONS.executive)) return;
    if ((await this.aggregateVisibility(user.organizationId)) === 'executives_only') {
      throw new ForbiddenException(
        'Organisation-wide reports are restricted to executive and HR users in this organisation.',
      );
    }
  }

  async setFeedbackRules(
    orgId: string,
    actorUserId: string,
    input: {
      targetScore?: number;
      minResponsesToShow?: number;
      aggregateVisibility?: AggregateVisibility;
      gapModerate?: number;
      gapPronounced?: number;
      consensusSdLow?: number;
      consensusSdHigh?: number;
      comparisonMinQuadrants?: number;
    },
  ): Promise<Record<string, unknown>> {
    if (input.targetScore !== undefined) {
      await this.upsertReportConfig(orgId, actorUserId, 'target_score', input.targetScore);
    }
    if (input.minResponsesToShow !== undefined) {
      await this.upsertReportConfig(orgId, actorUserId, 'min_responses_to_show', input.minResponsesToShow);
    }
    // Comparison thresholds. Clamped to sane ranges: a negative or absurd threshold
    // would either flag everything or nothing, and both read as a broken report.
    const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
    if (input.gapModerate !== undefined) {
      await this.upsertReportConfig(orgId, actorUserId, 'gap_moderate', clamp(input.gapModerate, 0.05, 3));
    }
    if (input.gapPronounced !== undefined) {
      await this.upsertReportConfig(orgId, actorUserId, 'gap_pronounced', clamp(input.gapPronounced, 0.1, 4));
    }
    if (input.consensusSdLow !== undefined) {
      await this.upsertReportConfig(orgId, actorUserId, 'consensus_sd_low', clamp(input.consensusSdLow, 0.01, 2));
    }
    if (input.consensusSdHigh !== undefined) {
      await this.upsertReportConfig(orgId, actorUserId, 'consensus_sd_high', clamp(input.consensusSdHigh, 0.05, 3));
    }
    if (input.comparisonMinQuadrants !== undefined) {
      await this.upsertReportConfig(orgId, actorUserId, 'comparison_min_quadrants', clamp(Math.floor(input.comparisonMinQuadrants), 2, 6));
    }
    if (input.aggregateVisibility !== undefined) {
      const value: AggregateVisibility =
        input.aggregateVisibility === 'executives_only' ? 'executives_only' : 'all_report_viewers';
      await this.upsertReportConfig(orgId, actorUserId, 'aggregate_visibility', value);
    }
    return this.getFeedbackRules(orgId);
  }

  private async upsertReportConfig(orgId: string, actorUserId: string, key: string, value: number | string): Promise<void> {
    const existing = await this.prisma.configuration.findFirst({
      where: { organizationId: orgId, module: 'reports', key, deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      await this.prisma.configuration.update({ where: { id: existing.id }, data: { value, updatedBy: actorUserId } });
    } else {
      await this.prisma.configuration.create({
        data: { organizationId: orgId, module: 'reports', key, value, createdBy: actorUserId, updatedBy: actorUserId },
      });
    }
  }
}
