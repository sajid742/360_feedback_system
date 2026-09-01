import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Download, GripVertical, LayoutGrid, Palette, Plus, RotateCcw, Save, Settings2, SlidersHorizontal, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { DataGridModal, DrilldownShell } from '@/components/shared/DataGridModal';
import { usePermissions } from '@/features/auth/AuthContext';
import { appraisalApi, type Cycle } from '@/features/appraisal/api';
import { reportsApi, type DashboardLayout, type DashboardType, type LayoutItem } from '../api';
import { useDrilldown } from '../useDrilldown';
import { EmployeeDrilldown } from '../EmployeeDrilldown';
import { DEFAULT_THEME, SPAN_PRESETS, THEMES, clampSpan, isTheme, paletteFor, type WidgetConfig, type WidgetDef } from './shared';
import { WidgetSettings } from './WidgetSettings';

interface Props<T> {
  type: DashboardType;
  title: string;
  description: string;
  icon: ReactNode;
  widgets: WidgetDef<T>[];
  defaultLayout: LayoutItem[];
  fetchData: (cycleId?: string) => Promise<T>;
  /** The configured target score, read from the loaded bundle. */
  targetOf: (data: T) => number;
}

/**
 * Renders a dashboard from a saved (per-org) layout of EXISTING widgets, and — for
 * users with `reports.dashboard.configure` — an inline editor to add/remove,
 * drag-reorder, resize, re-theme, and tune each widget (presentation-only config),
 * then preview, publish, reset, or export/import the layout. Everything the widgets
 * do (data, drill-downs, calculations, the global cycle filter) is unchanged; this
 * component only decides which widgets render, in what order/size, and how they look.
 */
export function ConfigurableDashboard<T>({ type, title, description, icon, widgets, defaultLayout, fetchData, targetOf }: Props<T>): JSX.Element {
  const { has } = usePermissions();
  const canConfigure = has('reports.dashboard.configure');

  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [cycleId, setCycleId] = useState('');
  const [data, setData] = useState<T | null>(null);
  // A failed load used to leave `data` null forever — rendering as a permanent
  // skeleton with no explanation and no way to retry.
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const drill = useDrilldown();
  const cy = cycleId || undefined;
  // Shown under the employee's name in the drill-down so it's obvious which cycle
  // the numbers belong to.
  const cycleLabel = cy ? cycles.find((c) => c.id === cy)?.name : 'All cycles';

  const [published, setPublished] = useState<DashboardLayout | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<LayoutItem[]>([]);
  const [theme, setTheme] = useState<string>(DEFAULT_THEME);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [settingsKey, setSettingsKey] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const byKey = useMemo(() => new Map(widgets.map((w) => [w.key, w])), [widgets]);

  useEffect(() => { appraisalApi.listCycles().then(setCycles).catch(() => undefined); }, []);
  // `alive` also settles a race the old version had: switching cycle twice in
  // quick succession could let the FIRST response land last and win.
  useEffect(() => {
    let alive = true;
    setData(null);
    setLoadError(false);
    fetchData(cycleId || undefined)
      .then((d) => { if (alive) setData(d); })
      .catch(() => { if (alive) setLoadError(true); });
    return () => { alive = false; };
  }, [cycleId, fetchData, reloadKey]);
  useEffect(() => { reportsApi.getLayout(type).then((r) => setPublished(r.layout ?? null)).catch(() => setPublished(null)); }, [type]);

  // The layout actually shown: draft while editing, else the published or code default.
  const activeWidgets = editing ? draft : (published?.widgets ?? defaultLayout);
  const activeTheme = editing ? theme : (published?.theme ?? DEFAULT_THEME);
  const palette = useMemo(() => paletteFor(activeTheme), [activeTheme]);
  // Only render widgets that still exist in the registry (skip unknown keys safely).
  const visible = activeWidgets.filter((i) => byKey.has(i.key));
  const available = widgets.filter((w) => !draft.some((d) => d.key === w.key));
  const settingsDef = settingsKey ? byKey.get(settingsKey) : undefined;
  const settingsItem = settingsKey ? draft.find((d) => d.key === settingsKey) : undefined;

  function startEdit() {
    setDraft((published?.widgets ?? defaultLayout).map((i) => ({ ...i, config: i.config ? { ...i.config } : undefined })));
    setTheme(published?.theme ?? DEFAULT_THEME);
    setEditing(true); setPreview(false); setMsg(null);
  }
  function addWidget(key: string) { const def = byKey.get(key); if (def) setDraft((d) => [...d, { key, span: def.defaultSpan }]); }
  function removeWidget(key: string) { setDraft((d) => d.filter((i) => i.key !== key)); if (settingsKey === key) setSettingsKey(null); }
  function resize(key: string, span: number) { setDraft((d) => d.map((i) => (i.key === key ? { ...i, span } : i))); }
  function updateConfig(key: string, cfg: WidgetConfig) {
    setDraft((d) => d.map((i) => (i.key === key ? { ...i, config: Object.keys(cfg).length ? (cfg as Record<string, unknown>) : undefined } : i)));
  }

  function onDrop(targetKey: string) {
    if (!dragKey || dragKey === targetKey) return;
    setDraft((d) => {
      const from = d.findIndex((i) => i.key === dragKey);
      const to = d.findIndex((i) => i.key === targetKey);
      if (from < 0 || to < 0) return d;
      const next = [...d];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setDragKey(null);
  }

  function currentDraftLayout(): DashboardLayout {
    return { widgets: draft.map((i) => ({ key: i.key, span: clampSpan(i.span), ...(i.config ? { config: i.config } : {}) })), theme };
  }

  async function publish() {
    setBusy(true); setMsg(null);
    try { const r = await reportsApi.saveLayout(type, currentDraftLayout()); setPublished(r.layout); setEditing(false); setMsg('Layout published.'); }
    catch { setMsg('Could not save the layout.'); }
    finally { setBusy(false); }
  }
  async function reset() {
    setBusy(true); setMsg(null);
    try { await reportsApi.resetLayout(type); setPublished(null); setTheme(DEFAULT_THEME); setEditing(false); setMsg('Reset to the default layout.'); }
    catch { setMsg('Could not reset the layout.'); }
    finally { setBusy(false); }
  }

  function exportLayout() {
    const blob = new Blob([JSON.stringify(currentDraftLayout(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `dashboard-${type}-layout.json`; a.click();
    URL.revokeObjectURL(url);
  }
  function importLayout(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as DashboardLayout;
        if (!parsed || !Array.isArray(parsed.widgets)) throw new Error('bad shape');
        const next = parsed.widgets
          .filter((w) => w && typeof w.key === 'string' && byKey.has(w.key))
          .map((w) => ({ key: w.key, span: clampSpan(Number(w.span)), config: (w.config && typeof w.config === 'object') ? w.config : undefined }));
        setDraft(next);
        if (isTheme(parsed.theme)) setTheme(parsed.theme as string);
        setMsg('Layout imported — review and Publish to save.');
      } catch { setMsg('That file is not a valid dashboard layout.'); }
    };
    reader.readAsText(file);
  }

  return (
    <div className="grid gap-6">
      {/* Header + global cycle filter (unchanged) + customize controls */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between print:hidden">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-brand/10 text-brand">{icon}</span>
            <h1 className="text-2xl font-extrabold tracking-tight">{title}</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        <div className="flex items-end gap-3">
          <div className="grid gap-1">
            <Label htmlFor={`cycle-${type}`} className="text-xs">Appraisal cycle</Label>
            <select id={`cycle-${type}`} value={cycleId} onChange={(e) => setCycleId(e.target.value)} className="h-10 rounded-md border border-input bg-card px-3 text-sm">
              <option value="">All cycles</option>
              {cycles.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
            </select>
          </div>
          {canConfigure && !editing && (
            <Button variant="outline" onClick={startEdit}><Settings2 className="size-4" /> Customize</Button>
          )}
        </div>
      </div>

      {/* Editor toolbar */}
      {editing && (
        <div className="flex flex-col gap-3 rounded-lg border border-brand/30 bg-brand/5 p-3 print:hidden">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-brand"><LayoutGrid className="size-4" /> Editing layout — drag to reorder, resize, tune (gear), add or remove widgets.</div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1 text-xs text-muted-foreground"><Palette className="size-3.5" /> Theme</span>
              <select value={theme} onChange={(e) => setTheme(e.target.value)} className="h-8 rounded-md border border-input bg-card px-2 text-xs">
                {THEMES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
              <Button variant="ghost" size="sm" onClick={() => setPreview((p) => !p)}>{preview ? 'Show controls' : 'Preview'}</Button>
              <Button variant="ghost" size="sm" onClick={exportLayout}><Download className="size-4" /> Export</Button>
              <Button variant="ghost" size="sm" onClick={() => fileInput.current?.click()}><Upload className="size-4" /> Import</Button>
              <input ref={fileInput} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importLayout(f); e.target.value = ''; }} />
              <Button variant="ghost" size="sm" onClick={reset} disabled={busy}><RotateCcw className="size-4" /> Reset to default</Button>
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={busy}><X className="size-4" /> Cancel</Button>
              <Button size="sm" onClick={publish} disabled={busy}><Save className="size-4" /> Publish</Button>
            </div>
          </div>
          {!preview && available.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground"><Plus className="mr-1 inline size-3.5" />Add widget:</span>
              {available.map((w) => (
                <button key={w.key} onClick={() => addWidget(w.key)} className="rounded-full border border-border bg-card px-2.5 py-1 text-xs hover:bg-muted">
                  {w.title} <span className="text-muted-foreground">· {w.category}</span>
                </button>
              ))}
            </div>
          )}
          {!preview && visible.length === 0 && <p className="text-xs text-muted-foreground">No widgets in this layout yet — add some above.</p>}
        </div>
      )}

      {msg && <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 print:hidden">{msg}</div>}

      {/* The grid */}
      {loadError ? (
        <div className="grid justify-items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 p-10 text-center">
          <p className="text-sm font-semibold">This dashboard could not load its data.</p>
          <p className="text-xs text-muted-foreground">
            The report service did not respond. Your saved layout is unaffected.
          </p>
          <Button variant="outline" size="sm" className="mt-1" onClick={() => setReloadKey((k) => k + 1)}>
            <RotateCcw className="size-4" /> Try again
          </Button>
        </div>
      ) : !data ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 print:grid-cols-12">
          {visible.map((item) => {
            const def = byKey.get(item.key)!;
            const span = clampSpan(item.span);
            const showChrome = editing && !preview;
            return (
              <div key={item.key} style={{ gridColumn: `span ${span}` }} className="relative min-w-0"
                onDragOver={(e) => { if (showChrome) e.preventDefault(); }} onDrop={() => showChrome && onDrop(item.key)}>
                {showChrome && (
                  <div className="absolute -top-2 right-2 z-10 flex items-center gap-1 rounded-md border border-border bg-card px-1 py-0.5 shadow-sm">
                    <span className="cursor-grab px-1 text-muted-foreground" draggable onDragStart={() => setDragKey(item.key)} onDragEnd={() => setDragKey(null)} title="Drag to reorder"><GripVertical className="size-3.5" /></span>
                    <select value={span} onChange={(e) => resize(item.key, Number(e.target.value))} className="h-6 rounded border border-input bg-card px-1 text-xs" title="Width">
                      {SPAN_PRESETS.map((p) => <option key={p.span} value={p.span}>{p.label}</option>)}
                    </select>
                    {def.supports && (
                      <button onClick={() => setSettingsKey(item.key)} className="px-1 text-muted-foreground hover:text-brand" title="Settings"><SlidersHorizontal className="size-3.5" /></button>
                    )}
                    <button onClick={() => removeWidget(item.key)} className="px-1 text-muted-foreground hover:text-danger" title="Remove"><X className="size-3.5" /></button>
                  </div>
                )}
                <div className={showChrome ? 'pointer-events-none rounded-lg ring-1 ring-dashed ring-brand/40' : ''}>
                  {def.render({ data, cy, target: targetOf(data), drill, config: (item.config as WidgetConfig) ?? {}, palette })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {settingsDef && settingsKey && (
        <WidgetSettings def={settingsDef} config={(settingsItem?.config as WidgetConfig) ?? {}}
          onChange={(next) => updateConfig(settingsKey, next)} onClose={() => setSettingsKey(null)} />
      )}

      {/* Drill-down levels share one modal frame: a record grid, and — one level
          deeper — the selected employee's 360 breakdown, with Back to return. */}
      {drill.view?.kind === 'grid' ? (
        <DataGridModal
          title={drill.view.title}
          subtitle={drill.view.subtitle}
          data={drill.data}
          loading={drill.loading}
          onClose={drill.close}
          onBack={drill.canGoBack ? drill.back : undefined}
          onRowClick={(row) => {
            const id = row.employeeId;
            if (typeof id === 'string' && id) drill.openEmployee(id, String(row.name ?? 'Employee'), cycleLabel, cy);
          }}
          rowClickable={(row) => typeof row.employeeId === 'string' && Boolean(row.employeeId)}
        />
      ) : drill.view?.kind === 'employee' ? (
        <DrilldownShell
          title={drill.view.title}
          subtitle={drill.view.subtitle}
          onBack={drill.canGoBack ? drill.back : undefined}
          onClose={drill.close}
          wide
        >
          <EmployeeDrilldown employeeId={drill.view.employeeId} cycleId={drill.view.cycleId} />
        </DrilldownShell>
      ) : null}
    </div>
  );
}
