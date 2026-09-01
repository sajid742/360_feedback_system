import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EChartsOption } from 'echarts';
import { Trash2 } from 'lucide-react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/shared/StatCard';
import { EChart } from '@/lib/echart';
import { orgApi, type Employee } from '@/features/organization/api';
import { IndividualPerformance } from './IndividualPerformance';
import {
  reportsApi,
  type CampusRow,
  type DepartmentRow,
  type Institutional,
  type MyTeam,
  type NineBox,
  type ReportSchedule,
  type TrendRow,
} from './api';

const BRAND = ['#6d5dfc', '#46c2cb', '#f5a524', '#fb7185', '#8b7dff', '#10b981'];

export function MyTeamTab({ cycleId }: { cycleId?: string }): JSX.Element {
  const [data, setData] = useState<MyTeam | null>(null);
  useEffect(() => {
    setData(null);
    reportsApi.myTeam(cycleId).then(setData);
  }, [cycleId]);

  if (!data) return <Skeleton className="h-64 w-full" />;
  if (!data.isManager) return <Empty text="No direct reports found for your account. This view is for people managers." />;
  if (data.reports.length === 0) return <Empty text="You have no direct reports enrolled with feedback yet." />;

  return (
    <div className="grid gap-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Team size" value={data.reports.length} tone="brand" />
        <StatCard label="On / above target" value={data.reports.filter((r) => r.overallScore !== null && !r.belowTarget).length} hint={`target ${data.target}`} tone="teal" />
        <StatCard label="Below target" value={data.reports.filter((r) => r.belowTarget).length} tone="amber" />
        <StatCard label="Awaiting feedback" value={data.reports.filter((r) => r.overallScore === null).length} tone="violet" />
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground">
            <tr><th className="p-3">Employee</th><th className="p-3">Overall</th><th className="p-3">Top strength</th><th className="p-3">Focus area</th></tr>
          </thead>
          <tbody>
            {data.reports.map((r) => (
              <tr key={r.employeeId} className="border-t border-border">
                <td className="p-3">
                  <div className="font-medium">{r.name}</div>
                  {r.designation ? <div className="text-xs text-muted-foreground">{r.designation}</div> : null}
                </td>
                <td className="p-3">
                  {r.overallScore === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <Badge variant={r.belowTarget ? 'warning' : 'success'}>{r.overallScore}</Badge>
                  )}
                </td>
                <td className="p-3 text-muted-foreground">{r.topStrength ?? '—'}</td>
                <td className="p-3 text-muted-foreground">{r.focusArea ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function InstitutionalTab({ cycleId }: { cycleId?: string }): JSX.Element {
  const [data, setData] = useState<Institutional | null>(null);
  useEffect(() => {
    reportsApi.institutional(cycleId).then(setData);
  }, [cycleId]);

  const distOption = useMemo<EChartsOption>(
    () => ({
      tooltip: { trigger: 'axis' },
      grid: { left: 40, right: 20, top: 20, bottom: 30 },
      xAxis: { type: 'category', data: (data?.distribution ?? []).map((d) => d.bucket) },
      yAxis: { type: 'value', minInterval: 1 },
      series: [{ type: 'bar', data: (data?.distribution ?? []).map((d) => d.count), itemStyle: { color: BRAND[0], borderRadius: [4, 4, 0, 0] } }],
    }),
    [data],
  );

  if (!data) return <Skeleton className="h-64 w-full" />;
  return (
    <div className="grid gap-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Participants" value={data.participation.total} tone="brand" />
        <StatCard label="Completed" value={data.participation.completed} hint={`${data.participation.completionPct}%`} tone="teal" />
        <StatCard label="In progress" value={data.participation.started - data.participation.completed} tone="amber" />
        <StatCard label="Avg score" value={data.avgScore ?? '—'} tone="violet" />
        {data.enps ? (
          <StatCard
            label="eNPS"
            value={data.enps.score > 0 ? `+${data.enps.score}` : `${data.enps.score}`}
            hint={`${data.enps.promoters} promoters · ${data.enps.detractors} detractors (${data.enps.responses})`}
            tone="rose"
          />
        ) : null}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Score distribution">
          <EChart option={distOption} height={280} />
        </Panel>
        <Panel title="Top & bottom performers">
          <PerformerList label="Top" rows={data.topPerformers} variant="success" />
          <PerformerList label="Needs support" rows={data.bottomPerformers} variant="warning" />
        </Panel>
      </div>
    </div>
  );
}

function PerformerList({ label, rows, variant }: { label: string; rows: { name: string; score: number }[]; variant: BadgeVariant }): JSX.Element {
  return (
    <div className="mb-3">
      <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">{label}</p>
      <div className="grid gap-1">
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">No scored participants yet.</p> : null}
        {rows.map((r) => (
          <div key={r.name} className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-1.5 text-sm">
            <span>{r.name}</span>
            <Badge variant={variant}>{r.score}</Badge>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DepartmentalTab({ cycleId }: { cycleId?: string }): JSX.Element {
  const [rows, setRows] = useState<DepartmentRow[] | null>(null);
  useEffect(() => {
    reportsApi.departmental(cycleId).then(setRows);
  }, [cycleId]);

  const option = useMemo<EChartsOption>(
    () => ({
      tooltip: { trigger: 'axis' },
      grid: { left: 40, right: 20, top: 20, bottom: 60 },
      xAxis: { type: 'category', data: (rows ?? []).map((r) => r.department), axisLabel: { rotate: 20 } },
      yAxis: { type: 'value', max: 5 },
      series: [{ type: 'bar', name: 'Avg score', data: (rows ?? []).map((r) => r.avgScore ?? 0), itemStyle: { color: BRAND[1], borderRadius: [4, 4, 0, 0] } }],
    }),
    [rows],
  );

  if (!rows) return <Skeleton className="h-64 w-full" />;
  return (
    <div className="grid gap-6">
      <Panel title="Average score by department">
        <EChart option={option} height={320} />
      </Panel>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground">
            <tr><th className="p-3">Department</th><th className="p-3">Participants</th><th className="p-3">Completion</th><th className="p-3">Avg score</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.department} className="border-t border-border">
                <td className="p-3 font-medium">{r.department}</td>
                <td className="p-3">{r.participants}</td>
                <td className="p-3">{r.completionPct}%</td>
                <td className="p-3">{r.avgScore ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function CampusTab({ cycleId }: { cycleId?: string }): JSX.Element {
  const [rows, setRows] = useState<CampusRow[] | null>(null);
  useEffect(() => {
    setRows(null);
    reportsApi.campus(cycleId).then(setRows);
  }, [cycleId]);

  const option = useMemo<EChartsOption>(
    () => ({
      tooltip: { trigger: 'axis' },
      grid: { left: 40, right: 20, top: 20, bottom: 60 },
      xAxis: { type: 'category', data: (rows ?? []).map((r) => r.campus), axisLabel: { rotate: 20 } },
      yAxis: { type: 'value', max: 5 },
      series: [{ type: 'bar', name: 'Avg score', data: (rows ?? []).map((r) => r.avgScore ?? 0), itemStyle: { color: BRAND[4], borderRadius: [4, 4, 0, 0] } }],
    }),
    [rows],
  );

  if (!rows) return <Skeleton className="h-64 w-full" />;
  if (rows.length === 0 || (rows.length === 1 && rows[0].campus === 'Unassigned')) {
    return <Empty text="No campus breakdown yet. Assign employees to campuses under Organization to compare campus performance." />;
  }
  return (
    <div className="grid gap-6">
      <Panel title="Average score by campus">
        <EChart option={option} height={320} />
      </Panel>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground">
            <tr><th className="p-3">Campus</th><th className="p-3">Participants</th><th className="p-3">Completion</th><th className="p-3">Avg score</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.campus} className="border-t border-border">
                <td className="p-3 font-medium">{r.campus}</td>
                <td className="p-3">{r.participants}</td>
                <td className="p-3">{r.completionPct}%</td>
                <td className="p-3">{r.avgScore ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function TrendTab(): JSX.Element {
  const [rows, setRows] = useState<TrendRow[] | null>(null);
  useEffect(() => {
    reportsApi.trend().then(setRows);
  }, []);

  const option = useMemo<EChartsOption>(
    () => ({
      tooltip: { trigger: 'axis' },
      legend: { data: ['Avg score', 'Completion %'] },
      grid: { left: 40, right: 40, top: 40, bottom: 40 },
      xAxis: { type: 'category', data: (rows ?? []).map((r) => r.cycle) },
      yAxis: [
        { type: 'value', name: 'Score', max: 5 },
        { type: 'value', name: '%', max: 100 },
      ],
      series: [
        { name: 'Avg score', type: 'line', smooth: true, data: (rows ?? []).map((r) => r.avgScore), itemStyle: { color: BRAND[0] }, areaStyle: { opacity: 0.1 } },
        { name: 'Completion %', type: 'line', yAxisIndex: 1, smooth: true, data: (rows ?? []).map((r) => r.completionPct), itemStyle: { color: BRAND[2] } },
      ],
    }),
    [rows],
  );

  if (!rows) return <Skeleton className="h-64 w-full" />;
  if (rows.length === 0) return <Empty text="No appraisal cycles yet." />;
  return (
    <Panel title="Score & completion trend across cycles">
      <EChart option={option} height={340} />
    </Panel>
  );
}

export function HeatmapTab({ cycleId }: { cycleId?: string }): JSX.Element {
  const [option, setOption] = useState<EChartsOption | null>(null);
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    reportsApi.heatmap(cycleId).then((h) => {
      if (h.competencies.length === 0 || h.departments.length === 0) {
        setEmpty(true);
        return;
      }
      setEmpty(false);
      setOption({
        tooltip: { position: 'top' },
        grid: { left: 140, right: 20, top: 20, bottom: 60 },
        xAxis: { type: 'category', data: h.departments, splitArea: { show: true }, axisLabel: { rotate: 20 } },
        yAxis: { type: 'category', data: h.competencies, splitArea: { show: true } },
        visualMap: { min: 1, max: 5, calculable: true, orient: 'horizontal', left: 'center', bottom: 0, inRange: { color: ['#fb7185', '#f5a524', '#10b981'] } },
        series: [{ type: 'heatmap', data: h.data.map(([x, y, v]) => [x, y, v ?? '-']), label: { show: true }, emphasis: { itemStyle: { shadowBlur: 8 } } }],
      });
    });
  }, [cycleId]);

  if (empty) return <Empty text="No scored competency feedback yet." />;
  if (!option) return <Skeleton className="h-64 w-full" />;
  return (
    <Panel title="Competency scores by department">
      <EChart option={option} height={380} />
    </Panel>
  );
}

/**
 * Individual 360 performance report.
 *
 * The employee picker plus `IndividualPerformance`, which holds the analysis. The
 * picker stays here because it is tab furniture; everything below it is shared and
 * reusable. Scope and release gating are enforced by the endpoints themselves, so a
 * manager sees only their own reporting line and only released results.
 */
export function IndividualTab({ cycleId }: { cycleId?: string }): JSX.Element {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    orgApi.listEmployees('').then((r) => setEmployees(r.items)).catch(() => setEmployees([]));
  }, []);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((e) => (e.user.fullName ?? e.user.email ?? '').toLowerCase().includes(q));
  }, [employees, search]);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search employee" className="h-10 w-56" />
        <select value={selected} onChange={(e) => setSelected(e.target.value)} className="h-10 max-w-sm flex-1 rounded-md border border-input bg-card px-3 text-sm">
          <option value="">Select an employee…</option>
          {shown.map((e) => (
            <option key={e.id} value={e.id}>{e.user.fullName ?? e.user.email}</option>
          ))}
        </select>
        {selected ? (
          <a
            href={`/reports/individual/${selected}${cycleId ? `?cycleId=${cycleId}` : ''}`}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-brand hover:underline"
          >
            Printable report →
          </a>
        ) : null}
      </div>

      {!selected ? (
        <Empty text="Pick an employee to see their 360° performance report." />
      ) : (
        <IndividualPerformance key={`${selected}:${cycleId ?? ''}`} employeeId={selected} cycleId={cycleId} />
      )}
    </div>
  );
}

const NINE_BOX_LABELS = [
  ['Enigma', 'Growth employee', 'Future leader'],
  ['Dilemma', 'Core player', 'High impact'],
  ['Under-performer', 'Effective', 'Trusted professional'],
];

export function NineBoxTab({ cycleId }: { cycleId?: string }): JSX.Element {
  const [data, setData] = useState<NineBox | null>(null);
  useEffect(() => {
    setData(null);
    reportsApi.nineBox(cycleId).then(setData);
  }, [cycleId]);

  if (!data) return <Skeleton className="h-72 w-full" />;
  if (data.employees.length === 0) {
    return <Empty text="No nine-box data yet. Set a performance (calibrated score) and a potential rating on participants." />;
  }

  const level = (v: number): number => (v >= data.scaleMax * 0.667 ? 2 : v >= data.scaleMax * 0.334 ? 1 : 0);
  // grid[row][col] — row 0 = high potential (top), col 0 = low performance (left)
  const grid: NineBox['employees'][][] = [
    [[], [], []],
    [[], [], []],
    [[], [], []],
  ];
  for (const e of data.employees) {
    const row = 2 - level(e.potential); // invert so high potential is top row
    const col = level(e.performance);
    grid[row][col].push(e);
  }
  const cellTone = ['bg-rose-50', 'bg-amber-50', 'bg-emerald-50'];

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span>▲ Potential (rows)</span><span>▶ Performance (columns)</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {grid.map((cols, r) =>
          cols.map((people, c) => (
            <div key={`${r}-${c}`} className={`min-h-[120px] rounded-lg border border-border p-2 ${cellTone[Math.round((c + (2 - r)) / 2)]}`}>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{NINE_BOX_LABELS[r][c]}</p>
              <div className="flex flex-wrap gap-1">
                {people.map((p) => (
                  <span key={p.employeeId} title={`Performance ${p.performance} · Potential ${p.potential}`} className="rounded-full bg-white/80 px-2 py-0.5 text-xs shadow-sm">
                    {p.name}
                  </span>
                ))}
              </div>
            </div>
          )),
        )}
      </div>
    </div>
  );
}

export function SchedulesTab(): JSX.Element {
  const [items, setItems] = useState<ReportSchedule[] | null>(null);
  const [form, setForm] = useState({ name: '', reportType: 'institutional', frequency: 'weekly', recipients: '' });
  const reload = useCallback(() => reportsApi.listSchedules().then(setItems), []);
  useEffect(() => void reload(), [reload]);

  const add = async (): Promise<void> => {
    const recipients = form.recipients.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!form.name.trim() || recipients.length === 0) return;
    await reportsApi.createSchedule({ name: form.name.trim(), reportType: form.reportType, frequency: form.frequency, recipients });
    setForm({ name: '', reportType: 'institutional', frequency: 'weekly', recipients: '' });
    reload();
  };

  if (!items) return <Skeleton className="h-40 w-full" />;
  return (
    <div className="grid gap-4">
      <div className="grid gap-2 rounded-lg border border-border bg-muted/40 p-3 sm:grid-cols-[1.4fr_1fr_1fr_auto]">
        <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Digest name (e.g. Weekly exec summary)" />
        <select value={form.reportType} onChange={(e) => setForm((f) => ({ ...f, reportType: e.target.value }))} className="h-10 rounded-md border border-input bg-card px-2 text-sm">
          <option value="institutional">Institutional</option>
          <option value="departmental">Departmental</option>
        </select>
        <select value={form.frequency} onChange={(e) => setForm((f) => ({ ...f, frequency: e.target.value }))} className="h-10 rounded-md border border-input bg-card px-2 text-sm">
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
        </select>
        <Button onClick={add}>Add</Button>
        <Input value={form.recipients} onChange={(e) => setForm((f) => ({ ...f, recipients: e.target.value }))} placeholder="Recipient emails (comma separated)" className="sm:col-span-4" />
      </div>
      {items.length === 0 ? (
        <Empty text="No scheduled digests yet. They email a summary of the chosen report on your cadence." />
      ) : (
        <div className="grid gap-2">
          {items.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
              <div>
                <span className="font-medium">{s.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">{s.reportType} · {s.frequency} · {s.recipients.length} recipient(s){s.lastRunAt ? ` · last sent ${new Date(s.lastRunAt).toLocaleDateString()}` : ''}</span>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => reportsApi.runSchedule(s.id).then(reload)}>Send now</Button>
                <Button size="sm" variant="ghost" onClick={() => reportsApi.deleteSchedule(s.id).then(reload)}><Trash2 className="size-3.5" /></Button>
              </div>
            </div>
          ))}
        </div>
      )}
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
