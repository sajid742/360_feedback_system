import { useEffect, useMemo, useState } from 'react';
import type { EChartsOption } from 'echarts';
import { Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StatCard } from '@/components/shared/StatCard';
import { EChart } from '@/lib/echart';
import { appraisalApi, type Cycle } from '@/features/appraisal/api';
import { orgApi, type Employee } from '@/features/organization/api';
import { usePermissions } from '@/features/auth/AuthContext';
import { ProviderSettings } from './ProviderSettings';
import {
  aiApi,
  type AiStatus,
  type BlindSpot,
  type BlindSpotType,
  type Insights,
  type Overview,
  type Sentiment,
} from './api';

const SENTIMENT_COLORS = { positive: '#10b981', neutral: '#f5a524', negative: '#fb7185' };

export function AiPage(): JSX.Element {
  const { has } = usePermissions();
  // Anyone who can see configuration can see how the AI is set up; only
  // `configuration.manage` can change it, which the panel itself enforces.
  const canSeeSettings = has('configuration.read');
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [cycleId, setCycleId] = useState<string>('');
  const [status, setStatus] = useState<AiStatus | null>(null);

  useEffect(() => {
    appraisalApi.listCycles().then(setCycles);
    aiApi.status().then(setStatus);
  }, []);

  return (
    <div className="grid gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-brand/10 text-brand">
              <Sparkles className="size-4" />
            </span>
            <h1 className="text-2xl font-extrabold tracking-tight">AI Insights</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Blind spots, recommendations, promotion readiness and sentiment — derived from 360° feedback.
          </p>
        </div>
        <div className="flex items-end gap-3">
          {status ? (
            <Badge variant={status.configured ? 'success' : 'neutral'} className="mb-1">
              {status.configured ? `AI-enhanced · ${status.model}` : 'Heuristic engine'}
            </Badge>
          ) : null}
          <div className="grid gap-1">
            <Label htmlFor="cycle" className="text-xs">Appraisal cycle</Label>
            <select
              id="cycle"
              value={cycleId}
              onChange={(e) => setCycleId(e.target.value)}
              className="h-10 rounded-md border border-input bg-card px-3 text-sm"
            >
              <option value="">All cycles</option>
              {cycles.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <Card className="p-4 sm:p-5">
        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Organisation overview</TabsTrigger>
            <TabsTrigger value="individual">Individual insights</TabsTrigger>
            {canSeeSettings ? <TabsTrigger value="provider">Language model</TabsTrigger> : null}
          </TabsList>
          <TabsContent value="overview"><OverviewTab cycleId={cycleId || undefined} /></TabsContent>
          <TabsContent value="individual"><IndividualTab cycleId={cycleId || undefined} /></TabsContent>
          {canSeeSettings ? (
            <TabsContent value="provider"><ProviderSettings /></TabsContent>
          ) : null}
        </Tabs>
      </Card>
    </div>
  );
}

function OverviewTab({ cycleId }: { cycleId?: string }): JSX.Element {
  const [data, setData] = useState<Overview | null>(null);
  useEffect(() => {
    setData(null);
    aiApi.overview(cycleId).then(setData);
  }, [cycleId]);

  const readinessOption = useMemo<EChartsOption>(
    () => ({
      tooltip: { trigger: 'item' },
      legend: { bottom: 0 },
      series: [
        {
          type: 'pie',
          radius: ['45%', '72%'],
          label: { show: false },
          data: [
            { value: data?.readiness.ready ?? 0, name: 'Ready', itemStyle: { color: '#10b981' } },
            { value: data?.readiness.developing ?? 0, name: 'Developing', itemStyle: { color: '#f5a524' } },
            { value: data?.readiness.notYet ?? 0, name: 'Not yet', itemStyle: { color: '#fb7185' } },
          ],
        },
      ],
    }),
    [data],
  );

  if (!data) return <Skeleton className="h-64 w-full" />;
  if (data.appraised === 0) return <Empty text="No scored appraisals yet — AI insights appear once feedback is submitted and cycles are closed." />;

  return (
    <div className="grid gap-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Appraised" value={data.appraised} tone="brand" />
        <StatCard label="Promotion-ready" value={data.readiness.ready} hint={`≥ target ${data.target}`} tone="teal" />
        <StatCard label="Developing" value={data.readiness.developing} tone="amber" />
        <StatCard label="At risk" value={data.readiness.notYet} hint="Below target − 1" tone="rose" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Promotion readiness distribution">
          <EChart option={readinessOption} height={280} />
        </Panel>
        <Panel title="Feedback sentiment">
          <SentimentBlock sentiment={data.sentiment} />
        </Panel>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Attrition / performance risk — flagged employees">
          {data.atRisk.length === 0 ? (
            <p className="text-sm text-muted-foreground">No employees below the risk threshold. 🎉</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground">
                  <tr><th className="p-3">Employee</th><th className="p-3">Dept</th><th className="p-3">Risk</th><th className="p-3">Driver</th></tr>
                </thead>
                <tbody>
                  {data.atRisk.map((r) => (
                    <tr key={r.employeeId} className="border-t border-border">
                      <td className="p-3 font-medium">{r.name}</td>
                      <td className="p-3 text-muted-foreground">{r.department}</td>
                      <td className="p-3"><Badge variant={r.risk >= 66 ? 'danger' : r.risk >= 40 ? 'warning' : 'neutral'}>{r.risk}%</Badge></td>
                      <td className="p-3 text-xs text-muted-foreground">{r.driver}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
        <Panel title="Organisation-wide competency gaps">
          {data.topGaps.length === 0 ? (
            <p className="text-sm text-muted-foreground">No competencies below target.</p>
          ) : (
            <div className="grid gap-2">
              {data.topGaps.map((g) => (
                <div key={g.competency} className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2 text-sm">
                  <span>{g.competency}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-muted-foreground">{g.score} / {data.target}</span>
                    <Badge variant={g.gap >= 1 ? 'danger' : 'warning'}>-{g.gap}</Badge>
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

const BLIND_LABEL: Record<BlindSpotType, string> = {
  blind_spot: 'Blind spot',
  hidden_strength: 'Hidden strength',
  aligned: 'Aligned',
  self_only: 'Self only',
  no_self: 'No self-rating',
};
const BLIND_VARIANT: Record<BlindSpotType, BadgeVariant> = {
  blind_spot: 'warning',
  hidden_strength: 'info',
  aligned: 'success',
  self_only: 'neutral',
  no_self: 'neutral',
};

function IndividualTab({ cycleId }: { cycleId?: string }): JSX.Element {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [data, setData] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    orgApi.listEmployees('').then((r) => setEmployees(r.items));
  }, []);

  useEffect(() => {
    if (!selected) {
      setData(null);
      return;
    }
    setLoading(true);
    aiApi.insights(selected, cycleId).then((d) => {
      setData(d);
      setLoading(false);
    });
  }, [selected, cycleId]);

  const blindOption = useMemo<EChartsOption>(() => {
    const comps = (data?.blindSpots ?? []).map((b) => b.competency);
    return {
      tooltip: { trigger: 'axis' },
      legend: { data: ['Self', 'Others'], bottom: 0 },
      grid: { left: 40, right: 20, top: 20, bottom: 60 },
      xAxis: { type: 'category', data: comps, axisLabel: { rotate: 20 } },
      yAxis: { type: 'value', max: 5 },
      series: [
        { name: 'Self', type: 'bar', data: (data?.blindSpots ?? []).map((b) => b.selfScore ?? 0), itemStyle: { color: '#8b7dff', borderRadius: [4, 4, 0, 0] } },
        { name: 'Others', type: 'bar', data: (data?.blindSpots ?? []).map((b) => b.othersScore ?? 0), itemStyle: { color: '#46c2cb', borderRadius: [4, 4, 0, 0] } },
      ],
    };
  }, [data]);

  return (
    <div className="grid gap-6">
      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        className="h-10 max-w-sm rounded-md border border-input bg-card px-3 text-sm"
      >
        <option value="">Select an employee…</option>
        {employees.map((e) => (
          <option key={e.id} value={e.id}>{e.user.fullName ?? e.user.email}</option>
        ))}
      </select>

      {!selected ? (
        <Empty text="Pick an employee to generate their AI insight report." />
      ) : loading || !data ? (
        <Skeleton className="h-64 w-full" />
      ) : !data.hasData ? (
        <Empty text={`${data.employee.name} has no scored 360° feedback for this selection yet.`} />
      ) : (
        <div className="grid gap-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Overall score" value={data.overallScore ?? '—'} hint={`Target ${data.target}`} tone="brand" />
            <StatCard
              label="Promotion readiness"
              value={`${data.promotionReadiness.score}`}
              hint={data.promotionReadiness.band}
              tone={data.promotionReadiness.band === 'Ready' ? 'teal' : data.promotionReadiness.band === 'Developing' ? 'amber' : 'rose'}
            />
            <StatCard
              label="Feedback sentiment"
              value={data.sentiment.score > 0 ? `+${data.sentiment.score}` : `${data.sentiment.score}`}
              hint={`${data.sentiment.positive}+ / ${data.sentiment.negative}−`}
              tone="violet"
            />
          </div>

          <Panel title="AI summary">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm leading-relaxed text-foreground/90">{data.summary}</p>
              <Badge variant={data.generatedBy === 'ai' ? 'success' : 'neutral'} className="shrink-0">
                {data.generatedBy === 'ai' ? 'AI-generated' : 'Heuristic'}
              </Badge>
            </div>
          </Panel>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="Self vs others — blind-spot analysis">
              <EChart option={blindOption} height={300} />
              <div className="mt-3 grid gap-1">
                {data.blindSpots
                  .filter((b) => b.type === 'blind_spot' || b.type === 'hidden_strength')
                  .map((b) => (
                    <BlindRow key={b.competency} b={b} />
                  ))}
                {data.blindSpots.every((b) => b.type !== 'blind_spot' && b.type !== 'hidden_strength') ? (
                  <p className="text-sm text-muted-foreground">Self and peer ratings are well aligned — no significant blind spots.</p>
                ) : null}
              </div>
            </Panel>

            <Panel title="Recommended development actions">
              {data.recommendations.length === 0 ? (
                <p className="text-sm text-muted-foreground">No gaps against target — maintain current development plan.</p>
              ) : (
                <div className="grid gap-2">
                  {data.recommendations.map((r) => (
                    <div key={`${r.competency}-${r.action.slice(0, 12)}`} className="rounded-md border border-border bg-card p-3">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-sm font-semibold">{r.competency}</span>
                        <Badge variant={r.priority === 'high' ? 'danger' : r.priority === 'medium' ? 'warning' : 'success'}>{r.priority}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">{r.action}</p>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="Promotion readiness breakdown">
              <div className="grid gap-3">
                {data.promotionReadiness.factors.map((f) => (
                  <div key={f.label}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="font-medium">{f.label}</span>
                      <span className="text-muted-foreground">{f.value}%</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-brand" style={{ width: `${f.value}%` }} />
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{f.detail}</p>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel title="Feedback sentiment">
              <SentimentBlock sentiment={data.sentiment} />
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}

function BlindRow({ b }: { b: BlindSpot }): JSX.Element {
  return (
    <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-1.5 text-sm">
      <span>{b.competency}</span>
      <span className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">self {b.selfScore ?? '—'} / others {b.othersScore ?? '—'}</span>
        <Badge variant={BLIND_VARIANT[b.type]}>{BLIND_LABEL[b.type]}</Badge>
      </span>
    </div>
  );
}

function SentimentBlock({ sentiment }: { sentiment: Sentiment }): JSX.Element {
  const total = sentiment.positive + sentiment.neutral + sentiment.negative;
  const option = useMemo<EChartsOption>(
    () => ({
      tooltip: { trigger: 'item' },
      legend: { bottom: 0 },
      series: [
        {
          type: 'pie',
          radius: ['45%', '72%'],
          label: { show: false },
          data: [
            { value: sentiment.positive, name: 'Positive', itemStyle: { color: SENTIMENT_COLORS.positive } },
            { value: sentiment.neutral, name: 'Neutral', itemStyle: { color: SENTIMENT_COLORS.neutral } },
            { value: sentiment.negative, name: 'Negative', itemStyle: { color: SENTIMENT_COLORS.negative } },
          ],
        },
      ],
    }),
    [sentiment],
  );

  if (total === 0) return <Empty text="No written comments to analyse yet." />;
  return (
    <div className="grid gap-3">
      <EChart option={option} height={200} />
      <div className="grid gap-1">
        {sentiment.samples.map((s, i) => (
          <div key={i} className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-1.5 text-sm">
            <Badge variant={s.sentiment === 'positive' ? 'success' : s.sentiment === 'negative' ? 'danger' : 'neutral'} className="mt-0.5 shrink-0">
              {s.sentiment}
            </Badge>
            <span className="text-xs text-muted-foreground">{s.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-card">
      <h3 className="mb-3 text-sm font-bold">{title}</h3>
      {children}
    </div>
  );
}

function Empty({ text }: { text: string }): JSX.Element {
  return <div className="rounded-lg border border-dashed border-border bg-muted/40 p-10 text-center text-sm text-muted-foreground">{text}</div>;
}
