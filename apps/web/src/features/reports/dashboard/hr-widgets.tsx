import type { EChartsOption } from 'echarts';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { EChart } from '@/lib/echart';
import { reportsApi, type Hr, type LayoutItem } from '../api';
import { KpiCard } from './cards';
import {
  Empty, Panel, arrange, emptyOf, heightOf, iconNode, resolveTone, titleOf, tunePie, tuneSeries,
  type WidgetContext, type WidgetDef,
} from './shared';

type Ctx = WidgetContext<Hr>;

function calibStatus(pct: number): { label: string; variant: BadgeVariant } {
  if (pct >= 100) return { label: 'Completed', variant: 'success' };
  if (pct > 0) return { label: 'In progress', variant: 'warning' };
  return { label: 'Pending', variant: 'neutral' };
}

/** Every existing HR widget — same data, drilldowns and calculations — now
 *  individually addable, arrangeable, and tunable (presentation-only config). */
export const HR_WIDGETS: WidgetDef<Hr>[] = [
  {
    key: 'hr.pending', title: 'Pending reviews', category: 'KPI', defaultSpan: 3,
    supports: { title: true, tone: true, icon: true, cardVariant: true, thresholds: true },
    render: ({ data, cy, drill, config }: Ctx) => (
      <KpiCard label={titleOf({ title: 'Pending reviews' }, config)} value={data.kpis.pending} hint="across all departments" icon={iconNode(config.icon)} tone={resolveTone(config, 'brand', data.kpis.pending)} variant={config.cardVariant}
        onClick={() => drill.open('Pending reviews', 'Outstanding reviewer assignments', () => reportsApi.drilldown.pending({ cycleId: cy }))} />
    ),
  },
  {
    key: 'hr.avgDeptPerformance', title: 'Avg. department performance', category: 'KPI', defaultSpan: 3,
    supports: { title: true, tone: true, icon: true, cardVariant: true, thresholds: true },
    render: ({ data, cy, drill, config }: Ctx) => (
      <KpiCard label={titleOf({ title: 'Avg. department performance' }, config)} value={data.kpis.avgDeptPerformance != null ? `${data.kpis.avgDeptPerformance} / 5` : '—'} hint={`target ${data.target}`} icon={iconNode(config.icon)} tone={resolveTone(config, 'teal', data.kpis.avgDeptPerformance ?? undefined)} variant={config.cardVariant}
        progress={data.kpis.avgDeptPerformance != null ? { value: data.kpis.avgDeptPerformance, max: data.target } : undefined}
        onClick={() => drill.open('Scored participants', 'Underlying scores behind the average', () => reportsApi.drilldown.participants({ cycleId: cy, band: 'scored' }))} />
    ),
  },
  {
    key: 'hr.trainingNeeds', title: 'Training needs identified', category: 'KPI', defaultSpan: 3,
    supports: { title: true, tone: true, icon: true, cardVariant: true },
    render: ({ data, cy, drill, config }: Ctx) => (
      <KpiCard label={titleOf({ title: 'Training needs identified' }, config)} value={data.kpis.trainingNeeds} hint="from gap analysis" icon={iconNode(config.icon)} tone={resolveTone(config, 'amber')} variant={config.cardVariant}
        onClick={() => drill.open('Training needs', 'Employees scored below target on any competency', () => reportsApi.drilldown.competency({ cycleId: cy, belowTarget: true }))} />
    ),
  },
  {
    key: 'hr.calibration', title: 'Calibration status', category: 'KPI', defaultSpan: 3,
    supports: { title: true, tone: true, icon: true, cardVariant: true, thresholds: true },
    render: ({ data, cy, drill, config }: Ctx) => (
      <KpiCard label={titleOf({ title: 'Calibration status' }, config)} value={`${data.kpis.calibrationPct}%`} hint={`${data.kpis.departmentsCompleted}/${data.kpis.departmentsTotal} departments completed`} icon={iconNode(config.icon)} tone={resolveTone(config, 'rose', data.kpis.calibrationPct)} variant={config.cardVariant}
        progress={{ value: data.kpis.calibrationPct, max: 100 }}
        onClick={() => drill.open('Scored participants', 'Records feeding calibration progress', () => reportsApi.drilldown.participants({ cycleId: cy, band: 'scored' }))} />
    ),
  },
  {
    key: 'hr.pendingByDept', title: 'Pending reviews by department', category: 'Chart', defaultSpan: 6,
    supports: { title: true, chartTypes: ['bar', 'hbar', 'line', 'area'], color: true, dataLabels: true, sort: true, height: true, emptyText: true },
    render: ({ data, cy, drill, config, palette }: Ctx) => {
      const rows = arrange(data.pendingByDepartment, (r) => r.pending, config);
      const option: EChartsOption = tuneSeries({
        tooltip: { trigger: 'axis' }, grid: { left: 40, right: 20, top: 20, bottom: 60 },
        xAxis: { type: 'category', data: rows.map((r) => r.department), axisLabel: { rotate: 20 } },
        yAxis: { type: 'value', minInterval: 1 },
        series: [{ type: 'bar', name: 'Pending', data: rows.map((r) => r.pending), itemStyle: { borderRadius: [4, 4, 0, 0] } }],
      }, config, palette[0], palette);
      return (
        <Panel title={titleOf({ title: 'Pending reviews by department' }, config)}>
          {rows.length === 0 ? <Empty text={emptyOf(config, 'No pending reviews. 🎉')} /> : (
            <EChart option={option} height={heightOf(config, 280)} onClick={(p) => drill.open(`${p.name} — pending reviews`, 'Outstanding reviewer assignments', () => reportsApi.drilldown.pending({ cycleId: cy, department: p.name }))} />
          )}
        </Panel>
      );
    },
  },
  {
    key: 'hr.deptPerformance', title: 'Department performance comparison', category: 'Chart', defaultSpan: 6,
    supports: { title: true, chartTypes: ['bar', 'hbar', 'line', 'area', 'radar'], color: true, dataLabels: true, sort: true, height: true, emptyText: true },
    render: ({ data, cy, drill, config, palette }: Ctx) => {
      const rows = arrange(data.byDepartment, (r) => r.avgScore ?? 0, config);
      const option: EChartsOption = tuneSeries({
        tooltip: { trigger: 'axis' }, grid: { left: 40, right: 20, top: 20, bottom: 60 },
        xAxis: { type: 'category', data: rows.map((r) => r.department), axisLabel: { rotate: 20 } },
        yAxis: { type: 'value', max: 5 },
        series: [{
          type: 'bar', name: 'Avg score',
          data: rows.map((r) => ({
            value: r.avgScore ?? 0,
            itemStyle: { color: r.avgScore == null ? '#cbd5e1' : r.avgScore >= data.target ? '#10b981' : r.avgScore >= data.target - 1 ? '#f5a524' : '#fb7185', borderRadius: [4, 4, 0, 0] },
          })),
        }],
      }, config, palette[1], palette);
      return (
        <Panel title={titleOf({ title: 'Department performance comparison' }, config)}>
          {rows.length === 0 ? <Empty text={emptyOf(config, 'No department data yet.')} /> : (
            <EChart option={option} height={heightOf(config, 280)} onClick={(p) => drill.open(`${p.name} — participants`, 'Department drill-down', () => reportsApi.drilldown.participants({ cycleId: cy, department: p.name }))} />
          )}
        </Panel>
      );
    },
  },
  {
    key: 'hr.trainingByCompetency', title: 'Training needs by competency', category: 'Chart', defaultSpan: 6,
    supports: { title: true, chartTypes: ['doughnut', 'pie', 'hbar', 'bar'], legend: true, dataLabels: true, sort: true, height: true, emptyText: true },
    render: ({ data, cy, drill, config, palette }: Ctx) => {
      const rows = arrange(data.trainingNeeds, (t) => t.count, config);
      const option: EChartsOption = tunePie({
        tooltip: { trigger: 'item' }, legend: { bottom: 0, type: 'scroll' },
        series: [{ type: 'pie', radius: ['45%', '72%'], label: { show: false }, data: rows.map((t, i) => ({ value: t.count, name: t.competency, itemStyle: { color: palette[i % palette.length] } })) }],
      }, config, palette);
      return (
        <Panel title={titleOf({ title: 'Training needs by competency' }, config)}>
          {rows.length === 0 ? <Empty text={emptyOf(config, 'No competencies below target — no training needs flagged.')} /> : (
            <EChart option={option} height={heightOf(config, 280)} onClick={(p) => drill.open(`${p.name} — below target`, 'Employees needing development on this competency', () => reportsApi.drilldown.competency({ cycleId: cy, competency: p.name, belowTarget: true }))} />
          )}
        </Panel>
      );
    },
  },
  {
    key: 'hr.calibrationByDept', title: 'Calibration status by department', category: 'Table', defaultSpan: 6,
    supports: { title: true, sort: true, emptyText: true },
    render: ({ data, cy, drill, config }: Ctx) => {
      const rows = arrange(data.byDepartment, (d) => d.completionPct, config);
      return (
        <Panel title={titleOf({ title: 'Calibration status by department' }, config)}>
          {rows.length === 0 ? <Empty text={emptyOf(config, 'No department data yet.')} /> : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground">
                  <tr><th className="p-3">Department</th><th className="p-3">Status</th><th className="p-3 w-40">Progress</th></tr>
                </thead>
                <tbody>
                  {rows.map((d) => {
                    const status = calibStatus(d.completionPct);
                    return (
                      <tr key={d.department} onClick={() => drill.open(`${d.department} — participants`, 'Calibration drill-down', () => reportsApi.drilldown.participants({ cycleId: cy, department: d.department }))}
                        className="cursor-pointer border-t border-border transition-colors hover:bg-muted/40">
                        <td className="p-3 font-medium">{d.department}</td>
                        <td className="p-3"><Badge variant={status.variant}>{status.label}</Badge></td>
                        <td className="p-3">
                          <div className="flex items-center gap-2">
                            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-brand" style={{ width: `${d.completionPct}%` }} /></div>
                            <span className="w-9 text-right text-xs text-muted-foreground">{d.completionPct}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      );
    },
  },
];

/** Default arrangement — reproduces the current HR dashboard layout. */
export const HR_DEFAULT_LAYOUT: LayoutItem[] = [
  { key: 'hr.pending', span: 3 }, { key: 'hr.avgDeptPerformance', span: 3 }, { key: 'hr.trainingNeeds', span: 3 }, { key: 'hr.calibration', span: 3 },
  { key: 'hr.pendingByDept', span: 6 }, { key: 'hr.deptPerformance', span: 6 },
  { key: 'hr.trainingByCompetency', span: 6 }, { key: 'hr.calibrationByDept', span: 6 },
];
