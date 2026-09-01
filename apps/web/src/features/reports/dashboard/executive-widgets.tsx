import type { EChartsOption } from 'echarts';
import { Badge } from '@/components/ui/badge';
import { EChart } from '@/lib/echart';
import { reportsApi, type Executive, type LayoutItem } from '../api';
import { KpiCard } from './cards';
import {
  Empty, Panel, arrange, emptyOf, heightOf, iconNode, resolveTone, titleOf, tunePie, tuneSeries,
  type WidgetContext, type WidgetDef,
} from './shared';

const BAND_BY_READINESS: Record<string, string> = { Ready: 'ready', Developing: 'developing', 'At risk': 'atrisk' };

type Ctx = WidgetContext<Executive>;

/** Every existing Executive widget — same data, drilldowns and calculations — now
 *  individually addable, arrangeable, and tunable (presentation-only config). */
export const EXECUTIVE_WIDGETS: WidgetDef<Executive>[] = [
  {
    key: 'exec.participants', title: 'Participants', category: 'KPI', defaultSpan: 3,
    supports: { title: true, tone: true, icon: true, cardVariant: true },
    render: ({ data, cy, drill, config }: Ctx) => (
      <KpiCard label={titleOf({ title: 'Participants' }, config)} value={data.kpis.participants} icon={iconNode(config.icon)} tone={resolveTone(config, 'brand')} variant={config.cardVariant}
        onClick={() => drill.open('Participants', 'All appraisal participants', () => reportsApi.drilldown.participants({ cycleId: cy }))} />
    ),
  },
  {
    key: 'exec.completion', title: 'Completion', category: 'KPI', defaultSpan: 3,
    supports: { title: true, tone: true, icon: true, cardVariant: true, thresholds: true },
    render: ({ data, cy, drill, config }: Ctx) => (
      <KpiCard label={titleOf({ title: 'Completion' }, config)} value={`${data.kpis.completionPct}%`} hint={`${data.kpis.completed} scored`} icon={iconNode(config.icon)} tone={resolveTone(config, 'teal', data.kpis.completionPct)} variant={config.cardVariant}
        progress={{ value: data.kpis.completionPct, max: 100 }}
        onClick={() => drill.open('Completed appraisals', 'Participants with a final score', () => reportsApi.drilldown.participants({ cycleId: cy, band: 'scored' }))} />
    ),
  },
  {
    key: 'exec.avgScore', title: 'Avg score', category: 'KPI', defaultSpan: 3,
    supports: { title: true, tone: true, icon: true, cardVariant: true, thresholds: true },
    render: ({ data, cy, drill, config }: Ctx) => (
      <KpiCard label={titleOf({ title: 'Avg score' }, config)} value={data.kpis.avgScore ?? '—'} hint={`target ${data.target}`} icon={iconNode(config.icon)} tone={resolveTone(config, 'violet', data.kpis.avgScore ?? undefined)} variant={config.cardVariant}
        progress={data.kpis.avgScore != null ? { value: data.kpis.avgScore, max: data.target } : undefined}
        onClick={() => drill.open('Scored participants', 'Underlying scores behind the average', () => reportsApi.drilldown.participants({ cycleId: cy, band: 'scored' }))} />
    ),
  },
  {
    key: 'exec.promotionReady', title: 'Promotion-ready', category: 'KPI', defaultSpan: 3,
    supports: { title: true, tone: true, icon: true, cardVariant: true, thresholds: true },
    render: ({ data, cy, drill, config }: Ctx) => (
      <KpiCard label={titleOf({ title: 'Promotion-ready' }, config)} value={data.readiness.ready} hint={`${data.readiness.notYet} at risk`} icon={iconNode(config.icon)} tone={resolveTone(config, 'amber', data.readiness.ready)} variant={config.cardVariant}
        progress={data.kpis.participants > 0 ? { value: data.readiness.ready, max: data.kpis.participants } : undefined}
        onClick={() => drill.open('Promotion-ready employees', 'Scored at or above the readiness threshold', () => reportsApi.drilldown.participants({ cycleId: cy, band: 'ready' }))} />
    ),
  },
  {
    key: 'exec.enps', title: 'eNPS', category: 'KPI', defaultSpan: 3,
    supports: { title: true, tone: true, icon: true, cardVariant: true },
    render: ({ data, config }: Ctx) => (
      <KpiCard label={titleOf({ title: 'eNPS' }, config)} value={data.kpis.enps ? (data.kpis.enps.score > 0 ? `+${data.kpis.enps.score}` : `${data.kpis.enps.score}`) : '—'} hint={data.kpis.enps ? `${data.kpis.enps.responses} responses` : 'not configured'} icon={iconNode(config.icon)} tone={resolveTone(config, 'rose')} variant={config.cardVariant} />
    ),
  },
  {
    key: 'exec.trend', title: 'Performance & completion trend', category: 'Chart', defaultSpan: 8,
    // No chart-type switch here: this is a dual-axis, two-series chart and every
    // alternative style carries a single series, so switching would silently drop
    // one of the two lines.
    supports: { title: true, legend: true, dataLabels: true, height: true },
    render: ({ data, drill, config, palette }: Ctx) => {
      const showLabels = config.showDataLabels === true;
      const option: EChartsOption = {
        tooltip: { trigger: 'axis' },
        legend: { data: ['Avg score', 'Completion %'], bottom: 0, show: config.showLegend !== false },
        grid: { left: 40, right: 40, top: 20, bottom: 40 },
        // Axis labels are clickable too: a line point is a small target, and the
        // cycle name is the obvious thing to click when drilling into a cycle.
        // `triggerEvent` isn't in ECharts' TS surface for category axis labels but is
        // supported at runtime; it makes the cycle name clickable, which is a far
        // easier target than a line point.
        xAxis: { type: 'category', data: data.trend.map((r) => r.cycle), axisLabel: { triggerEvent: true } as Record<string, unknown> },
        yAxis: [{ type: 'value', name: 'Score', max: 5 }, { type: 'value', name: '%', max: 100 }],
        series: [
          { name: 'Avg score', type: 'line', smooth: true, symbolSize: 10, data: data.trend.map((r) => r.avgScore), itemStyle: { color: palette[0] }, areaStyle: { opacity: 0.1 }, label: { show: showLabels, position: 'top' } },
          { name: 'Completion %', type: 'line', yAxisIndex: 1, smooth: true, data: data.trend.map((r) => r.completionPct), itemStyle: { color: palette[2] }, label: { show: showLabels, position: 'top' } },
        ],
      };
      // Clicking a point drills into that cycle's participants, regardless of the
      // dashboard's own cycle filter — the trend deliberately spans all cycles.
      const onPoint = (p: { dataIndex: number; name?: string; value?: unknown }): void => {
        // A series point gives dataIndex; an axis label gives the cycle name.
        const label = p.name || String(p.value ?? '');
        const row = data.trend.find((r) => r.cycle === label) ?? data.trend[p.dataIndex];
        if (!row) return;
        drill.open(`Participants — ${row.cycle}`, 'Scores recorded in this cycle', () =>
          reportsApi.drilldown.participants({ cycleId: row.cycleId }));
      };
      return <Panel title={titleOf({ title: 'Performance & completion trend' }, config)}>{data.trend.length === 0 ? <Empty text={emptyOf(config, 'No cycles yet.')} /> : <EChart option={option} height={heightOf(config, 300)} onClick={onPoint} />}</Panel>;
    },
  },
  {
    key: 'exec.readiness', title: 'Promotion readiness', category: 'Chart', defaultSpan: 4,
    supports: { title: true, chartTypes: ['doughnut', 'pie', 'bar', 'hbar'], legend: true, dataLabels: true, height: true },
    render: ({ data, cy, drill, config, palette }: Ctx) => {
      const option: EChartsOption = tunePie({
        tooltip: { trigger: 'item' }, legend: { bottom: 0 },
        series: [{
          type: 'pie', radius: ['45%', '72%'], label: { show: false },
          data: [
            { value: data.readiness.ready, name: 'Ready', itemStyle: { color: '#10b981' } },
            { value: data.readiness.developing, name: 'Developing', itemStyle: { color: '#f5a524' } },
            { value: data.readiness.notYet, name: 'At risk', itemStyle: { color: '#fb7185' } },
          ],
        }],
      }, config, palette);
      return (
        <Panel title={titleOf({ title: 'Promotion readiness' }, config)}>
          <EChart option={option} height={heightOf(config, 300)} onClick={(p) => { const band = BAND_BY_READINESS[p.name]; if (band) drill.open(`${p.name} employees`, 'Promotion readiness breakdown', () => reportsApi.drilldown.participants({ cycleId: cy, band })); }} />
        </Panel>
      );
    },
  },
  {
    key: 'exec.byDepartment', title: 'Average score by department', category: 'Chart', defaultSpan: 6,
    supports: { title: true, chartTypes: ['bar', 'hbar', 'line', 'area', 'radar'], color: true, dataLabels: true, sort: true, height: true, emptyText: true },
    render: ({ data, cy, drill, config, palette }: Ctx) => {
      const rows = arrange(data.byDepartment, (r) => r.avgScore ?? 0, config);
      const option: EChartsOption = tuneSeries({
        tooltip: { trigger: 'axis' }, grid: { left: 40, right: 20, top: 20, bottom: 60 },
        xAxis: { type: 'category', data: rows.map((r) => r.department), axisLabel: { rotate: 20 } },
        yAxis: { type: 'value', max: 5 },
        series: [{ type: 'bar', name: 'Avg score', data: rows.map((r) => r.avgScore ?? 0), itemStyle: { borderRadius: [4, 4, 0, 0] } }],
      }, config, palette[1], palette);
      return (
        <Panel title={titleOf({ title: 'Average score by department' }, config)}>
          {rows.length === 0 ? <Empty text={emptyOf(config, 'No department data yet.')} /> : (
            <EChart option={option} height={heightOf(config, 280)} onClick={(p) => drill.open(`${p.name} — participants`, 'Department drill-down', () => reportsApi.drilldown.participants({ cycleId: cy, department: p.name }))} />
          )}
        </Panel>
      );
    },
  },
  {
    key: 'exec.byCampus', title: 'Average score by campus', category: 'List', defaultSpan: 6,
    supports: { title: true, sort: true, emptyText: true },
    render: ({ data, cy, drill, config }: Ctx) => {
      const rows = arrange(data.byCampus.filter((c) => c.campus !== 'Unassigned'), (c) => c.avgScore ?? 0, config);
      return (
        <Panel title={titleOf({ title: 'Average score by campus' }, config)}>
          {rows.length === 0 ? <Empty text={emptyOf(config, 'No campuses configured.')} /> : (
            <div className="grid gap-2">
              {rows.map((c) => (
                <button key={c.campus} onClick={() => drill.open(`${c.campus} — participants`, 'Campus drill-down', () => reportsApi.drilldown.participants({ cycleId: cy, campus: c.campus }))}
                  className="flex w-full items-center justify-between rounded-md bg-muted/50 px-3 py-2 text-left text-sm transition-colors hover:bg-muted">
                  <span className="font-medium">{c.campus}</span>
                  <span className="flex items-center gap-3 text-muted-foreground">
                    <span>{c.participants} people · {c.completionPct}%</span>
                    <Badge variant={c.avgScore != null && c.avgScore >= data.target ? 'success' : 'warning'}>{c.avgScore ?? '—'}</Badge>
                  </span>
                </button>
              ))}
            </div>
          )}
        </Panel>
      );
    },
  },
  {
    key: 'exec.atRisk', title: 'Attention needed — at-risk employees', category: 'List', defaultSpan: 6,
    supports: { title: true, sort: true, emptyText: true },
    render: ({ data, cy, drill, config }: Ctx) => {
      const rows = arrange(data.atRisk, (a) => a.score, config);
      return (
        <Panel title={titleOf({ title: 'Attention needed — at-risk employees' }, config)}>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{emptyOf(config, 'No employees below the risk threshold. 🎉')}</p>
          ) : (
            <div className="grid gap-2">
              {rows.map((a) => (
                <button
                  key={a.employeeId ?? a.name}
                  // These rows name a specific person, so clicking one opens that
                  // person's 360 breakdown rather than the whole at-risk band.
                  onClick={() =>
                    a.employeeId
                      ? drill.openEmployee(a.employeeId, a.name, a.unit, cy)
                      : drill.open('At-risk employees', 'Scored below the risk threshold', () =>
                          reportsApi.drilldown.participants({ cycleId: cy, band: 'atrisk' }))
                  }
                  className="flex w-full items-center justify-between rounded-md bg-muted/50 px-3 py-2 text-left text-sm transition-colors hover:bg-muted">
                  <span><span className="font-medium">{a.name}</span> <span className="text-muted-foreground">· {a.unit}</span></span>
                  <Badge variant="danger">{a.score}</Badge>
                </button>
              ))}
            </div>
          )}
        </Panel>
      );
    },
  },
  {
    key: 'exec.topGaps', title: 'Top organisation-wide competency gaps', category: 'List', defaultSpan: 6,
    supports: { title: true, sort: true, emptyText: true },
    render: ({ data, cy, drill, config }: Ctx) => {
      const rows = arrange(data.topGaps, (g) => g.gap, config);
      return (
        <Panel title={titleOf({ title: 'Top organisation-wide competency gaps' }, config)}>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{emptyOf(config, 'No competencies below target.')}</p>
          ) : (
            <div className="grid gap-2">
              {rows.map((g) => (
                <button key={g.competency} onClick={() => drill.open(`${g.competency} — below target`, 'Employees scored under target on this competency', () => reportsApi.drilldown.competency({ cycleId: cy, competency: g.competency, belowTarget: true }))}
                  className="flex w-full items-center justify-between rounded-md bg-muted/50 px-3 py-2 text-left text-sm transition-colors hover:bg-muted">
                  <span>{g.competency}</span>
                  <span className="flex items-center gap-2"><span className="text-muted-foreground">{g.score} / {data.target}</span><Badge variant={g.gap >= 1 ? 'danger' : 'warning'}>-{g.gap}</Badge></span>
                </button>
              ))}
            </div>
          )}
        </Panel>
      );
    },
  },
];

/** Default arrangement — reproduces the current Executive dashboard layout. */
export const EXECUTIVE_DEFAULT_LAYOUT: LayoutItem[] = [
  { key: 'exec.participants', span: 3 }, { key: 'exec.completion', span: 3 }, { key: 'exec.avgScore', span: 3 }, { key: 'exec.promotionReady', span: 3 }, { key: 'exec.enps', span: 3 },
  { key: 'exec.trend', span: 8 }, { key: 'exec.readiness', span: 4 },
  { key: 'exec.byDepartment', span: 6 }, { key: 'exec.byCampus', span: 6 },
  { key: 'exec.atRisk', span: 6 }, { key: 'exec.topGaps', span: 6 },
];
