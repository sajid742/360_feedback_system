import { useEffect, useMemo, useState } from 'react';
import type { EChartsOption } from 'echarts';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/shared/StatCard';
import { EChart } from '@/lib/echart';
import { ApiError } from '@/lib/api-client';
import { reportsApi, type Employee360, type Heatmap, type Individual, type Radar, type SharedCompetencies, type SharedCompetencyRow } from './api';

/* ------------------------------------------------------------------ *
 * Colour decisions
 *
 * Two series (employee vs benchmark) use the app's existing brand pair. It was
 * validated for colour-vision separation (worst adjacent ΔE 24 deutan / 28 normal)
 * and both series are direct-labelled, which covers the light-surface contrast
 * relief the teal needs.
 *
 * The heatmap reuses the SAME three colours the readiness doughnut already uses,
 * with the SAME thresholds (Ready ≥ target, Developing within 1 below, At risk
 * more than 1 below). Consistency across the product matters more here than
 * re-deriving a scale, and colour is never the only cue: every cell prints its
 * score and every band is named in the legend.
 * ------------------------------------------------------------------ */
const SERIES_MAIN = '#6d5dfc';
const SERIES_BENCH = '#46c2cb';
const BAND_READY = '#10b981';
const BAND_DEVELOPING = '#f5a524';
const BAND_AT_RISK = '#fb7185';
const NEUTRAL = '#94a3b8';

const ALL = '__all__';

/**
 * Individual 360 performance analysis for executives.
 *
 * Everything shown is derived from endpoints that already exist and already apply
 * the product's rules — `/reports/individual` (overall score, per-quadrant scores
 * with anonymity suppression, per-competency scores, gap vs target, strengths),
 * `/reports/radar` (the competency × quadrant matrix plus the organisation
 * benchmark), `/reports/employee-360` (cross-cycle history and reviewer coverage)
 * and `/reports/heatmap` (competency × department, used for the unit benchmark).
 *
 * No score is recomputed and no threshold is invented: readiness bands come from
 * the organisation's configured target score, and suppression decisions arrive
 * already applied from the server.
 */
export function IndividualPerformance({
  employeeId,
  cycleId,
}: {
  employeeId: string;
  cycleId?: string;
}): JSX.Element {
  const [individual, setIndividual] = useState<Individual | null>(null);
  const [radar, setRadar] = useState<Radar | null>(null);
  const [extra, setExtra] = useState<Employee360 | null>(null);
  const [heatmap, setHeatmap] = useState<Heatmap | null>(null);
  const [sharedComp, setSharedComp] = useState<SharedCompetencies | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quadrant, setQuadrant] = useState<string>(ALL);

  useEffect(() => {
    let cancelled = false;
    setIndividual(null); setRadar(null); setExtra(null); setHeatmap(null); setSharedComp(null);
    setError(null); setQuadrant(ALL);
    Promise.all([
      reportsApi.individual(employeeId, cycleId),
      reportsApi.radar(employeeId, cycleId).catch(() => null),
      reportsApi.employee360(employeeId, cycleId).catch(() => null),
      // Department benchmark is a bonus: it depends on the org-wide aggregate
      // visibility setting, so a restricted viewer simply doesn't get it.
      reportsApi.heatmap(cycleId).catch(() => null),
      reportsApi.sharedCompetencies(employeeId, cycleId).catch(() => null),
    ])
      .then(([ind, rad, ex, hm, sc]) => {
        if (cancelled) return;
        setIndividual(ind); setRadar(rad); setExtra(ex); setHeatmap(hm); setSharedComp(sc);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(
          e instanceof ApiError && e.status === 403
            ? 'These results have not been released yet, or you do not have access to this employee.'
            : 'This employee’s 360 results could not be loaded.',
        );
      });
    return () => { cancelled = true; };
  }, [employeeId, cycleId]);

  /* ---------------- derived, all from existing payloads ---------------- */

  const target = individual?.gap?.[0]?.expected ?? 4;

  // Quadrants the employee actually has feedback for. Suppressed ones keep their
  // row so the executive knows they exist, but never carry a score.
  const quadrants = individual?.bySource ?? [];
  const scored = quadrants.filter((q) => !q.suppressed && q.score != null);
  const suppressed = quadrants.filter((q) => q.suppressed);
  // Quadrants under the threshold that this viewer is nonetheless allowed to see —
  // the employee and their colleagues do not see these.
  const belowThreshold = quadrants.filter(
    (q) => !q.suppressed && q.reviewers > 0 && q.reviewers < (individual?.minResponses ?? 0) && q.source !== 'Self',
  );

  // The competency × quadrant matrix, straight from /reports/radar. The
  // organisation benchmark arrives as an extra series and is held out.
  const matrix = useMemo(() => {
    const competencies = radar?.competencies ?? [];
    const series = (radar?.series ?? []).filter((s) => s.name !== 'Organisation average');
    const orgAvg = (radar?.series ?? []).find((s) => s.name === 'Organisation average');
    return { competencies, series, orgAvg };
  }, [radar]);

  // Source code per label, so "Self" is identified the way the server does it
  // (by code) rather than by matching an English label.
  const codeByLabel = useMemo(
    () => new Map((extra?.sourceStatus ?? []).map((s) => [s.source, s.code])),
    [extra],
  );
  const selfSeries = matrix.series.find((s) => codeByLabel.get(s.name) === 'self');
  const otherSeries = matrix.series.filter((s) => codeByLabel.get(s.name) !== 'self');

  // Department benchmark per competency, lifted out of the existing org-wide
  // competency × department heatmap — no extra query.
  const deptAvg = useMemo(() => {
    const dept = individual?.employee.department;
    if (!heatmap || !dept) return null;
    const di = heatmap.departments.indexOf(dept);
    if (di < 0) return null;
    const out = new Map<string, number>();
    for (const [dIdx, cIdx, value] of heatmap.data) {
      if (dIdx === di && value != null) out.set(heatmap.competencies[cIdx], value);
    }
    return out.size > 0 ? out : null;
  }, [heatmap, individual]);

  // Blind spots: how far self-assessment sits above or below everyone else, per
  // competency. Banded with the same magnitudes the gap analysis already uses
  // (>= 1.0 pronounced, >= 0.5 moderate) rather than a new rule.
  const selfVsOthers = useMemo(() => {
    if (!selfSeries || otherSeries.length === 0) return [];
    return matrix.competencies
      .map((competency, i) => {
        const selfScore = selfSeries.values[i];
        const others = otherSeries.map((s) => s.values[i]).filter((v): v is number => v != null);
        if (selfScore == null || others.length === 0) return null;
        const othersAvg = others.reduce((a, b) => a + b, 0) / others.length;
        return { competency, diff: Math.round((selfScore - othersAvg) * 100) / 100, selfScore, othersAvg: Math.round(othersAvg * 100) / 100 };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.diff - a.diff);
  }, [selfSeries, otherSeries, matrix.competencies]);

  /**
   * What a blank cell in the competency x quadrant matrix means.
   *
   * Precedence matters: a score always wins. A quadrant whose questionnaire has since
   * been changed can still hold answers from before the change, and those are real data
   * that must not be hidden behind a "not assessed" label.
   *   scored        - there is a number
   *   withheld      - asked, but too few reviewers responded to show it (anonymity rule)
   *   not_assessed  - this quadrant's questionnaire never covered this competency
   *   no_data       - asked, allowed to show, but nothing came back
   */
  const cellState = useMemo(() => {
    const withheld = new Set(radar?.withheldSources ?? []);
    const assessedBy = radar?.assessedBy ?? {};
    return (competency: string, source: string, value: number | null): 'scored' | 'withheld' | 'not_assessed' | 'no_data' => {
      if (value != null) return 'scored';
      if (withheld.has(source)) return 'withheld';
      const list = assessedBy[competency];
      if (list && !list.includes(source)) return 'not_assessed';
      return 'no_data';
    };
  }, [radar]);

  const hasNotAssessed = useMemo(() => {
    if (!radar?.assessedBy) return false;
    return matrix.competencies.some((c, i) =>
      matrix.series.some((sr) => cellState(c, sr.name, sr.values[i]) === 'not_assessed'),
    );
  }, [radar, matrix, cellState]);

  // Shared competencies, ordered by how far apart the groups are — the reading order
  // for a feedback conversation. Only rows the server judged comparable get a verdict.
  const sharedRows = useMemo(() => (sharedComp?.items ?? []).filter((r) => r.shared), [sharedComp]);
  const consensusRows = useMemo(
    () => sharedRows.filter((r) => r.comparable && r.sd != null).sort((a, b) => (a.sd ?? 0) - (b.sd ?? 0)),
    [sharedRows],
  );
  const [pairA, setPairA] = useState<string>('');
  const [pairB, setPairB] = useState<string>('');
  const comparableQuadrants = useMemo(() => {
    const names = new Set<string>();
    for (const r of sharedRows) for (const q of r.quadrants) if (q.state === 'scored') names.add(q.source);
    return [...names].sort();
  }, [sharedRows]);

  // Competencies whose "all quadrants combined" score does not actually come from every
  // group — the direct consequence of allowing different questionnaires per quadrant.
  const scoredQuadrantCount = scored.filter((q) => q.source !== 'Self').length + (scored.some((q) => q.source === 'Self') ? 1 : 0);
  const partialCompetencies = useMemo(
    () =>
      (individual?.byCompetency ?? []).filter(
        (c) => typeof c.quadrants === 'number' && c.quadrants > 0 && c.quadrants < scoredQuadrantCount,
      ) as { competency: string; quadrants: number }[],
    [individual, scoredQuadrantCount],
  );

  const trend = (extra?.trend ?? []).filter((t) => t.score != null);
  const totalResponses = (extra?.sourceStatus ?? []).reduce((n, s) => n + s.submitted, 0);

  /* ------------------------------- render ------------------------------- */

  if (error) return <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{error}</p>;
  if (!individual) return <Skeleton className="h-96 w-full" />;

  const band = (score: number | null): { label: string; color: string; variant: 'success' | 'warning' | 'danger' | 'neutral' } => {
    if (score == null) return { label: 'No data', color: NEUTRAL, variant: 'neutral' };
    if (score >= target) return { label: 'Ready', color: BAND_READY, variant: 'success' };
    if (score >= target - 1) return { label: 'Developing', color: BAND_DEVELOPING, variant: 'warning' };
    return { label: 'At risk', color: BAND_AT_RISK, variant: 'danger' };
  };
  const overallBand = band(individual.overallScore);
  const delta =
    individual.overallScore != null && individual.previousOverall != null
      ? Math.round((individual.overallScore - individual.previousOverall) * 100) / 100
      : null;

  // Whether a real comparison group exists for the currently shown competencies —
  // used to explain an absent benchmark rather than leaving it silently missing.
  const benchmarkGroup = (() => {
    const rows = quadrant === ALL ? individual.byCompetency : [];
    if (rows.length === 0) return true; // per-quadrant view carries no benchmark by design
    const own = rows.map((r) => r.score);
    const dept = deptAvg ? rows.map((r) => deptAvg.get(r.competency) ?? null) : null;
    const org = matrix.orgAvg
      ? rows.map((r) => {
          const i = matrix.competencies.indexOf(r.competency);
          return i >= 0 ? matrix.orgAvg!.values[i] : null;
        })
      : null;
    const usable = (b: (number | null)[] | null): boolean => {
      if (!b || !b.some((v) => v != null)) return false;
      const pairs = own.map((v, i) => [v, b[i]] as const).filter((x) => x[1] != null);
      return pairs.length > 0 && !pairs.every(([a, x]) => Math.abs(a - (x as number)) < 0.01);
    };
    return usable(dept) || usable(org);
  })();

  // Competency detail for the selected quadrant (or the aggregate across all).
  const detail = (() => {
    if (quadrant === ALL) {
      return individual.byCompetency.map((c) => ({ competency: c.competency, score: c.score }));
    }
    const s = matrix.series.find((x) => x.name === quadrant);
    if (!s) return [];
    return matrix.competencies
      .map((competency, i) => ({ competency, score: s.values[i] }))
      .filter((r): r is { competency: string; score: number } => r.score != null);
  })();

  return (
    <div className="grid gap-6">
      {/* ---- Headline ---- */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Overall score"
          value={individual.overallScore?.toFixed(2) ?? '—'}
          hint={`${overallBand.label} · target ${target}`}
          tone={overallBand.variant === 'success' ? 'teal' : overallBand.variant === 'warning' ? 'amber' : 'brand'}
        />
        <StatCard
          label="vs previous cycle"
          value={delta != null ? `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}` : '—'}
          hint={individual.previousOverall != null ? `was ${individual.previousOverall.toFixed(2)}` : 'no earlier cycle'}
          tone="brand"
        />
        <StatCard
          label="Quadrants with feedback"
          value={String(quadrants.length)}
          hint={suppressed.length > 0 ? `${scored.length} shown · ${suppressed.length} confidential` : 'all shown'}
          tone="brand"
        />
        <StatCard label="Responses received" value={totalResponses > 0 ? String(totalResponses) : '—'} hint="across all quadrants" tone="brand" />
      </div>

      {quadrants.length === 0 ? (
        <Note>No feedback has been submitted for this employee{cycleId ? ' in this cycle' : ''} yet.</Note>
      ) : (
        <>
          {/* ---- 1. Overall vs quadrant scores ---- */}
          <Panel
            title="Overall score vs each quadrant"
            hint="Which rater groups pull the overall score up or down. Select a quadrant to see the competencies behind it."
          >
            {scored.length === 0 ? (
              <Note>
                Every quadrant is below the {individual.minResponses}-response confidentiality threshold, so no
                per-quadrant score can be shown.
              </Note>
            ) : (
              <EChart
                height={Math.max(200, scored.length * 52 + 70)}
                onClick={(p) => setQuadrant((cur) => (cur === p.name ? ALL : p.name))}
                option={quadrantBarOption(scored, individual.overallScore, target, quadrant, extra)}
              />
            )}
            <Legend
              items={[
                { color: SERIES_MAIN, label: 'Quadrant score' },
                { color: NEUTRAL, label: `Overall ${individual.overallScore?.toFixed(2) ?? '—'} (dashed)` },
                { color: BAND_DEVELOPING, label: `Target ${target} (dotted)` },
              ]}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              Each bar is the average rating from that quadrant. The overall score is a weighted average across
              quadrants and may include an HR calibration, so it will not always sit at the mean of these bars.
            </p>
          </Panel>

          {/* ---- 2. Competency detail for the selected quadrant ---- */}
          <Panel
            title={quadrant === ALL ? 'Competency scores — all quadrants combined' : `Competency scores — ${quadrant}`}
            action={
              <select
                value={quadrant}
                onChange={(e) => setQuadrant(e.target.value)}
                className="h-8 rounded-md border border-input bg-card px-2 text-xs"
              >
                <option value={ALL}>All quadrants combined</option>
                {matrix.series.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
            }
          >
            {quadrant === ALL && partialCompetencies.length > 0 ? (
              <Note>
                Not every evaluator group is asked about every competency, so a combined score can rest on
                one perspective. {partialCompetencies.map((c) => `${c.competency} (${c.quadrants} of ${scoredQuadrantCount} groups)`).join(', ')}.
                Use the selector above, or the shared-competency table below, to see each group separately.
              </Note>
            ) : null}
            {detail.length === 0 ? (
              <Note>No competency scores for this quadrant.</Note>
            ) : (
              <>
                <EChart
                  height={Math.max(200, detail.length * 46 + 80)}
                  option={competencyBarOption(detail, target, quadrant === ALL ? matrix.orgAvg : undefined, matrix.competencies, quadrant === ALL ? deptAvg : null, individual.employee.department)}
                />
                {benchmarkGroup ? null : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    No comparison group yet — this employee is currently the only scored person in their
                    {individual.employee.department ? ` ${individual.employee.department} ` : ' '}group for this cycle.
                  </p>
                )}
                <CompetencyTable rows={detail} target={target} band={band} />
              </>
            )}
          </Panel>

          {/* ---- 3. Competency × quadrant heatmap ---- */}
          {matrix.series.length > 0 && matrix.competencies.length > 0 ? (
            <Panel
              title="Competency × quadrant heatmap"
              hint="Strong and weak competencies at a glance, and where quadrants disagree. Select a cell to focus that quadrant."
            >
              <EChart
                height={Math.max(220, matrix.competencies.length * 42 + 120)}
                onClick={(p) => {
                  const idx = Array.isArray(p.value) ? Number(p.value[0]) : NaN;
                  const name = matrix.series[idx]?.name;
                  if (name) setQuadrant((cur) => (cur === name ? ALL : name));
                }}
                option={heatmapOption(matrix.competencies, matrix.series, target)}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                Bands use the organisation&rsquo;s configured target of {target}: Ready at or above target,
                Developing within 1 point below, At risk more than 1 point below.
              </p>
              {/* A blank cell has three quite different meanings. Spelling them out stops a
                  deliberately narrow questionnaire being read as missing or censored data. */}
              <ul className="mt-1 grid gap-0.5 text-xs text-muted-foreground">
                <li><span className="font-medium text-foreground">Scored</span> — the cell shows the group&rsquo;s average.</li>
                {(radar?.withheldSources?.length ?? 0) > 0 ? (
                  <li>
                    <span className="font-medium text-foreground">Withheld</span> — {radar?.withheldSources?.join(', ')} had fewer
                    than {individual.minResponses} responses, so the score stays confidential.
                  </li>
                ) : null}
                {hasNotAssessed ? (
                  <li>
                    <span className="font-medium text-foreground">Not assessed</span> — that evaluator group&rsquo;s
                    questionnaire does not cover the competency, so there is nothing to show. This is configuration,
                    not missing data.
                  </li>
                ) : null}
              </ul>
            </Panel>
          ) : null}

          {/* ---- 4. Self-awareness / blind spots ---- */}
          {selfVsOthers.length > 0 ? (
            <Panel
              title="Self-assessment vs everyone else"
              hint="Where the employee rates themselves higher than others do (a potential blind spot) or lower (a hidden strength)."
            >
              <EChart height={Math.max(200, selfVsOthers.length * 46 + 70)} option={blindSpotOption(selfVsOthers)} />
              <Legend
                items={[
                  { color: SERIES_MAIN, label: 'Self rates higher — potential blind spot' },
                  { color: SERIES_BENCH, label: 'Self rates lower — hidden strength' },
                ]}
              />
              <ul className="mt-2 grid gap-1 text-xs text-muted-foreground">
                {selfVsOthers
                  .filter((r) => Math.abs(r.diff) >= 0.5)
                  .map((r) => (
                    <li key={r.competency}>
                      <span className="font-medium text-foreground">{r.competency}</span>: self {r.selfScore.toFixed(2)} vs
                      others {r.othersAvg.toFixed(2)} — {Math.abs(r.diff) >= 1 ? 'pronounced' : 'moderate'}{' '}
                      {r.diff > 0 ? 'blind spot' : 'hidden strength'}.
                    </li>
                  ))}
                {selfVsOthers.every((r) => Math.abs(r.diff) < 0.5) ? <li>Self-assessment is closely aligned with other quadrants.</li> : null}
              </ul>
            </Panel>
          ) : null}

          {/* ---- 4b. Shared competencies across evaluator groups ---- */}
          {sharedRows.length > 0 && sharedComp ? (
            <Panel
              title="Shared competencies — how the groups compare"
              hint="Competencies assessed by two or more evaluator groups. Each group keeps its own score; nothing is averaged away."
            >
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                      <th className="py-2 pr-3">Competency</th>
                      {comparableQuadrants.map((q) => <th key={q} className="px-2 py-2 text-right">{q}</th>)}
                      <th className="px-2 py-2 text-right">Spread</th>
                      <th className="px-2 py-2">Reading</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sharedRows.map((r) => (
                      <tr key={r.competency} className="border-b border-border/60 align-top">
                        <td className="py-2 pr-3 font-medium">{r.competency}</td>
                        {comparableQuadrants.map((name) => {
                          const cell = r.quadrants.find((q) => q.source === name);
                          return (
                            <td key={name} className="px-2 py-2 text-right tabular-nums">
                              {cell?.state === 'scored' && cell.score != null ? (
                                <>
                                  {cell.score.toFixed(2)}
                                  <span className="ml-1 text-[11px] text-muted-foreground">n={cell.reviewers}</span>
                                </>
                              ) : cell?.state === 'withheld' ? (
                                <span className="text-[11px] text-muted-foreground">withheld</span>
                              ) : cell?.state === 'no_responses' ? (
                                <span className="text-[11px] text-muted-foreground">no replies</span>
                              ) : (
                                <span className="text-[11px] text-muted-foreground">not assessed</span>
                              )}
                            </td>
                          );
                        })}
                        <td className="px-2 py-2 text-right tabular-nums">{r.spread != null ? r.spread.toFixed(2) : '—'}</td>
                        <td className="px-2 py-2">
                          {r.comparable ? (
                            r.findings.length > 0 ? (
                              <ul className="grid gap-0.5">
                                {r.findings.map((f) => (
                                  <li key={f.kind} className="text-xs">
                                    <span className="font-medium text-foreground">{f.label}</span>
                                    <span className="text-muted-foreground"> — {f.detail}</span>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <span className="text-xs text-muted-foreground">No notable difference.</span>
                            )
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              Fewer than {sharedComp.rules.comparisonMinQuadrants} groups available — scores shown, no comparison drawn.
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                A competency counts as shared when two or more evaluator groups are asked about it — that comes from the
                questionnaires attached to each group, not a separate setting. Differences of {sharedComp.rules.gapModerate} or
                more are worth noting, {sharedComp.rules.gapPronounced} or more worth investigating; both are configurable in
                Settings. <span className="font-medium text-foreground">n</span> is the number of reviewers behind each score —
                treat a gap between two small groups with care.
              </p>
            </Panel>
          ) : null}

          {/* ---- 4c. Perception spread + consensus ranking ---- */}
          {consensusRows.length > 1 ? (
            <Panel
              title="Where the groups agree, and where they do not"
              hint="Competencies ranked by how closely the evaluator groups agree. Widest disagreement at the bottom."
            >
              <EChart height={Math.max(200, consensusRows.length * 34 + 80)} option={spreadOption(consensusRows)} />
              <p className="mt-2 text-xs text-muted-foreground">
                Each line runs from the lowest-scoring group to the highest, with the marker showing the average of the
                other groups. A short line means the groups see this person the same way; a long one means the answer
                depends on who you ask.
              </p>
            </Panel>
          ) : null}

          {/* ---- 4d. Compare two groups directly ---- */}
          {comparableQuadrants.length >= 2 && sharedRows.length > 0 ? (
            <Panel
              title="Compare two evaluator groups"
              hint="The classic managerial check: how the line manager sees someone versus how their team does."
            >
              <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                <select
                  value={pairA || comparableQuadrants[0]}
                  onChange={(e) => setPairA(e.target.value)}
                  className="h-9 rounded-md border border-input bg-card px-2 text-sm"
                >
                  {comparableQuadrants.map((q) => <option key={q} value={q}>{q}</option>)}
                </select>
                <span className="text-muted-foreground">vs</span>
                <select
                  value={pairB || comparableQuadrants[1]}
                  onChange={(e) => setPairB(e.target.value)}
                  className="h-9 rounded-md border border-input bg-card px-2 text-sm"
                >
                  {comparableQuadrants.map((q) => <option key={q} value={q}>{q}</option>)}
                </select>
              </div>
              {(() => {
                const a = pairA || comparableQuadrants[0];
                const b = pairB || comparableQuadrants[1];
                const rows = sharedRows
                  .map((r) => {
                    const ca = r.quadrants.find((q) => q.source === a);
                    const cb = r.quadrants.find((q) => q.source === b);
                    if (ca?.state !== 'scored' || cb?.state !== 'scored' || ca.score == null || cb.score == null) return null;
                    return { competency: r.competency, a: ca.score, b: cb.score, diff: Math.round((ca.score - cb.score) * 100) / 100 };
                  })
                  .filter((r): r is NonNullable<typeof r> => r !== null)
                  .sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
                if (rows.length === 0) {
                  return <Note>These two groups have no competency in common with scores that can be shown.</Note>;
                }
                return (
                  <ul className="grid gap-1 text-sm">
                    {rows.map((r) => (
                      <li key={r.competency} className="flex items-center justify-between gap-3 border-b border-border/60 py-1.5">
                        <span className="font-medium">{r.competency}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {a} {r.a.toFixed(2)} · {b} {r.b.toFixed(2)}
                          <span className={`ml-2 font-semibold ${Math.abs(r.diff) >= (sharedComp?.rules.gapPronounced ?? 1) ? 'text-danger' : 'text-foreground'}`}>
                            {r.diff > 0 ? '+' : ''}{r.diff.toFixed(2)}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                );
              })()}
            </Panel>
          ) : null}

          {/* ---- 5. Trend ---- */}
          {trend.length > 1 ? (
            <Panel title="Score across feedback cycles" hint="Direction of travel across completed cycles.">
              <EChart height={240} option={trendOption(trend, target)} />
              <p className="mt-2 text-xs text-muted-foreground">
                Cycles are only strictly comparable when they used the same questionnaires and quadrant weights. If a
                cycle&rsquo;s configuration changed, read a movement as a prompt to look closer rather than as a
                like-for-like difference.
              </p>
            </Panel>
          ) : null}

          {/* ---- 6. Reviewer coverage ---- */}
          {extra && extra.sourceStatus.length > 0 ? (
            <Panel title="Reviewer coverage" hint="How many reviewers responded in each quadrant. Counts only — reviewers are never identified.">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {extra.sourceStatus.map((s) => {
                  const q = quadrants.find((x) => x.source === s.source);
                  return (
                    <div key={s.source} className="rounded-md border border-border px-3 py-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{s.source}</span>
                        <Badge variant={s.pending === 0 ? 'success' : s.submitted === 0 ? 'danger' : 'warning'}>{s.completionPct}%</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {s.submitted} of {s.assigned} responded
                        {q?.suppressed ? ` · confidential below ${individual.minResponses}` : ''}
                        {!q?.suppressed && individual.confidentialUnlocked && q && q.reviewers > 0 && q.reviewers < individual.minResponses
                          ? ` · below ${individual.minResponses} — shown to you only`
                          : ''}
                      </p>
                    </div>
                  );
                })}
              </div>
            </Panel>
          ) : null}

          {suppressed.length > 0 ? (
            <Note>
              Kept confidential (fewer than {individual.minResponses} responses): {suppressed.map((s) => s.source).join(', ')}.
              Their scores appear once enough people have responded, and they are excluded from the charts above.
            </Note>
          ) : null}

          {individual.confidentialUnlocked && belowThreshold.length > 0 ? (
            <Note>
              Elevated view: {belowThreshold.map((s) => s.source).join(', ')}{' '}
              {belowThreshold.length === 1 ? 'has' : 'have'} fewer than {individual.minResponses} responses and{' '}
              {belowThreshold.length === 1 ? 'is' : 'are'} hidden from the employee and from colleagues. You can see{' '}
              {belowThreshold.length === 1 ? 'it' : 'them'} because your role permits it. Individual reviewers are still
              never identified, and this view is recorded in the audit trail.
            </Note>
          ) : null}
        </>
      )}
    </div>
  );
}

/* ------------------------------ chart options ------------------------------ */

function quadrantBarOption(
  scored: { source: string; score: number | null; reviewers: number }[],
  overall: number | null,
  target: number,
  selected: string,
  extra: Employee360 | null,
): EChartsOption {
  const statusBy = new Map((extra?.sourceStatus ?? []).map((s) => [s.source, s]));
  const marks: { xAxis: number; lineStyle: Record<string, unknown>; label: Record<string, unknown> }[] = [];
  if (overall != null) marks.push({ xAxis: overall, lineStyle: { color: NEUTRAL, type: 'dashed', width: 2 }, label: { formatter: 'Overall', position: 'insideEndTop', color: NEUTRAL } });
  marks.push({ xAxis: target, lineStyle: { color: BAND_DEVELOPING, type: 'dotted', width: 2 }, label: { formatter: 'Target', position: 'insideEndBottom', color: BAND_DEVELOPING } });
  return {
    grid: { left: 118, right: 56, top: 12, bottom: 28 },
    xAxis: { type: 'value', min: 0, max: 5, splitLine: { lineStyle: { opacity: 0.25 } } },
    yAxis: { type: 'category', data: scored.map((s) => s.source) },
    tooltip: {
      trigger: 'item',
      formatter: (params: unknown) => {
        const p = (Array.isArray(params) ? params[0] : params) as { name?: string; value?: unknown };
        const name = String(p?.name ?? '');
        const st = statusBy.get(name);
        const row = scored.find((s) => s.source === name);
        return `${name}<br/><b>${String(p?.value ?? '')}</b><br/>${row?.reviewers ?? 0} response${row?.reviewers === 1 ? '' : 's'}${st ? ` · ${st.submitted}/${st.assigned} reviewers` : ''}`;
      },
    },
    series: [
      {
        type: 'bar',
        data: scored.map((s) => ({
          value: s.score,
          itemStyle: { color: SERIES_MAIN, opacity: selected === '__all__' || selected === s.source ? 1 : 0.35, borderRadius: [0, 4, 4, 0] },
        })),
        barMaxWidth: 26,
        label: { show: true, position: 'right', formatter: '{c}' },
        markLine: { silent: true, symbol: 'none', data: marks },
      },
    ],
  };
}

/** True when a benchmark adds nothing — every value matches the employee's own. */
function isDegenerate(own: number[], bench: (number | null)[]): boolean {
  const pairs = own.map((v, i) => [v, bench[i]] as const).filter((x) => x[1] != null);
  return pairs.length > 0 && pairs.every(([a, b]) => Math.abs(a - (b as number)) < 0.01);
}

function competencyBarOption(
  detail: { competency: string; score: number }[],
  target: number,
  orgAvg: { name: string; values: (number | null)[] } | undefined,
  allCompetencies: string[],
  deptAvg: Map<string, number> | null,
  deptName: string | null,
): EChartsOption {
  const names = detail.map((d) => d.competency);
  const own = detail.map((d) => d.score);
  const bench = orgAvg
    ? names.map((n) => {
        const i = allCompetencies.indexOf(n);
        return i >= 0 ? orgAvg.values[i] : null;
      })
    : null;
  const dept = deptAvg ? names.map((n) => deptAvg.get(n) ?? null) : null;
  const series: EChartsOption['series'] = [
    {
      name: 'This employee',
      type: 'bar',
      data: detail.map((d) => d.score),
      barMaxWidth: 18,
      itemStyle: { color: SERIES_MAIN, borderRadius: [0, 4, 4, 0] },
      label: { show: true, position: 'right', formatter: '{c}' },
      markLine: {
        silent: true,
        symbol: 'none',
        data: [{ xAxis: target, lineStyle: { color: BAND_DEVELOPING, type: 'dotted', width: 2 }, label: { formatter: 'Target', color: BAND_DEVELOPING } }],
      },
    },
  ];
  // A benchmark that simply repeats the employee's own scores means they are the
  // only scored person in that group — drawing twin bars would imply a comparison
  // that does not exist, so it is dropped and explained in the panel instead.
  if (dept && dept.some((v) => v != null) && !isDegenerate(own, dept)) {
    series.push({ name: `${deptName} average`, type: 'bar', data: dept, barMaxWidth: 18, itemStyle: { color: SERIES_BENCH, borderRadius: [0, 4, 4, 0] }, label: { show: true, position: 'right', formatter: '{c}' } });
  } else if (bench && bench.some((v) => v != null) && !isDegenerate(own, bench)) {
    series.push({ name: 'Organisation average', type: 'bar', data: bench, barMaxWidth: 18, itemStyle: { color: SERIES_BENCH, borderRadius: [0, 4, 4, 0] }, label: { show: true, position: 'right', formatter: '{c}' } });
  }
  return {
    grid: { left: 210, right: 64, top: 12, bottom: 44 },
    legend: { bottom: 0, show: series.length > 1 },
    xAxis: { type: 'value', min: 0, max: 5, splitLine: { lineStyle: { opacity: 0.25 } } },
    yAxis: { type: 'category', data: names, axisLabel: { width: 190, overflow: 'break' } },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    series,
  };
}

function heatmapOption(competencies: string[], series: { name: string; values: (number | null)[] }[], target: number): EChartsOption {
  const data: [number, number, number | null][] = [];
  series.forEach((s, si) => {
    competencies.forEach((_c, ci) => data.push([si, ci, s.values[ci]]));
  });
  return {
    grid: { left: 210, right: 24, top: 16, bottom: 78 },
    xAxis: { type: 'category', data: series.map((s) => s.name), splitArea: { show: true } },
    yAxis: { type: 'category', data: competencies, splitArea: { show: true }, axisLabel: { width: 190, overflow: 'break' } },
    tooltip: {
      formatter: (params: unknown) => {
        const p = params as { value?: unknown[] };
        const v = Array.isArray(p?.value) ? p.value : [];
        const score = v[2];
        return `${competencies[Number(v[1])]}<br/>${series[Number(v[0])]?.name}<br/><b>${score == null ? 'not rated' : String(score)}</b>`;
      },
    },
    visualMap: {
      type: 'piecewise',
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      pieces: [
        { min: target, label: `Ready (≥ ${target})`, color: BAND_READY },
        { min: target - 1, max: target, label: `Developing (${target - 1}–${target})`, color: BAND_DEVELOPING },
        { max: target - 1, label: `At risk (< ${target - 1})`, color: BAND_AT_RISK },
      ],
    },
    series: [
      {
        type: 'heatmap',
        data,
        label: {
          show: true,
          formatter: (p: { value?: unknown }) => {
            const v = Array.isArray(p?.value) ? p.value[2] : null;
            return v == null ? '' : String(v);
          },
        },
        itemStyle: { borderColor: '#fff', borderWidth: 2 },
        emphasis: { itemStyle: { shadowBlur: 6, shadowColor: 'rgba(0,0,0,0.25)' } },
      },
    ],
  };
}

/**
 * Perception spread: one line per competency from the lowest-scoring evaluator group to
 * the highest, with a marker at the average of the non-self groups. Ranked by agreement,
 * so the competencies people disagree about sink to the bottom of the chart.
 */
function spreadOption(rows: SharedCompetencyRow[]): EChartsOption {
  const names = rows.map((r) => r.competency);
  const lows = rows.map((r) => r.lowest?.score ?? 0);
  const bars = rows.map((r) => (r.highest && r.lowest ? Math.round((r.highest.score - r.lowest.score) * 100) / 100 : 0));
  const means = rows.map((r, i) => [r.othersMean ?? 0, i]);
  return {
    grid: { left: 8, right: 24, top: 10, bottom: 28, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const list = params as { dataIndex: number }[];
        const r = rows[list?.[0]?.dataIndex ?? 0];
        if (!r) return '';
        const cells = r.quadrants
          .filter((q) => q.state === 'scored' && q.score != null)
          .map((q) => `${q.source}: ${q.score?.toFixed(2)} (n=${q.reviewers})`)
          .join('<br/>');
        return `<b>${r.competency}</b><br/>${cells}`;
      },
    },
    xAxis: { type: 'value', min: 0, max: 5, splitLine: { lineStyle: { opacity: 0.35 } } },
    yAxis: { type: 'category', data: names, axisTick: { show: false } },
    series: [
      // Transparent offset bar puts the visible bar's left edge at the lowest score.
      { type: 'bar', stack: 'spread', silent: true, itemStyle: { color: 'transparent' }, data: lows },
      {
        type: 'bar',
        stack: 'spread',
        barWidth: 10,
        itemStyle: { color: SERIES_BENCH, borderRadius: 5 },
        data: bars,
      },
      {
        type: 'scatter',
        symbolSize: 11,
        itemStyle: { color: SERIES_MAIN },
        data: means,
        tooltip: { show: false },
      },
    ],
  };
}

function blindSpotOption(rows: { competency: string; diff: number }[]): EChartsOption {
  return {
    grid: { left: 210, right: 64, top: 12, bottom: 28 },
    xAxis: { type: 'value', name: 'self − others', splitLine: { lineStyle: { opacity: 0.25 } } },
    yAxis: { type: 'category', data: rows.map((r) => r.competency), axisLabel: { width: 190, overflow: 'break' } },
    tooltip: { trigger: 'item' },
    series: [
      {
        type: 'bar',
        data: rows.map((r) => ({ value: r.diff, itemStyle: { color: r.diff >= 0 ? SERIES_MAIN : SERIES_BENCH, borderRadius: 4 } })),
        barMaxWidth: 22,
        label: {
          show: true,
          position: 'right',
          formatter: (p: { value?: unknown }) => {
            const v = Number(p?.value ?? 0);
            return v >= 0 ? `+${v}` : String(v);
          },
        },
        markLine: { silent: true, symbol: 'none', data: [{ xAxis: 0, lineStyle: { color: NEUTRAL, width: 2 } }] },
      },
    ],
  };
}

function trendOption(trend: { cycle: string; score: number | null }[], target: number): EChartsOption {
  return {
    grid: { left: 44, right: 28, top: 18, bottom: 44 },
    xAxis: { type: 'category', data: trend.map((t) => t.cycle) },
    yAxis: { type: 'value', min: 0, max: 5 },
    tooltip: { trigger: 'axis' },
    series: [
      {
        type: 'line',
        smooth: true,
        symbolSize: 9,
        data: trend.map((t) => t.score),
        itemStyle: { color: SERIES_MAIN },
        lineStyle: { width: 2 },
        label: { show: true, formatter: '{c}' },
        markLine: { silent: true, symbol: 'none', data: [{ yAxis: target, lineStyle: { color: BAND_DEVELOPING, type: 'dotted', width: 2 }, label: { formatter: 'Target', color: BAND_DEVELOPING } }] },
      },
    ],
  };
}

/* --------------------------------- bits --------------------------------- */

function Panel({ title, hint, action, children }: { title: string; hint?: string; action?: React.ReactNode; children: React.ReactNode }): JSX.Element {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold">{title}</h3>
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Legend({ items }: { items: { color: string; label: string }[] }): JSX.Element {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-sm" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/** The table view that the chart's colour-contrast relief obligates. */
function CompetencyTable({
  rows,
  target,
  band,
}: {
  rows: { competency: string; score: number }[];
  target: number;
  band: (s: number | null) => { label: string; variant: 'success' | 'warning' | 'danger' | 'neutral' };
}): JSX.Element {
  return (
    <table className="mt-3 w-full text-sm">
      <thead className="text-left text-xs uppercase text-muted-foreground">
        <tr><th className="py-1">Competency</th><th className="py-1 text-right">Score</th><th className="py-1 text-right">vs target</th><th className="py-1 text-right">Readiness</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const diff = Math.round((r.score - target) * 100) / 100;
          const b = band(r.score);
          return (
            <tr key={r.competency} className="border-t border-border">
              <td className="py-1.5">{r.competency}</td>
              <td className="py-1.5 text-right tabular-nums">{r.score.toFixed(2)}</td>
              <td className="py-1.5 text-right tabular-nums text-muted-foreground">{diff >= 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2)}</td>
              <td className="py-1.5 text-right"><Badge variant={b.variant}>{b.label}</Badge></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Note({ children }: { children: React.ReactNode }): JSX.Element {
  return <p className="rounded-md border border-dashed border-border bg-muted/30 p-4 text-center text-sm text-muted-foreground">{children}</p>;
}
