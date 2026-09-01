import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  CARD_VARIANTS, CHART_LABEL, HEIGHT_MAX, HEIGHT_MIN, KPI_ICONS,
  type CardVariant, type ChartType, type SortDir, type StatCardTone, type WidgetConfig, type WidgetDef,
} from './shared';

const TONES: StatCardTone[] = ['brand', 'teal', 'violet', 'amber', 'rose', 'slate'];

const field = 'h-9 w-full rounded-md border border-input bg-card px-2 text-sm';
const rowLabel = 'text-xs font-medium text-muted-foreground';

/**
 * Presentation-only settings form for a single widget. Fields are driven entirely by
 * the widget's `supports` descriptor, so a widget only ever exposes options it can
 * actually honour. Emitting `undefined` for a field clears it (→ back to the built-in
 * default). Nothing here touches data, scope, calculations, or drill-down targets.
 */
export function WidgetSettings<T>({ def, config, onChange, onClose }: {
  def: WidgetDef<T>;
  config: WidgetConfig;
  onChange: (next: WidgetConfig) => void;
  onClose: () => void;
}): JSX.Element {
  const s = def.supports ?? {};
  const set = (patch: Partial<WidgetConfig>): void => onChange({ ...config, ...patch });
  const chartTypes = s.chartTypes ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 print:hidden" onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-bold">Widget settings — {def.title}</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground" title="Close"><X className="size-4" /></button>
        </div>

        <div className="grid max-h-[60vh] gap-3 overflow-y-auto pr-1">
          {s.title && (
            <label className="grid gap-1">
              <span className={rowLabel}>Title</span>
              <input className={field} value={config.title ?? ''} placeholder={def.title} maxLength={80}
                onChange={(e) => set({ title: e.target.value || undefined })} />
            </label>
          )}

          {s.cardVariant && (
            <label className="grid gap-1">
              <span className={rowLabel}>Card style</span>
              <select className={field} value={config.cardVariant ?? ''} onChange={(e) => set({ cardVariant: (e.target.value || undefined) as CardVariant | undefined })}>
                {CARD_VARIANTS.map((v) => <option key={v.key} value={v.key === 'gradient' ? '' : v.key}>{v.label}</option>)}
              </select>
            </label>
          )}

          {s.tone && (
            <label className="grid gap-1">
              <span className={rowLabel}>Card colour</span>
              <select className={field} value={config.tone ?? ''} onChange={(e) => set({ tone: (e.target.value || undefined) as StatCardTone | undefined })}>
                <option value="">Default</option>
                {TONES.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
              </select>
            </label>
          )}

          {s.icon && (
            <label className="grid gap-1">
              <span className={rowLabel}>Icon</span>
              <select className={field} value={config.icon ?? ''} onChange={(e) => set({ icon: e.target.value || undefined })}>
                <option value="">None</option>
                {KPI_ICONS.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}
              </select>
            </label>
          )}

          {s.thresholds && (
            <div className="grid gap-2 rounded-md border border-border/70 bg-muted/30 p-2">
              <span className={rowLabel}>Conditional colour (by value)</span>
              <div className="grid grid-cols-2 gap-2">
                <label className="grid gap-1">
                  <span className="text-[11px] text-muted-foreground">Good ≥ / ≤</span>
                  <input type="number" step="any" className={field} value={config.thresholds?.good ?? ''}
                    onChange={(e) => set({ thresholds: { ...config.thresholds, good: e.target.value === '' ? undefined : Number(e.target.value) } })} />
                </label>
                <label className="grid gap-1">
                  <span className="text-[11px] text-muted-foreground">Warn ≥ / ≤</span>
                  <input type="number" step="any" className={field} value={config.thresholds?.warn ?? ''}
                    onChange={(e) => set({ thresholds: { ...config.thresholds, warn: e.target.value === '' ? undefined : Number(e.target.value) } })} />
                </label>
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={config.thresholds?.higherIsBetter !== false}
                  onChange={(e) => set({ thresholds: { ...config.thresholds, higherIsBetter: e.target.checked } })} />
                Higher value is better
              </label>
              {(config.thresholds?.good != null || config.thresholds?.warn != null) && (
                <button className="justify-self-start text-[11px] text-brand hover:underline" onClick={() => set({ thresholds: undefined })}>Clear thresholds</button>
              )}
            </div>
          )}

          {chartTypes.length > 1 && (
            <label className="grid gap-1">
              <span className={rowLabel}>Chart type</span>
              <select className={field} value={config.chartType ?? ''} onChange={(e) => set({ chartType: (e.target.value || undefined) as ChartType | undefined })}>
                <option value="">Default</option>
                {chartTypes.map((t) => <option key={t} value={t}>{CHART_LABEL[t]}</option>)}
              </select>
              {config.chartType === 'radar' && (
                <span className="text-[11px] text-muted-foreground">
                  A radar compares the whole set at once, so clicking it does not drill down.
                </span>
              )}
            </label>
          )}

          {s.height && (
            <label className="grid gap-1">
              <span className={rowLabel}>Chart height — {config.height ?? 'default'}{config.height ? 'px' : ''}</span>
              <div className="flex items-center gap-2">
                <input type="range" min={HEIGHT_MIN} max={HEIGHT_MAX} step={20} className="h-9 flex-1"
                  value={config.height ?? 280}
                  onChange={(e) => set({ height: Number(e.target.value) })} />
                {config.height != null && (
                  <button className="whitespace-nowrap text-[11px] text-brand hover:underline" onClick={() => set({ height: undefined })}>Reset</button>
                )}
              </div>
            </label>
          )}

          {s.color && (
            <label className="grid gap-1">
              <span className={rowLabel}>Series colour</span>
              <div className="flex items-center gap-2">
                <input type="color" className="h-9 w-12 rounded border border-input bg-card" value={config.color ?? '#6d5dfc'}
                  onChange={(e) => set({ color: e.target.value })} />
                {config.color && <button className="text-[11px] text-brand hover:underline" onClick={() => set({ color: undefined })}>Use theme colour</button>}
              </div>
            </label>
          )}

          {s.legend && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={config.showLegend !== false} onChange={(e) => set({ showLegend: e.target.checked })} />
              Show legend
            </label>
          )}

          {s.dataLabels && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={config.showDataLabels === true} onChange={(e) => set({ showDataLabels: e.target.checked || undefined })} />
              Show data labels
            </label>
          )}

          {s.sort && (
            <div className="grid grid-cols-2 gap-2">
              <label className="grid gap-1">
                <span className={rowLabel}>Sort</span>
                <select className={field} value={config.sort ?? 'none'} onChange={(e) => set({ sort: (e.target.value as SortDir) === 'none' ? undefined : (e.target.value as SortDir) })}>
                  <option value="none">Default order</option>
                  <option value="desc">Highest first</option>
                  <option value="asc">Lowest first</option>
                </select>
              </label>
              <label className="grid gap-1">
                <span className={rowLabel}>Top N (0 = all)</span>
                <input type="number" min={0} max={100} className={field} value={config.topN ?? 0}
                  onChange={(e) => { const n = Math.max(0, Math.min(100, Number(e.target.value) || 0)); set({ topN: n === 0 ? undefined : n }); }} />
              </label>
            </div>
          )}

          {s.emptyText && (
            <label className="grid gap-1">
              <span className={rowLabel}>Empty-state message</span>
              <input className={field} value={config.emptyText ?? ''} maxLength={120} placeholder="Shown when there is no data"
                onChange={(e) => set({ emptyText: e.target.value || undefined })} />
            </label>
          )}
        </div>

        <div className="mt-4 flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => onChange({})}>Reset widget</Button>
          <Button size="sm" onClick={onClose}>Done</Button>
        </div>
      </div>
    </div>
  );
}
