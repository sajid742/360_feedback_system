import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

export type DashboardType = 'executive' | 'hr';

/** Presentation-only per-widget config (kept opaque/sanitized here). */
export type WidgetConfig = Record<string, unknown>;
export interface LayoutItem { key: string; span: number; config?: WidgetConfig }
export interface DashboardLayout { widgets: LayoutItem[]; theme?: string }

const MODULE = 'dashboards';
const VALID_SPANS = new Set([3, 4, 6, 8, 12]);

// Allow-lists mirror the frontend registry — the server is the security boundary, so
// anything not on these lists is dropped rather than stored.
const THEMES = new Set(['brand', 'ocean', 'sunset', 'forest', 'slate', 'colorblind']);
const TONES = new Set(['brand', 'teal', 'violet', 'amber', 'rose', 'slate']);
// Mirrors ChartType in apps/web/src/features/reports/dashboard/shared.tsx.
const CHART_TYPES = new Set(['bar', 'hbar', 'line', 'area', 'pie', 'doughnut', 'radar']);
// Mirrors CardVariant in the same file.
const CARD_VARIANTS = new Set(['gradient', 'compact', 'outline', 'progress', 'plain']);
const SORTS = new Set(['asc', 'desc']);
// Mirrors HEIGHT_MIN / HEIGHT_MAX in the same file.
const HEIGHT_MIN = 160;
const HEIGHT_MAX = 720;
const ICONS = new Set(['users', 'check', 'gauge', 'award', 'star', 'trend', 'alert', 'target', 'layers', 'grad', 'clock', 'bars', 'percent', 'spark']);
const HEX = /^#[0-9a-fA-F]{6}$/;

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}
function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Sanitize a widget's presentation config: keep only allow-listed keys, coerce/clamp
 * every value, and drop anything unrecognised. Returns undefined when nothing survives
 * (so an empty config is not persisted). This is purely cosmetic — it can never widen
 * data access, since the widgets read the same already-scoped bundles regardless.
 */
function sanitizeConfig(raw: unknown): WidgetConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: WidgetConfig = {};

  const title = str(r.title, 80); if (title) out.title = title;
  const emptyText = str(r.emptyText, 120); if (emptyText) out.emptyText = emptyText;
  if (typeof r.chartType === 'string' && CHART_TYPES.has(r.chartType)) out.chartType = r.chartType;
  if (typeof r.showLegend === 'boolean') out.showLegend = r.showLegend;
  if (typeof r.showDataLabels === 'boolean') out.showDataLabels = r.showDataLabels;
  if (typeof r.color === 'string' && HEX.test(r.color)) out.color = r.color;
  if (typeof r.sort === 'string' && SORTS.has(r.sort)) out.sort = r.sort;
  const topN = num(r.topN); if (topN != null && topN >= 1) out.topN = Math.min(100, Math.floor(topN));
  if (typeof r.tone === 'string' && TONES.has(r.tone)) out.tone = r.tone;
  if (typeof r.icon === 'string' && ICONS.has(r.icon)) out.icon = r.icon;
  if (typeof r.cardVariant === 'string' && CARD_VARIANTS.has(r.cardVariant)) out.cardVariant = r.cardVariant;
  const height = num(r.height);
  if (height != null) out.height = Math.max(HEIGHT_MIN, Math.min(HEIGHT_MAX, Math.round(height)));

  if (r.thresholds && typeof r.thresholds === 'object') {
    const t = r.thresholds as Record<string, unknown>;
    const th: WidgetConfig = {};
    const good = num(t.good); if (good != null) th.good = good;
    const warn = num(t.warn); if (warn != null) th.warn = warn;
    if (typeof t.higherIsBetter === 'boolean') th.higherIsBetter = t.higherIsBetter;
    if (th.good != null || th.warn != null) out.thresholds = th;
  }

  return Object.keys(out).length ? out : undefined;
}

/**
 * Per-organization Executive/HR dashboard layouts, stored in the EXISTING
 * `configurations` table (module='dashboards', key='executive'|'hr'). No new
 * table. A missing row means "use the code default", so Reset simply deletes it.
 * The server stores an opaque, sanitized layout; the widget *catalogue* lives in the
 * frontend registry (existing widgets only — no new KPIs, data, or drill-downs). All
 * config here is presentation-only.
 */
@Injectable()
export class DashboardLayoutService {
  constructor(private readonly prisma: PrismaService) {}

  private assertType(type: string): asserts type is DashboardType {
    if (type !== 'executive' && type !== 'hr') throw new BadRequestException('Unknown dashboard type.');
  }

  /** Saved layout for a dashboard, or null when none is saved (→ default). */
  async get(organizationId: string, type: string): Promise<DashboardLayout | null> {
    this.assertType(type);
    const row = await this.prisma.configuration.findFirst({
      where: { organizationId, module: MODULE, key: type, deletedAt: null },
      select: { value: true },
    });
    return (row?.value as unknown as DashboardLayout) ?? null;
  }

  /** Publish/save a layout. Validates shape defensively and sanitizes all config;
   *  unknown widget keys are tolerated (the frontend ignores keys not in its registry). */
  async save(organizationId: string, type: string, layout: DashboardLayout): Promise<DashboardLayout> {
    this.assertType(type);
    if (!layout || !Array.isArray(layout.widgets)) throw new BadRequestException('A layout must contain a widgets array.');
    const seen = new Set<string>();
    const widgets: LayoutItem[] = [];
    for (const w of layout.widgets) {
      if (!w || typeof w.key !== 'string' || !w.key) throw new BadRequestException('Each widget needs a key.');
      if (w.key.length > 64 || seen.has(w.key)) continue; // cap key length + de-dupe
      seen.add(w.key);
      const span = VALID_SPANS.has(Number(w.span)) ? Number(w.span) : 6;
      const config = sanitizeConfig(w.config);
      widgets.push(config ? { key: w.key, span, config } : { key: w.key, span });
    }
    if (widgets.length > 50) throw new BadRequestException('Too many widgets in a layout.');
    const theme = typeof layout.theme === 'string' && THEMES.has(layout.theme) ? layout.theme : undefined;
    const clean: DashboardLayout = theme ? { widgets, theme } : { widgets };
    const value = clean as unknown as Prisma.InputJsonValue;

    // Manual upsert: the configurations table uses a partial unique index.
    const existing = await this.prisma.configuration.findFirst({
      where: { organizationId, module: MODULE, key: type, deletedAt: null },
      select: { id: true },
    });
    if (existing) await this.prisma.configuration.update({ where: { id: existing.id }, data: { value } });
    else await this.prisma.configuration.create({ data: { organizationId, module: MODULE, key: type, value } });
    return clean;
  }

  /** Reset to default: delete the saved row so the code default takes over. */
  async reset(organizationId: string, type: string): Promise<void> {
    this.assertType(type);
    await this.prisma.configuration.deleteMany({ where: { organizationId, module: MODULE, key: type } });
  }
}
