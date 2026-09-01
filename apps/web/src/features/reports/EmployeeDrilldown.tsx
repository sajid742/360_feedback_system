import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EChart } from '@/lib/echart';
import { ApiError } from '@/lib/api-client';
import { reportsApi, type Employee360, type Individual, type Radar } from './api';

/**
 * Level 3 of the executive drill-down: one employee's 360 feedback.
 *
 * Deliberately composed from endpoints that already exist and already enforce the
 * rules — `/reports/individual` (scores, per-source breakdown with anonymity
 * suppression, strengths, development areas), `/reports/radar` (competency × source
 * with the organisation benchmark) and one supplement, `/reports/employee-360`
 * (cross-cycle history and reviewer coverage). No score is recalculated here; the
 * component only arranges what those endpoints return.
 *
 * What it deliberately does NOT show: reviewer names, individual responses, or any
 * quadrant the employee has no feedback for. Sources below the anonymity threshold
 * arrive already suppressed from the server and are rendered as "Confidential".
 */
export function EmployeeDrilldown({
  employeeId,
  cycleId,
}: {
  employeeId: string;
  cycleId?: string;
}): JSX.Element {
  const [individual, setIndividual] = useState<Individual | null>(null);
  const [radar, setRadar] = useState<Radar | null>(null);
  const [extra, setExtra] = useState<Employee360 | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIndividual(null);
    setRadar(null);
    setExtra(null);
    setError(null);
    Promise.all([
      reportsApi.individual(employeeId, cycleId),
      reportsApi.radar(employeeId, cycleId).catch(() => null),
      reportsApi.employee360(employeeId, cycleId).catch(() => null),
    ])
      .then(([ind, rad, ex]) => {
        if (cancelled) return;
        setIndividual(ind);
        setRadar(rad);
        setExtra(ex);
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

  if (error) return <p className="p-8 text-center text-sm text-muted-foreground">{error}</p>;
  if (!individual) return <div className="p-4"><Skeleton className="h-72 w-full" /></div>;

  // Only quadrants the employee actually has feedback for — never a placeholder row.
  const quadrants = individual.bySource;
  const visible = quadrants.filter((s) => !s.suppressed && s.score != null);
  const suppressed = quadrants.filter((s) => s.suppressed);
  const statusBySource = new Map((extra?.sourceStatus ?? []).map((s) => [s.source, s]));
  const trend = (extra?.trend ?? []).filter((t) => t.score != null);
  const delta =
    individual.overallScore != null && individual.previousOverall != null
      ? Math.round((individual.overallScore - individual.previousOverall) * 100) / 100
      : null;
  // The API returns the top 3 and bottom 3 competencies independently, so when an
  // employee has three or fewer competencies — or scores level across them — both
  // lists come back identical, which reads as a bug to an executive. Show only the
  // competencies that are genuinely weaker than a listed strength.
  const strongest = new Set(individual.strengths.map((s) => s.competency));
  const development = individual.weaknesses.filter((w) => !strongest.has(w.competency));

  return (
    <div className="grid gap-4 p-4">
      {/* Headline numbers */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Overall score" value={individual.overallScore?.toFixed(2) ?? '—'} hint={individual.employee.designation ?? undefined} />
        <Stat
          label="Previous cycle"
          value={individual.previousOverall?.toFixed(2) ?? '—'}
          hint={delta != null ? `${delta >= 0 ? '▲ +' : '▼ '}${Math.abs(delta).toFixed(2)} vs previous` : undefined}
        />
        <Stat label="Feedback sources" value={String(quadrants.length)} hint={`${visible.length} shown, ${suppressed.length} confidential`} />
      </div>

      {quadrants.length === 0 ? (
        <Empty>No feedback has been submitted for this employee{cycleId ? ' in this cycle' : ''} yet.</Empty>
      ) : (
        <>
          {/* Quadrant comparison — the primary executive read */}
          <Section title="Score by feedback source">
            {visible.length === 0 ? (
              <Empty>
                Every source is below the {individual.minResponses}-response confidentiality threshold, so no
                per-source score can be shown.
              </Empty>
            ) : (
              <EChart
                height={Math.max(180, visible.length * 46 + 60)}
                option={{
                  grid: { left: 110, right: 48, top: 10, bottom: 24 },
                  xAxis: { type: 'value', min: 0, max: 5, splitLine: { lineStyle: { opacity: 0.25 } } },
                  yAxis: { type: 'category', data: visible.map((s) => s.source) },
                  tooltip: {
                    trigger: 'item',
                    formatter: (params: unknown) => {
                      const p = (Array.isArray(params) ? params[0] : params) as { name?: string; value?: unknown };
                      const name = String(p?.name ?? '');
                      const st = statusBySource.get(name);
                      const src = visible.find((v) => v.source === name);
                      const responses = src ? `${src.reviewers} response${src.reviewers === 1 ? '' : 's'}` : '';
                      const coverage = st ? ` · ${st.submitted}/${st.assigned} reviewers submitted` : '';
                      return `${name}<br/><b>${String(p?.value ?? '')}</b><br/>${responses}${coverage}`;
                    },
                  },
                  series: [
                    {
                      type: 'bar',
                      data: visible.map((s) => s.score),
                      barMaxWidth: 26,
                      itemStyle: { color: '#6366f1', borderRadius: [0, 4, 4, 0] },
                      label: { show: true, position: 'right', formatter: '{c}' },
                      markLine: {
                        silent: true,
                        symbol: 'none',
                        data: [{ xAxis: 5, label: { show: false } }],
                      },
                    },
                  ],
                }}
              />
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Each bar is the average rating from that source. The overall score is a weighted average across
              sources and may include an HR calibration, so it will not always equal the average of these bars.
            </p>
          </Section>

          {/* Response coverage per quadrant — status without identities */}
          {extra && extra.sourceStatus.length > 0 ? (
            <Section title="Reviewer coverage">
              <div className="grid gap-2 sm:grid-cols-2">
                {extra.sourceStatus.map((s) => (
                  <div key={s.source} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
                    <span className="font-medium">{s.source}</span>
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <span className="tabular-nums">{s.submitted}/{s.assigned} submitted</span>
                      <Badge variant={s.pending === 0 ? 'success' : s.submitted === 0 ? 'danger' : 'warning'}>
                        {s.completionPct}%
                      </Badge>
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">Counts only — individual reviewers are never identified.</p>
            </Section>
          ) : null}

          {/* Competency × source. A radar needs at least three axes to mean anything,
              so with one or two competencies we show the per-competency scores as a
              plain list instead of a degenerate triangle. */}
          {radar && radar.competencies.length > 0 && radar.competencies.length < 3 ? (
            <Section title="Competency scores">
              <ul className="grid gap-1.5 text-sm">
                {individual.byCompetency.map((c) => (
                  <li key={c.competency} className="flex items-center justify-between gap-3">
                    <span>{c.competency}</span>
                    <Badge variant="info">{c.score.toFixed(2)}</Badge>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                A competency radar appears once this cycle&rsquo;s questionnaire covers three or more competencies.
              </p>
            </Section>
          ) : radar && radar.competencies.length >= 3 && radar.series.length > 0 ? (
            <Section title="Competency profile by source">
              <EChart
                height={340}
                option={{
                  legend: { bottom: 0, type: 'scroll' },
                  tooltip: { trigger: 'item' },
                  radar: {
                    indicator: radar.competencies.map((c) => ({ name: c, max: 5 })),
                    radius: '62%',
                  },
                  series: [
                    {
                      type: 'radar',
                      data: radar.series.map((s) => ({
                        name: s.name,
                        value: s.values.map((v) => v ?? 0),
                        areaStyle: s.name === 'Organisation average' ? undefined : { opacity: 0.08 },
                        lineStyle: s.name === 'Organisation average' ? { type: 'dashed' } : undefined,
                      })),
                    },
                  ],
                }}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                Sources below the {individual.minResponses}-response threshold are omitted. The dashed ring is the
                organisation average for the same competencies.
              </p>
            </Section>
          ) : null}

          {/* Cross-cycle trend — only when there is more than one scored cycle */}
          {trend.length > 1 ? (
            <Section title="Score across cycles">
              <EChart
                height={220}
                option={{
                  grid: { left: 40, right: 24, top: 16, bottom: 40 },
                  xAxis: { type: 'category', data: trend.map((t) => t.cycle) },
                  yAxis: { type: 'value', min: 0, max: 5 },
                  tooltip: { trigger: 'axis' },
                  series: [
                    {
                      type: 'line',
                      smooth: true,
                      data: trend.map((t) => t.score),
                      label: { show: true, formatter: '{c}' },
                      itemStyle: { color: '#0ea5e9' },
                    },
                  ],
                }}
              />
            </Section>
          ) : null}

          {/* Strengths / development */}
          <div className="grid gap-3 sm:grid-cols-2">
            <Section title="Top strengths">
              {individual.strengths.length === 0 ? <Empty>Not enough scored competencies yet.</Empty> : (
                <ul className="grid gap-1.5 text-sm">
                  {individual.strengths.map((s) => (
                    <li key={s.competency} className="flex items-center justify-between gap-3">
                      <span>{s.competency}</span>
                      <Badge variant="success">{s.score.toFixed(2)}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            <Section title="Development areas">
              {development.length === 0 ? (
                <Empty>
                  {individual.byCompetency.length === 0
                    ? 'Not enough scored competencies yet.'
                    : 'Scores are level across competencies — no area stands out as weaker.'}
                </Empty>
              ) : (
                <ul className="grid gap-1.5 text-sm">
                  {development.map((s) => (
                    <li key={s.competency} className="flex items-center justify-between gap-3">
                      <span>{s.competency}</span>
                      <Badge variant="warning">{s.score.toFixed(2)}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>

          {suppressed.length > 0 ? (
            <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Kept confidential (fewer than {individual.minResponses} responses):{' '}
              {suppressed.map((s) => s.source).join(', ')}. Scores appear once enough people have responded.
            </p>
          ) : null}
        </>
      )}

      <a
        href={`/reports/individual/${employeeId}${cycleId ? `?cycleId=${cycleId}` : ''}`}
        target="_blank"
        rel="noreferrer"
        className="text-sm text-brand hover:underline"
      >
        Open the full printable 360 report →
      </a>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-2xl font-extrabold tabular-nums">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded-lg border border-border p-3">
      <h3 className="mb-2 text-sm font-bold">{title}</h3>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }): JSX.Element {
  return <p className="rounded-md border border-dashed border-border bg-muted/30 p-4 text-center text-sm text-muted-foreground">{children}</p>;
}
