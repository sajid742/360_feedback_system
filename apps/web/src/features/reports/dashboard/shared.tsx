import type { ReactNode } from 'react';
import type { EChartsOption } from 'echarts';
import {
  Users, CheckCircle2, Gauge, Award, Star, TrendingUp, AlertTriangle,
  Target, Layers, GraduationCap, Clock, BarChart3, Percent, Sparkles,
} from 'lucide-react';
import type { useDrilldown } from '../useDrilldown';

/** Card panel used to frame charts/lists/tables — unchanged from the original dashboards. */
export function Panel({ title, children, className }: { title: string; children: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={`rounded-lg border border-border bg-card p-4 shadow-card ${className ?? ''}`}>
      <h3 className="mb-3 text-sm font-bold">{title}</h3>
      {children}
    </div>
  );
}

/** Empty-state block — unchanged from the original dashboards. */
export function Empty({ text }: { text: string }): JSX.Element {
  return <div className="rounded-lg border border-dashed border-border bg-muted/40 p-10 text-center text-sm text-muted-foreground">{text}</div>;
}

export type Drill = ReturnType<typeof useDrilldown>;
export type StatCardTone = 'brand' | 'teal' | 'violet' | 'amber' | 'rose' | 'slate';
export type SortDir = 'none' | 'desc' | 'asc';

/**
 * Chart styles a widget may offer.
 *
 * `bar`, `line`, `pie` and `doughnut` are the original four and keep their exact
 * previous behaviour (see `tuneSeries` / `tunePie`): they TWEAK the option the
 * widget already built. The three added styles change the shape of the chart
 * rather than its trim, so they REBUILD the option from the categories and
 * values carried in it. Any saved layout can only contain one of the original
 * four, so no existing configuration changes rendering path.
 */
export type ChartType = 'bar' | 'hbar' | 'line' | 'area' | 'pie' | 'doughnut' | 'radar';

export const CHART_LABEL: Record<ChartType, string> = {
  bar: 'Bar (vertical)',
  hbar: 'Bar (horizontal)',
  line: 'Line',
  area: 'Area',
  pie: 'Pie',
  doughnut: 'Doughnut',
  radar: 'Radar',
};

/** How a KPI tile is drawn. `gradient` is the original StatCard. */
export type CardVariant = 'gradient' | 'compact' | 'outline' | 'progress' | 'plain';

export const CARD_VARIANTS: { key: CardVariant; label: string }[] = [
  { key: 'gradient', label: 'Gradient (default)' },
  { key: 'compact', label: 'Compact' },
  { key: 'outline', label: 'Outline' },
  { key: 'progress', label: 'Progress to target' },
  { key: 'plain', label: 'Plain number' },
];

/* Chart height bounds. A dashboard row breaks down badly outside these. */
export const HEIGHT_MIN = 160;
export const HEIGHT_MAX = 720;

/**
 * Presentation-only per-widget settings. Every field is optional; an empty object
 * means "render exactly as the widget's built-in default". Nothing here changes the
 * data source, calculation, scope, or drill-down target — it only tunes how the
 * already-fetched, already-scoped bundle is displayed. The backend validates/sanitizes
 * this shape (allow-listed keys, clamped ranges) before it is ever stored.
 *
 * IMPORTANT: every key added here must also be added to `sanitizeConfig()` in
 * `apps/api/src/reports/services/dashboard-layout.service.ts`, which DROPS keys it
 * does not recognise. A field added on one side only appears to save and then
 * silently vanishes.
 */
export interface WidgetConfig {
  /** Override the panel/card heading. */
  title?: string;
  /** Override the empty-state message. */
  emptyText?: string;
  /** Switch the chart to a compatible type (only among the widget's `chartTypes`). */
  chartType?: ChartType;
  /** Show/hide the chart legend. */
  showLegend?: boolean;
  /** Show/hide numeric data labels on the series. */
  showDataLabels?: boolean;
  /** Primary series colour (hex, e.g. #6d5dfc). */
  color?: string;
  /** Sort a category series/list by value. */
  sort?: SortDir;
  /** Keep only the first N rows after sorting (0/undefined = all). */
  topN?: number;
  /** KPI card colour. */
  tone?: StatCardTone;
  /** KPI card icon (key into KPI_ICONS). */
  icon?: string;
  /** KPI card style. */
  cardVariant?: CardVariant;
  /** Chart height in pixels (clamped to HEIGHT_MIN..HEIGHT_MAX). */
  height?: number;
  /** KPI conditional colouring by value. When set, overrides `tone`. */
  thresholds?: { good?: number; warn?: number; higherIsBetter?: boolean };
}

/** Declares which config options a widget accepts — drives the settings form. */
export interface WidgetSupports {
  title?: boolean;
  emptyText?: boolean;
  /** Compatible chart types; a switch is offered when there is more than one. */
  chartTypes?: ChartType[];
  legend?: boolean;
  dataLabels?: boolean;
  color?: boolean;
  /** Sort + Top-N (category series / lists). */
  sort?: boolean;
  tone?: boolean;
  icon?: boolean;
  /** KPI card style picker. */
  cardVariant?: boolean;
  /** Chart height slider. */
  height?: boolean;
  thresholds?: boolean;
}

/** Everything a widget's render needs — the loaded bundle, the active cycle, the
 *  configured target, the shared drill-down handle, the per-widget config, and the
 *  active dashboard colour palette. */
export interface WidgetContext<T> {
  data: T;
  cy: string | undefined; // active cycle filter (undefined = all cycles)
  target: number;
  drill: Drill;
  config: WidgetConfig;
  palette: string[];
}

export type WidgetCategory = 'KPI' | 'Chart' | 'List' | 'Table';

/** A registry entry: an existing dashboard widget, made addable/arrangeable/tunable. */
export interface WidgetDef<T> {
  key: string;
  /** Catalogue label (also the default Panel heading for chart/list/table widgets). */
  title: string;
  category: WidgetCategory;
  /** Default column span on the 12-col grid (3=¼, 4=⅓, 6=½, 8=⅔, 12=full). */
  defaultSpan: number;
  /** Which presentation options this widget exposes in the settings form. */
  supports?: WidgetSupports;
  render: (ctx: WidgetContext<T>) => JSX.Element;
}

/** Column-span presets offered by the resize control. */
export const SPAN_PRESETS: { span: number; label: string }[] = [
  { span: 3, label: 'Quarter' },
  { span: 4, label: 'Third' },
  { span: 6, label: 'Half' },
  { span: 8, label: 'Two-thirds' },
  { span: 12, label: 'Full' },
];

export function clampSpan(span: number): number {
  return SPAN_PRESETS.some((p) => p.span === span) ? span : 6;
}

/* ------------------------------------------------------------------ *
 *  Colour themes (dashboard-level palette) — presentation only.       *
 * ------------------------------------------------------------------ */
const PALETTES: Record<string, string[]> = {
  brand: ['#6d5dfc', '#46c2cb', '#f5a524', '#fb7185', '#8b7dff', '#10b981', '#e67e22'],
  ocean: ['#0ea5e9', '#14b8a6', '#6366f1', '#f43f5e', '#0891b2', '#22c55e', '#f59e0b'],
  sunset: ['#f97316', '#ef4444', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#eab308'],
  forest: ['#16a34a', '#65a30d', '#0d9488', '#ca8a04', '#4d7c0f', '#15803d', '#a16207'],
  slate: ['#475569', '#64748b', '#0ea5e9', '#94a3b8', '#334155', '#0891b2', '#7c8797'],
  // Okabe-Ito colourblind-safe palette.
  colorblind: ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#D55E00', '#F0E442'],
};

export const THEMES: { key: string; label: string }[] = [
  { key: 'brand', label: 'Brand (default)' },
  { key: 'ocean', label: 'Ocean' },
  { key: 'sunset', label: 'Sunset' },
  { key: 'forest', label: 'Forest' },
  { key: 'slate', label: 'Slate' },
  { key: 'colorblind', label: 'Colourblind-safe' },
];

export const DEFAULT_THEME = 'brand';
export function paletteFor(theme?: string): string[] { return PALETTES[theme ?? DEFAULT_THEME] ?? PALETTES.brand; }
export function isTheme(t?: string): boolean { return !!t && t in PALETTES; }

/* ------------------------------------------------------------------ *
 *  KPI icon registry (StatCard already accepts an `icon` node).       *
 * ------------------------------------------------------------------ */
export const KPI_ICONS: { key: string; label: string; node: ReactNode }[] = [
  { key: 'users', label: 'People', node: <Users /> },
  { key: 'check', label: 'Check', node: <CheckCircle2 /> },
  { key: 'gauge', label: 'Gauge', node: <Gauge /> },
  { key: 'award', label: 'Award', node: <Award /> },
  { key: 'star', label: 'Star', node: <Star /> },
  { key: 'trend', label: 'Trend', node: <TrendingUp /> },
  { key: 'alert', label: 'Alert', node: <AlertTriangle /> },
  { key: 'target', label: 'Target', node: <Target /> },
  { key: 'layers', label: 'Layers', node: <Layers /> },
  { key: 'grad', label: 'Training', node: <GraduationCap /> },
  { key: 'clock', label: 'Pending', node: <Clock /> },
  { key: 'bars', label: 'Bars', node: <BarChart3 /> },
  { key: 'percent', label: 'Percent', node: <Percent /> },
  { key: 'spark', label: 'Sparkles', node: <Sparkles /> },
];

export function iconNode(key?: string): ReactNode | undefined {
  if (!key) return undefined;
  return KPI_ICONS.find((i) => i.key === key)?.node;
}

/* ------------------------------------------------------------------ *
 *  Config appliers — small, defensive, presentation-only.             *
 * ------------------------------------------------------------------ */

/** Effective heading: a trimmed custom title, else the widget's default. */
export function titleOf<T>(def: Pick<WidgetDef<T>, 'title'>, config: WidgetConfig): string {
  const t = config.title?.trim();
  return t || def.title;
}

/** Effective empty-state text. */
export function emptyOf(config: WidgetConfig, fallback: string): string {
  const t = config.emptyText?.trim();
  return t || fallback;
}

/** Effective chart height, clamped. */
export function heightOf(config: WidgetConfig, fallback: number): number {
  const h = config.height;
  if (typeof h !== 'number' || !Number.isFinite(h)) return fallback;
  return Math.max(HEIGHT_MIN, Math.min(HEIGHT_MAX, Math.round(h)));
}

/** Sort + Top-N a set of rows by a numeric accessor (both are optional). */
export function arrange<R>(rows: R[], valueOf: (r: R) => number, config: WidgetConfig): R[] {
  let out = rows;
  if (config.sort === 'asc' || config.sort === 'desc') {
    out = [...rows].sort((a, b) => (config.sort === 'asc' ? valueOf(a) - valueOf(b) : valueOf(b) - valueOf(a)));
  }
  if (config.topN && config.topN > 0) out = out.slice(0, config.topN);
  return out;
}

/** Resolve a KPI card tone: conditional thresholds win over an explicit tone. */
export function resolveTone(config: WidgetConfig, fallback: StatCardTone, numeric?: number): StatCardTone {
  const t = config.thresholds;
  if (t && typeof numeric === 'number' && (t.good != null || t.warn != null)) {
    const hib = t.higherIsBetter !== false;
    const meets = (thr?: number): boolean => (thr == null ? false : hib ? numeric >= thr : numeric <= thr);
    if (meets(t.good)) return 'teal';
    if (meets(t.warn)) return 'amber';
    return 'rose';
  }
  return config.tone ?? fallback;
}

/* ------------------------------------------------------------------ *
 *  Chart-style rebuilding                                             *
 *                                                                     *
 *  The original four styles are applied by TWEAKING the option the    *
 *  widget already built. The added styles cannot be reached that way  *
 *  — a radar has no cartesian axes, a horizontal bar swaps them — so  *
 *  they are rebuilt from the categories and values already present in *
 *  the option. Extraction is defensive: anything unexpected returns   *
 *  null and the original option is used unchanged.                    *
 * ------------------------------------------------------------------ */

/** Chart styles that the legacy tweak path already handles for cartesian widgets. */
const NATIVE_CARTESIAN = new Set<string>(['bar', 'line']);
/** Chart styles that the legacy tweak path already handles for pie widgets. */
const NATIVE_PIE = new Set<string>(['pie', 'doughnut']);

interface Extracted { cats: string[]; values: number[]; name?: string; max?: number }

function firstSeries(option: EChartsOption): Record<string, unknown> | undefined {
  const s = option.series as unknown;
  if (Array.isArray(s)) return s[0] as Record<string, unknown> | undefined;
  return (s as Record<string, unknown> | undefined) ?? undefined;
}

/** A datum may be a bare number or `{ value, itemStyle }` (per-item colouring). */
function numOf(d: unknown): number {
  if (d && typeof d === 'object' && 'value' in (d as object)) return Number((d as { value: unknown }).value) || 0;
  return Number(d) || 0;
}

function extractCartesian(option: EChartsOption): Extracted | null {
  const s = firstSeries(option);
  if (!s || !Array.isArray(s.data)) return null;
  const x = option.xAxis as { data?: unknown[] } | undefined;
  if (!x || Array.isArray(x) || !Array.isArray(x.data)) return null;
  const y = option.yAxis as { max?: unknown } | undefined;
  return {
    cats: x.data.map((c) => String(c)),
    values: (s.data as unknown[]).map(numOf),
    name: typeof s.name === 'string' ? s.name : undefined,
    max: typeof y?.max === 'number' ? y.max : undefined,
  };
}

function extractPie(option: EChartsOption): Extracted | null {
  const s = firstSeries(option);
  if (!s || !Array.isArray(s.data)) return null;
  const rows = s.data as unknown[];
  if (!rows.every((r) => r && typeof r === 'object' && 'name' in (r as object))) return null;
  const typed = rows as { name?: unknown; value?: unknown }[];
  return {
    cats: typed.map((r) => String(r.name ?? '')),
    values: typed.map((r) => Number(r.value) || 0),
    name: typeof s.name === 'string' ? s.name : undefined,
  };
}

/** Build a fresh option for the requested style from extracted categories/values. */
function buildChart(e: Extracted, config: WidgetConfig, color: string, palette: string[]): EChartsOption | null {
  const showLabels = config.showDataLabels === true;
  const legendShown = config.showLegend === true;

  switch (config.chartType) {
    case 'hbar':
      // Category axes run bottom-up, so reverse to keep the first row on top.
      return {
        tooltip: { trigger: 'axis' },
        legend: { bottom: 0, show: legendShown },
        grid: { left: 8, right: 28, top: 12, bottom: legendShown ? 32 : 12, containLabel: true },
        xAxis: { type: 'value', ...(e.max != null ? { max: e.max } : {}) },
        yAxis: { type: 'category', data: [...e.cats].reverse(), axisLabel: { width: 150, overflow: 'truncate' } },
        series: [{
          type: 'bar', name: e.name, data: [...e.values].reverse(),
          itemStyle: { color, borderRadius: [0, 4, 4, 0] },
          label: { show: showLabels, position: 'right' },
        }],
      };

    case 'area':
      return {
        tooltip: { trigger: 'axis' },
        legend: { bottom: 0, show: legendShown },
        grid: { left: 40, right: 20, top: 20, bottom: 60 },
        xAxis: { type: 'category', data: e.cats, axisLabel: { rotate: 20 } },
        yAxis: { type: 'value', ...(e.max != null ? { max: e.max } : {}) },
        series: [{
          type: 'line', name: e.name, data: e.values, smooth: true,
          itemStyle: { color }, areaStyle: { opacity: 0.18 },
          label: { show: showLabels, position: 'top' },
        }],
      };

    case 'radar': {
      // A radar compares the whole set at once, so there is no per-category
      // click target: drill-down is unavailable on this style by design.
      const ceiling = e.max ?? Math.max(1, ...e.values);
      return {
        tooltip: {},
        legend: { bottom: 0, show: legendShown },
        radar: { indicator: e.cats.map((c) => ({ name: c, max: ceiling })), radius: '62%' },
        series: [{
          type: 'radar', name: e.name,
          data: [{ value: e.values, name: e.name ?? '' }],
          areaStyle: { opacity: 0.18 }, itemStyle: { color },
          label: { show: showLabels },
        }],
      };
    }

    case 'pie':
    case 'doughnut':
      return {
        tooltip: { trigger: 'item' },
        legend: { bottom: 0, type: 'scroll', show: config.showLegend !== false },
        series: [{
          type: 'pie',
          radius: config.chartType === 'pie' ? ['0%', '72%'] : ['45%', '72%'],
          label: { show: showLabels, formatter: '{b}: {c}' },
          data: e.cats.map((c, i) => ({ name: c, value: e.values[i], itemStyle: { color: palette[i % palette.length] } })),
        }],
      };

    case 'bar':
    case 'line':
      return {
        tooltip: { trigger: 'axis' },
        legend: { bottom: 0, show: legendShown },
        grid: { left: 40, right: 20, top: 20, bottom: 60 },
        xAxis: { type: 'category', data: e.cats, axisLabel: { rotate: 20 } },
        yAxis: { type: 'value', ...(e.max != null ? { max: e.max } : {}) },
        series: [{
          type: config.chartType === 'line' ? 'line' : 'bar',
          name: e.name, data: e.values,
          ...(config.chartType === 'line' ? { smooth: true } : {}),
          itemStyle: { color, ...(config.chartType === 'bar' ? { borderRadius: [4, 4, 0, 0] } : {}) },
          label: { show: showLabels, position: 'top' },
        }],
      };

    default:
      return null;
  }
}

/**
 * Tune a single-series category chart (bar/line/…): type, colour, data labels.
 *
 * `bar` and `line` keep the original in-place tweak so existing saved layouts
 * render byte-for-byte as before. Any other style rebuilds.
 */
export function tuneSeries(option: EChartsOption, config: WidgetConfig, color: string, palette?: string[]): EChartsOption {
  const t = config.chartType;
  if (t && !NATIVE_CARTESIAN.has(t)) {
    const e = extractCartesian(option);
    const rebuilt = e ? buildChart(e, config, config.color || color, palette ?? [color]) : null;
    if (rebuilt) return rebuilt;
    // Extraction failed — fall through and leave the widget's own option alone.
  }

  const s = firstSeries(option);
  if (s) {
    if (t === 'line') {
      s.type = 'line'; s.smooth = true; s.areaStyle = s.areaStyle ?? { opacity: 0.08 };
      const is = s.itemStyle as Record<string, unknown> | undefined; if (is) delete is.borderRadius;
    } else if (t === 'bar') {
      s.type = 'bar'; delete s.areaStyle;
    }
    if (config.color) {
      // A single explicit colour overrides any per-item (threshold) colouring.
      s.itemStyle = { ...(s.itemStyle as object), color: config.color };
      if (Array.isArray(s.data)) {
        s.data = (s.data as unknown[]).map((d) => (d && typeof d === 'object' && 'value' in (d as object) ? (d as { value: unknown }).value : d));
      }
    } else {
      const is = (s.itemStyle as Record<string, unknown>) ?? {};
      if (is.color == null && !Array.isArray(s.data)) s.itemStyle = { ...is, color };
    }
    if (config.showDataLabels === true) s.label = { ...(s.label as object), show: true, position: 'top' };
    else if (config.showDataLabels === false && s.label) s.label = { ...(s.label as object), show: false };
  }
  tuneLegend(option, config);
  return option;
}

/**
 * Tune a pie/doughnut chart: pie vs doughnut radius, labels, legend.
 *
 * `pie` and `doughnut` keep the original in-place tweak. Switching a pie widget
 * to a cartesian or radar style rebuilds from its slice names and values.
 */
export function tunePie(option: EChartsOption, config: WidgetConfig, palette?: string[]): EChartsOption {
  const t = config.chartType;
  if (t && !NATIVE_PIE.has(t)) {
    const e = extractPie(option);
    const color = config.color || palette?.[0] || '#6d5dfc';
    const rebuilt = e ? buildChart(e, config, color, palette ?? [color]) : null;
    if (rebuilt) return rebuilt;
  }

  const s = firstSeries(option);
  if (s && s.type === 'pie') {
    if (t === 'pie') s.radius = ['0%', '72%'];
    else if (t === 'doughnut') s.radius = ['45%', '72%'];
    if (config.showDataLabels === true) s.label = { show: true, formatter: '{b}: {c}' };
    else if (config.showDataLabels === false) s.label = { show: false };
  }
  tuneLegend(option, config);
  return option;
}

/** Toggle legend visibility while preserving its existing position/data. */
export function tuneLegend(option: EChartsOption, config: WidgetConfig): EChartsOption {
  if (config.showLegend === false) option.legend = { ...(option.legend as object), show: false };
  else if (config.showLegend === true) option.legend = { ...(option.legend as object), show: true };
  return option;
}
