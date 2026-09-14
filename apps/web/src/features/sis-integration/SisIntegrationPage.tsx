import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Database, Download, GraduationCap, KeyRound, Loader2, Play, Plug, RefreshCw, Save, Upload } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/api-client';
import { sisApi, type ConnectionField, type SisApplyResult, type SisRun, type SisStatus, type TestResult } from './api';
import { StudentsParentsPanel } from './StudentsParentsPanel';

function fmt(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
}
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('Could not read the file.'));
    r.readAsDataURL(file);
  });
}

export function SisIntegrationPage(): JSX.Element {
  const [status, setStatus] = useState<SisStatus | null>(null);
  const [history, setHistory] = useState<SisRun[]>([]);
  const [result, setResult] = useState<SisApplyResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmLive, setConfirmLive] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    sisApi.status().then(setStatus).catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load status.'));
    sisApi.history().then(setHistory).catch(() => setHistory([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function patch(p: Parameters<typeof sisApi.updateConfig>[0], note?: string) {
    setBusy('config'); setError(null); setMsg(null);
    try { await sisApi.updateConfig(p); if (note) setMsg(note); load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Update failed.'); }
    finally { setBusy(null); }
  }

  /**
   * A live sync that would deactivate or rename records comes back as a PREVIEW
   * with `requiresConfirmation`, having written nothing. The operator then sees
   * exactly what would change and re-sends with `confirm`. A harmless sync — no
   * deactivations, no renames — applies in one step and asks nothing.
   */
  async function runSync(live: boolean, confirm = false) {
    setBusy(live ? 'live' : 'dry'); setError(null); setMsg(null); setConfirmLive(false);
    try {
      const r = await sisApi.sync(live, confirm);
      setResult(r);
      if (r.requiresConfirmation) setMsg('Nothing was written. Review the changes below, then confirm to apply them.');
      else setMsg(live ? 'Sync complete.' : 'Dry run complete — nothing written.');
      load();
    }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Sync failed.'); }
    finally { setBusy(null); }
  }

  /**
   * Same two-step gate as `runSync`. An import that would deactivate, rename or
   * re-point comes back as a PREVIEW with `requiresConfirmation`, having written
   * nothing; the operator reviews the itemised lists and re-sends with `confirm`.
   *
   * The chosen file stays in the input between the two calls, so the confirm step
   * re-reads and re-sends the same workbook rather than asking for it again.
   */
  async function runImport(dryRun: boolean, confirm = false) {
    const file = fileRef.current?.files?.[0];
    if (!file) { setError('Choose an .xlsx or .csv file first.'); return; }
    setBusy(dryRun ? 'dry' : 'live'); setError(null); setMsg(null);
    try {
      const base64 = await fileToBase64(file);
      const entity = /\.csv$/i.test(file.name) ? 'students' : undefined;
      const r = await sisApi.import({ filename: file.name, base64, entity, dryRun, confirm });
      setResult(r);
      if (r.requiresConfirmation) setMsg('Nothing was written. Review the changes below, then confirm to apply them.');
      else if (!dryRun && r.ok) setMsg('Import complete.');
      else if (dryRun) setMsg(r.ok ? 'Validation passed — review, then Import.' : `Validation found ${r.errors.length} error(s).`);
      load();
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Import failed.'); }
    finally { setBusy(null); }
  }

  if (!status) {
    return <div className="grid gap-6"><h1 className="text-2xl font-extrabold tracking-tight">Student Integration</h1><Card className="p-6 text-sm text-muted-foreground">{error ?? 'Loading…'}</Card></div>;
  }

  const current = status.providers.find((p) => p.key === status.provider);
  const isImport = current?.kind === 'import';
  const isSync = current?.kind === 'sync';

  return (
    <div className="grid gap-6">
      <div>
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-brand/10 text-brand"><GraduationCap className="size-4" /></span>
          <h1 className="text-2xl font-extrabold tracking-tight">Student Integration (SIS)</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Bring students, guardians and teachers into the 360 app from your Student Information System. Imported data powers <strong>parent feedback</strong> (student → guardian → teacher → employee) through the existing evaluation and communication modules — unchanged.
        </p>
      </div>

      {error && <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><span>{error}</span></div>}
      {msg && <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700"><CheckCircle2 className="mt-0.5 size-4 shrink-0" /><span>{msg}</span></div>}

      {/*
        One module, three jobs — no new navigation entry. Overview answers "what is
        in the roster and where did it come from"; Integration & sync is the existing
        provider/import/sync administration, unchanged; Students & Parents is the
        browse-and-correct surface.
      */}
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="integration">Integration &amp; sync</TabsTrigger>
          <TabsTrigger value="roster">Students &amp; Parents</TabsTrigger>
        </TabsList>

        <TabsContent value="roster">
          <StudentsParentsPanel />
        </TabsContent>

        <TabsContent value="overview">
          <div className="grid gap-4">
            <Card className="grid gap-3 p-5">
              <h2 className="text-sm font-bold">Where the roster comes from</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Roster students" value={status.dataset ? String(status.dataset.students) : '—'} />
                <Stat label="Roster teachers" value={status.dataset ? String(status.dataset.teachers) : '—'} />
                <Stat label="Last updated" value={status.dataset ? fmt(status.dataset.updatedAt) : 'no data yet'} />
                <Stat label="Source of record" value={status.dataset?.provider ?? status.provider} />
              </div>
              <p className="text-xs text-muted-foreground">
                The <strong>stored roster</strong> above is the single source every part of the 360 app reads —
                parent feedback, teacher mapping and bulk generation all resolve students, guardians and teachers from it.
                A provider sync or an Excel/CSV import refreshes it; corrections made on the
                <strong> Students &amp; Parents</strong> tab are applied to it directly and are marked so a future sync does not undo them.
              </p>
              {status.provider === 'mock' && (
                <p className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:border-sky-900/50 dark:bg-sky-950/40 dark:text-sky-200">
                  <span className="font-semibold">A note on the two &ldquo;mock&rdquo; things, because they are easy to confuse.</span>{' '}
                  The provider selected here is the <strong>built-in sample roster</strong> — a small fixed set of records compiled into the
                  application, used to demonstrate the sync. Separately, the deployment may run a <strong>standalone Mock SIS service</strong>
                  {' '}(its own database, its own admin page on port 3100) which exists to test the vendor <em>connector</em> over HTTP.
                  They hold different data. Whichever you sync from, what the 360 app actually reads is the stored roster above.
                </p>
              )}
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="integration">
          <div className="grid gap-6">

      {/* Data source */}
      <Card className="grid gap-4 p-5">
        <h2 className="text-sm font-bold">Student data source</h2>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">Provider
            <select value={status.provider} disabled={busy === 'config'} onChange={(e) => patch({ provider: e.target.value }, 'Provider updated.')} className="h-9 rounded-md border border-input bg-card px-2">
              {status.providers.map((p) => <option key={p.key} value={p.key}>{p.name}{p.maturity === 'beta' ? ' (Beta)' : ''}</option>)}
            </select>
          </label>
          {isSync && (
            <>
              <label className="flex items-center gap-2"><input type="checkbox" checked={status.autoSync} disabled={busy === 'config'} onChange={(e) => patch({ autoSync: e.target.checked })} /> Auto-sync every
                <select value={status.intervalHours} disabled={!status.autoSync || busy === 'config'} onChange={(e) => patch({ intervalHours: Number(e.target.value) })} className="h-9 rounded-md border border-input bg-card px-2">
                  <option value={6}>6h</option><option value={12}>12h</option><option value={24}>24h</option><option value={48}>48h</option><option value={168}>weekly</option>
                </select>
              </label>
              {status.provider === 'mock' && (
                <label className="flex items-center gap-2 text-muted-foreground">Mock scenario
                  <select value={status.mockScenario} disabled={busy === 'config'} onChange={(e) => patch({ mockScenario: e.target.value })} className="h-9 rounded-md border border-input bg-card px-2">
                    <option value="full">full roster</option><option value="reduced">reduced (drop 1, change 1)</option>
                  </select>
                </label>
              )}
            </>
          )}
        </div>
        {/* F7: flag connectors that have not been proven against a live vendor tenant. */}
        {current?.maturity === 'beta' ? (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
            <span className="font-semibold">Beta connector.</span> {current.maturityNote}
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-3 border-t border-border pt-3 sm:grid-cols-4">
          <Stat label="Roster students" value={status.dataset ? String(status.dataset.students) : '—'} />
          <Stat label="Roster teachers" value={status.dataset ? String(status.dataset.teachers) : '—'} />
          <Stat label="Last updated" value={status.dataset ? fmt(status.dataset.updatedAt) : 'no data yet'} />
          <Stat label="Source of record" value={status.dataset?.provider ?? status.provider} />
        </div>
      </Card>

      {current?.configurable && <ConnectionCard key={status.provider} provider={status.provider} providerName={current.name} />}

      {/* Excel/CSV import (internal/csv) */}
      {isImport && (
        <Card className="grid gap-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm font-bold"><Upload className="size-4 text-brand" /> Import roster (Excel / CSV)</h2>
            <div className="flex flex-wrap items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => sisApi.downloadTemplate('simple')}><Download className="size-4" /> Roster (1 sheet)</Button>
              <Button variant="ghost" size="sm" onClick={() => sisApi.downloadTemplate('full')}><Download className="size-4" /> Full template (5 sheets)</Button>
            </div>
          </div>
          {/*
            Two templates, one importer, EQUAL capability. The single sheet is not a
            cut-down version — it carries the whole student → subject → teacher chain by
            repeating the student across their subjects. The choice is about the shape
            your data already has, not about how much of the product you can use.
          */}
          <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
            <div className="rounded-md border border-border p-2.5">
              <div className="font-semibold text-foreground">Roster — one sheet</div>
              <strong>One row per student per subject.</strong> A student taking four subjects has four
              rows, with their name, class, section and parent details repeated on each — the repetition
              is expected. Fill <code>Teacher Employee Code</code> and <code>Subject</code> and it covers
              everything the five-sheet template does, including parent feedback on teachers. Leave those
              blank and it is a plain student roster.
            </div>
            <div className="rounded-md border border-border p-2.5">
              <div className="font-semibold text-foreground">Full template — five sheets</div>
              Students, Guardians, Teachers, TeachingAssignments and Enrollments as separate sheets.
              Use it when your SIS already exports in that shape, or when you need several guardians per
              student. Same result, same importer.
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Either way, a teacher is matched to their 360 employee by <code>employee_code</code> — that match is what routes a parent&apos;s feedback onto the teacher&apos;s own appraisal.</p>
          <p className="text-xs text-muted-foreground">A single CSV works too. Existing records update in place, matched on <code>student_id</code> — a student who changes class or teacher stays the same student. Students/teachers no longer present are deactivated (never deleted). An import that would deactivate, rename or re-point anything stops and shows you the list first.</p>
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileRef} type="file" accept=".xlsx,.csv" className="text-sm" />
            <Button variant="outline" size="sm" onClick={() => runImport(true)} disabled={!!busy}>{busy === 'dry' ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Validate / preview</Button>
            <Button size="sm" onClick={() => runImport(false)} disabled={!!busy}>{busy === 'live' ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />} Import</Button>
          </div>
          {result && <ResultPanel result={result} onConfirm={result.requiresConfirmation ? () => runImport(false, true) : undefined} busy={busy === 'live'} />}
        </Card>
      )}

      {/* Provider sync (mock/generic/oneroster) */}
      {isSync && (
        <Card className="grid gap-4 p-5">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-bold"><Database className="size-4 text-brand" /> Synchronize from {current?.name}</h2>
            <div className="flex items-center gap-2">
              {status.provider !== 'mock' && <Button variant="ghost" size="sm" onClick={async () => { setBusy('test'); setResult(null); try { const t: TestResult = await sisApi.testConnection(); setMsg(t.message); } catch (e) { setError(e instanceof ApiError ? e.message : 'Test failed.'); } finally { setBusy(null); } }} disabled={!!busy}>{busy === 'test' ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />} Test</Button>}
              <Button variant="outline" size="sm" onClick={() => runSync(false)} disabled={!!busy}>{busy === 'dry' ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Dry run</Button>
              {!confirmLive
                ? <Button size="sm" onClick={() => setConfirmLive(true)} disabled={!!busy}><Play className="size-4" /> Sync now</Button>
                : <Button size="sm" variant="destructive" onClick={() => runSync(true)} disabled={!!busy}>{busy === 'live' ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />} Confirm sync</Button>}
            </div>
          </div>
          {confirmLive && <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-700">A live sync updates the roster (create/update students &amp; teachers, deactivate those removed from the SIS). It never deletes records or the feedback that references them. A run that would deactivate or rename anything stops and shows you the list first.</div>}
          {result && <ResultPanel result={result} onConfirm={result.requiresConfirmation ? () => runSync(true, true) : undefined} busy={busy === 'live'} />}
        </Card>
      )}

      {/* History */}
      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-2 text-sm font-bold">Import / sync history</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr><th className="px-3 py-2">When</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Provider</th><th className="px-3 py-2">By</th><th className="px-3 py-2">Created</th><th className="px-3 py-2">Updated</th><th className="px-3 py-2">Deactivated</th><th className="px-3 py-2">Status</th><th className="px-3 py-2"></th></tr>
            </thead>
            <tbody>
              {history.length === 0 && <tr><td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">No imports or syncs yet.</td></tr>}
              {history.map((r) => (
                <tr key={r.id} className="border-t border-border/60">
                  <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">{fmt(r.at)}</td>
                  <td className="px-3 py-1.5"><Badge variant={r.mode === 'live' ? 'brand' : 'neutral'}>{r.mode === 'live' ? 'Live' : 'Dry run'}</Badge>{r.trigger === 'scheduled' && <span className="ml-1 text-xs text-muted-foreground">auto</span>}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{r.provider}</td>
                  <td className="px-3 py-1.5">{r.by ?? '—'}</td>
                  <td className="px-3 py-1.5 text-emerald-600">{r.created}</td>
                  <td className="px-3 py-1.5 text-amber-600">{r.updated}</td>
                  <td className="px-3 py-1.5 text-rose-600">{r.deactivated}</td>
                  <td className="px-3 py-1.5">{r.status === 'completed' ? <Badge variant="success">ok</Badge> : <Badge variant="danger">{r.status}</Badge>}</td>
                  <td className="px-3 py-1.5 text-right"><Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => sisApi.downloadReport(r.id)}><Download className="size-3.5" /> Report</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return <div className="rounded-md border border-border p-2"><div className="truncate text-sm font-semibold">{value}</div><div className="text-[11px] text-muted-foreground">{label}</div></div>;
}

function ResultPanel({ result, onConfirm, busy }: { result: SisApplyResult; onConfirm?: () => void; busy?: boolean }): JSX.Element {
  const c = result.counts;
  return (
    <div className="grid gap-3 rounded-md border border-border p-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        {result.mode === 'live' ? <Database className="size-4 text-emerald-600" /> : <RefreshCw className="size-4 text-muted-foreground" />}
        {result.mode === 'live' ? 'Result' : 'Preview — nothing written'}
        {!result.ok && <Badge variant="danger">{result.errors.length} error(s) — not applied</Badge>}
        {result.requiresConfirmation && <Badge variant="warning">Needs confirmation</Badge>}
      </div>

      {/* The gate. A destructive run is withheld and itemised before it can apply. */}
      {result.requiresConfirmation && (
        <div className="grid gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          <p className="flex items-start gap-2 font-semibold text-amber-800 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            This run would make significant changes, so nothing was written.
          </p>
          <p className="text-amber-900 dark:text-amber-200">
            {result.deactivate.length > 0 && <>It would <strong>deactivate {result.deactivate.length}</strong> record(s) that the feed does not mention. </>}
            {result.rename.length > 0 && <>It would <strong>rename {result.rename.length}</strong> existing student(s). </>}
            {(result.repoint?.length ?? 0) > 0 && <>It would <strong>re-point {result.repoint?.length}</strong> teacher(s) to a different 360 employee. </>}
            Check the lists below — a feed whose IDs overlap a different roster is the usual cause.
          </p>
          <p className="text-xs text-amber-900/80 dark:text-amber-200/80">
            Feedback already collected is never touched: deactivated records are kept, and every
            evaluation link stores the employee it resolved when it was generated.
          </p>
          <div>
            <Button size="sm" variant="destructive" onClick={onConfirm} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />} Apply these changes
            </Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
        <Stat label="Created" value={String(c.created)} />
        <Stat label="Updated" value={String(c.updated)} />
        <Stat label="Deactivated" value={String(c.deactivated)} />
        <Stat label="Renamed" value={String(result.rename?.length ?? 0)} />
        <Stat label="Kept (local)" value={String(c.protected ?? 0)} />
        <Stat label="Teachers linked" value={String(c.autoMapped)} />
      </div>
      {result.rename?.length > 0 && (
        <div className="text-xs">
          <span className="font-semibold text-amber-700">Would be renamed:</span>{' '}
          {result.rename.slice(0, 25).map((r) => `${r.code}: ${r.from} → ${r.to}`).join('; ')}
          {result.rename.length > 25 ? ` … and ${result.rename.length - 25} more` : ''}
        </div>
      )}
      {(result.repoint?.length ?? 0) > 0 && (
        <div className="text-xs">
          <span className="font-semibold text-rose-600">Teachers that would be re-pointed to a different employee:</span>{' '}
          {result.repoint?.slice(0, 25).map((r) => `${r.name ?? r.code}: employee ${r.from} → ${r.to}`).join('; ')}
          {(result.repoint?.length ?? 0) > 25 ? ` … and ${(result.repoint?.length ?? 0) - 25} more` : ''}
          {' '}— feedback already collected keeps scoring the original employee; only future parent feedback moves.
        </div>
      )}
      {result.preserved?.length > 0 && (
        <div className="text-xs">
          <span className="font-semibold text-sky-700">Kept as maintained here (the sync does not touch these):</span>{' '}
          {result.preserved.slice(0, 25).map((p) => `${p.name ?? p.code}${p.reason === 'edited' ? ` (${p.fields?.join(', ')})` : ' (added here)'}`).join('; ')}
          {result.preserved.length > 25 ? ` … and ${result.preserved.length - 25} more` : ''}
        </div>
      )}
      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
        {Object.entries(result.entityCounts).map(([k, v]) => <span key={k} className="rounded border border-border px-2 py-0.5"><strong className="text-foreground">{v}</strong> {k}</span>)}
      </div>
      {result.deactivate.length > 0 && (
        <div className="text-xs"><span className="font-semibold text-rose-600">Deactivated (no longer in SIS):</span> {result.deactivate.map((d) => `${d.code}${d.name ? ` (${d.name})` : ''}`).join(', ')} — kept as inactive; feedback preserved.</div>
      )}
      {result.errors.length > 0 && (
        <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs text-danger">
          {result.errors.slice(0, 50).map((e, i) => <li key={i}>{e.entity}{e.row ? ` row ${e.row}` : ''}{e.key ? ` · ${e.key}` : ''}: {e.message}</li>)}
        </ul>
      )}
      {result.warnings.length > 0 && (
        <ul className="max-h-28 space-y-0.5 overflow-y-auto text-xs text-amber-700">
          {result.warnings.slice(0, 20).map((w, i) => <li key={i}>{w.entity}{w.key ? ` · ${w.key}` : ''}: {w.message}</li>)}
        </ul>
      )}
      {result.verify && (
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          {Object.entries(result.verify).map(([k, v]) => <span key={k} className="rounded border border-border px-2 py-0.5"><strong className="text-foreground">{v}</strong> {k.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>)}
        </div>
      )}
      {result.runId && <div><Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => sisApi.downloadReport(result.runId!)}><Download className="size-3.5" /> Download report</Button></div>}
    </div>
  );
}

/** Per-provider connection form (Generic / OneRoster). Secrets are write-only. */
function ConnectionCard({ provider, providerName }: { provider: string; providerName: string }): JSX.Element {
  const [fields, setFields] = useState<ConnectionField[]>([]);
  const [form, setForm] = useState<Record<string, string>>({});
  const [secretSet, setSecretSet] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    sisApi.getConnection(provider).then((c) => {
      setFields(c.fields); setSecretSet(c.secretSet);
      const f: Record<string, string> = {};
      for (const fld of c.fields) { if (fld.secret) { f[fld.key] = ''; continue; } const v = c.settings[fld.key]; f[fld.key] = v == null ? '' : String(v); }
      setForm(f);
    }).catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load connection.'));
  }, [provider]);
  useEffect(() => { load(); }, [load]);

  const set = (k: string, v: string): void => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setBusy('save'); setError(null); setMsg(null);
    try {
      const settings: Record<string, unknown> = {};
      for (const f of fields) { const v = form[f.key] ?? ''; if (f.secret) { if (v !== '') settings[f.key] = v; } else settings[f.key] = v; }
      await sisApi.saveConnection(provider, settings); setMsg('Connection saved.'); load();
    } catch (e) { setError(e instanceof ApiError ? e.message : (e as Error).message); }
    finally { setBusy(null); }
  }

  return (
    <Card className="grid gap-4 p-5">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-bold"><KeyRound className="size-4 text-brand" /> {providerName} — connection</h2>
        <Button size="sm" onClick={save} disabled={!!busy}>{busy === 'save' ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save</Button>
      </div>
      <p className="text-xs text-muted-foreground">Credentials are encrypted at rest and never shown again. Leave a secret blank to keep the saved value. Then use Test / Dry run above before a live sync.</p>
      {error && <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">{error}</div>}
      {msg && <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700">{msg}</div>}
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((f) => (
          <label key={f.key} className="grid gap-1">
            <span className="text-xs font-medium">{f.label}{f.secret && secretSet[f.key] && <span className="ml-1 text-emerald-600">· saved</span>}</span>
            {f.type === 'select' ? (
              <select value={form[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} className="h-9 rounded-md border border-input bg-card px-2 text-sm">
                <option value="">—</option>
                {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input type={f.secret ? 'password' : f.type === 'number' ? 'number' : 'text'} value={form[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} placeholder={f.secret && secretSet[f.key] ? '•••••••• (leave blank to keep)' : f.placeholder ?? ''} autoComplete="off" className="h-9 rounded-md border border-input bg-card px-2 text-sm" />
            )}
            {f.help && <span className="text-[11px] text-muted-foreground">{f.help}</span>}
          </label>
        ))}
      </div>
    </Card>
  );
}
