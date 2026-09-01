import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Building2, CheckCircle2, Cloud, Database, Download, KeyRound, Loader2, Play, Plug, RefreshCw, Save } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ApiError } from '@/lib/api-client';
import { hrApi, type ConnectionField, type HrRun, type HrStatus, type SyncResult, type TestResult } from './api';

function fmt(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
}

export function HrIntegrationPage(): JSX.Element {
  const [status, setStatus] = useState<HrStatus | null>(null);
  const [history, setHistory] = useState<HrRun[]>([]);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [confirmLive, setConfirmLive] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    hrApi.status().then(setStatus).catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load status.'));
    hrApi.history().then(setHistory).catch(() => setHistory([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const external = status?.mode === 'external_hr';

  async function patch(p: Parameters<typeof hrApi.updateConfig>[0], note?: string) {
    setBusy('config'); setError(null); setMsg(null);
    try { await hrApi.updateConfig(p); if (note) setMsg(note); load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Update failed.'); }
    finally { setBusy(null); }
  }

  async function runSync(live: boolean) {
    setBusy(live ? 'live' : 'dry'); setError(null); setMsg(null); setConfirmLive(false);
    try {
      const res = await hrApi.sync(live);
      setResult(res);
      setMsg(live ? 'Synchronization complete.' : 'Dry run complete — no data was written.');
      load();
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Sync failed.'); }
    finally { setBusy(null); }
  }

  if (!status) {
    return <div className="grid gap-6"><h1 className="text-2xl font-extrabold tracking-tight">HR Integration</h1><Card className="p-6 text-sm text-muted-foreground">{error ?? 'Loading…'}</Card></div>;
  }

  return (
    <div className="grid gap-6">
      <div>
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-brand/10 text-brand"><Cloud className="size-4" /></span>
          <h1 className="text-2xl font-extrabold tracking-tight">HR Integration</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose where this organization’s people data comes from. In <strong>External HR</strong> mode the HR system is the source of truth and org data syncs into the existing 360 records; all evaluation, scoring, reporting and audit keep working unchanged.
        </p>
      </div>

      {error && <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><span>{error}</span></div>}
      {msg && <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700"><CheckCircle2 className="mt-0.5 size-4 shrink-0" /><span>{msg}</span></div>}

      {/* Data source */}
      <Card className="grid gap-4 p-5">
        <h2 className="text-sm font-bold">Organization data source</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          <ModeCard active={!external} onClick={() => patch({ mode: 'internal' }, 'Switched to Internal mode.')} icon={<Building2 className="size-4" />}
            title="Internal" desc="People data is maintained inside the 360 application (manual management + spreadsheet import)." disabled={busy === 'config'} />
          <ModeCard active={external} onClick={() => patch({ mode: 'external_hr' }, 'Switched to External HR mode. Run a Dry Run, then Sync.')} icon={<Cloud className="size-4" />}
            title="External HR" desc="An external HR system is the source of truth; org data is synced in and becomes read-only here." disabled={busy === 'config'} destructive />
        </div>

        <div className="flex flex-wrap items-center gap-4 border-t border-border pt-3 text-sm">
          <label className="flex items-center gap-2">Provider
            <select value={status.provider} disabled={!external || busy === 'config'} onChange={(e) => patch({ provider: e.target.value })} className="h-9 rounded-md border border-input bg-card px-2">
              {status.providers.map((p) => <option key={p.key} value={p.key}>{p.name}{p.maturity === 'beta' ? ' (Beta)' : ''}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={status.autoSync} disabled={!external || busy === 'config'} onChange={(e) => patch({ autoSync: e.target.checked })} /> Auto-sync every
            <select value={status.intervalHours} disabled={!external || !status.autoSync || busy === 'config'} onChange={(e) => patch({ intervalHours: Number(e.target.value) })} className="h-9 rounded-md border border-input bg-card px-2">
              <option value={6}>6h</option><option value={12}>12h</option><option value={24}>24h</option><option value={48}>48h</option><option value={168}>weekly</option>
            </select>
          </label>
          {status.provider === 'mock' && external && (
            <label className="flex items-center gap-2 text-muted-foreground">Mock scenario
              <select value={status.mockScenario} disabled={busy === 'config'} onChange={(e) => patch({ mockScenario: e.target.value })} className="h-9 rounded-md border border-input bg-card px-2">
                <option value="full">full roster</option><option value="reduced">reduced (drop 1, change 1)</option>
              </select>
            </label>
          )}
        </div>
        {/* F7: be explicit about which connectors have not been proven against a
            live vendor tenant, instead of presenting every provider as finished. */}
        {(() => {
          const selected = status.providers.find((p) => p.key === status.provider);
          return selected?.maturity === 'beta' ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
              <span className="font-semibold">Beta connector.</span> {selected.maturityNote}
            </p>
          ) : null;
        })()}
      </Card>

      {/* Connection settings (external + a configurable real provider) */}
      {external && status.providers.find((p) => p.key === status.provider)?.configurable && (
        <ConnectionCard key={status.provider} provider={status.provider}
          providerName={status.providers.find((p) => p.key === status.provider)?.name ?? status.provider} />
      )}

      {/* Sync panel (external only) */}
      {external && (
        <Card className="grid gap-4 p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold">Synchronization</h2>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => runSync(false)} disabled={!!busy}>{busy === 'dry' ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Dry run / preview</Button>
              {!confirmLive
                ? <Button size="sm" onClick={() => setConfirmLive(true)} disabled={!!busy}><Play className="size-4" /> Sync now</Button>
                : <Button size="sm" variant="destructive" onClick={() => runSync(true)} disabled={!!busy}>{busy === 'live' ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />} Confirm live sync</Button>}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Provider" value={status.providers.find((p) => p.key === status.provider)?.name ?? status.provider} />
            <Stat label="Last sync" value={fmt(status.lastSyncAt)} />
            <Stat label="Next scheduled" value={status.autoSync ? fmt(status.nextSyncAt) : 'manual'} />
            <Stat label="Last status" value={status.lastRun?.status ?? '—'} />
          </div>

          {confirmLive && <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-700">A live sync writes HR data into the internal records (create/update employees, deactivate those removed from HR). It never deletes employees, feedback, or scores. Run a Dry run first if unsure.</div>}

          {result && <ResultPanel result={result} />}
        </Card>
      )}

      {/* History */}
      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-2 text-sm font-bold">Synchronization history</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr><th className="px-3 py-2">When</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">By</th><th className="px-3 py-2">Created</th><th className="px-3 py-2">Updated</th><th className="px-3 py-2">Deactivated</th><th className="px-3 py-2">Warnings</th><th className="px-3 py-2">Status</th><th className="px-3 py-2"></th></tr>
            </thead>
            <tbody>
              {history.length === 0 && <tr><td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">No synchronizations yet.</td></tr>}
              {history.map((r) => (
                <tr key={r.id} className="border-t border-border/60">
                  <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">{fmt(r.at)}</td>
                  <td className="px-3 py-1.5"><Badge variant={r.mode === 'live' ? 'brand' : 'neutral'}>{r.mode === 'live' ? 'Live' : 'Dry run'}</Badge>{r.trigger === 'scheduled' && <span className="ml-1 text-xs text-muted-foreground">auto</span>}</td>
                  <td className="px-3 py-1.5">{r.by ?? '—'}</td>
                  <td className="px-3 py-1.5 text-emerald-600">{r.created}</td>
                  <td className="px-3 py-1.5 text-amber-600">{r.updated}</td>
                  <td className="px-3 py-1.5 text-rose-600">{r.deactivated}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{r.warnings}</td>
                  <td className="px-3 py-1.5">{r.status === 'completed' ? <Badge variant="success">ok</Badge> : <Badge variant="danger">{r.status}</Badge>}</td>
                  <td className="px-3 py-1.5 text-right"><Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => hrApi.downloadReport(r.id)}><Download className="size-3.5" /> Report</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function ModeCard({ active, onClick, icon, title, desc, disabled, destructive }: { active: boolean; onClick: () => void; icon: JSX.Element; title: string; desc: string; disabled?: boolean; destructive?: boolean }): JSX.Element {
  return (
    <button onClick={onClick} disabled={disabled} className={`flex items-start gap-3 rounded-md border p-3 text-left transition-colors ${active ? 'border-brand bg-brand/5' : 'border-border hover:bg-muted/40'} disabled:opacity-60`}>
      <span className={`mt-0.5 flex size-8 items-center justify-center rounded-lg ${active ? 'bg-brand text-white' : 'bg-muted text-muted-foreground'}`}>{icon}</span>
      <span>
        <span className="flex items-center gap-2 font-semibold">{title} {active && <Badge variant={destructive ? 'warning' : 'success'}>active</Badge>}</span>
        <span className="block text-xs text-muted-foreground">{desc}</span>
      </span>
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return <div className="rounded-md border border-border p-2"><div className="truncate text-sm font-semibold">{value}</div><div className="text-[11px] text-muted-foreground">{label}</div></div>;
}

/** Per-provider connection form. Secrets are write-only (blank = keep existing). */
function ConnectionCard({ provider, providerName }: { provider: string; providerName: string }): JSX.Element {
  const [fields, setFields] = useState<ConnectionField[]>([]);
  const [form, setForm] = useState<Record<string, string>>({});
  const [secretSet, setSecretSet] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    hrApi.getConnection(provider).then((c) => {
      setFields(c.fields);
      setSecretSet(c.secretSet);
      const f: Record<string, string> = {};
      for (const fld of c.fields) {
        if (fld.secret) { f[fld.key] = ''; continue; }
        const v = c.settings[fld.key];
        f[fld.key] = fld.key === 'mapping' ? (v ? JSON.stringify(v, null, 2) : '') : v == null ? '' : String(v);
      }
      setForm(f);
    }).catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load connection settings.'));
  }, [provider]);
  useEffect(() => { load(); }, [load]);

  // For the Generic provider, only show fields relevant to the chosen source type.
  const visible = useMemo(() => {
    if (provider !== 'generic') return fields;
    const st = form.sourceType || 'rest';
    const restCsv = new Set(['url', 'authType', 'token', 'apiKeyHeader', 'apiKey', 'username', 'password', 'arrayPath', 'delimiter']);
    const sftpOnly = new Set(['host', 'port', 'remotePath', 'privateKey', 'username', 'password', 'delimiter']);
    return fields.filter((f) => {
      if (['sourceType', 'orgName', 'mapping'].includes(f.key)) return true;
      if (f.key === 'arrayPath') return st === 'rest';
      if (st === 'sftp') return sftpOnly.has(f.key);
      return restCsv.has(f.key); // rest + csv_url
    });
  }, [provider, fields, form.sourceType]);

  function set(key: string, value: string) { setForm((f) => ({ ...f, [key]: value })); }

  async function save() {
    setBusy('save'); setError(null); setMsg(null); setTest(null);
    try {
      const settings: Record<string, unknown> = {};
      for (const f of fields) {
        const v = form[f.key] ?? '';
        if (f.key === 'mapping') {
          if (v.trim()) { try { settings.mapping = JSON.parse(v); } catch { throw new Error('Field mapping is not valid JSON.'); } }
        } else if (f.secret) {
          if (v !== '') settings[f.key] = v; // blank = keep existing
        } else {
          settings[f.key] = v;
        }
      }
      await hrApi.saveConnection(provider, settings);
      setMsg('Connection settings saved.');
      load();
    } catch (e) { setError(e instanceof ApiError ? e.message : (e as Error).message); }
    finally { setBusy(null); }
  }

  async function runTest() {
    setBusy('test'); setError(null); setMsg(null); setTest(null);
    try { setTest(await hrApi.testConnection()); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Test failed.'); }
    finally { setBusy(null); }
  }

  return (
    <Card className="grid gap-4 p-5">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-bold"><KeyRound className="size-4 text-brand" /> {providerName} — connection</h2>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={runTest} disabled={!!busy}>{busy === 'test' ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />} Test connection</Button>
          <Button size="sm" onClick={save} disabled={!!busy}>{busy === 'save' ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save</Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Credentials are encrypted at rest and never shown again. Leave a secret field blank to keep the saved value. Nothing is read from the HR system until you run a Dry run or Sync.</p>

      {error && <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">{error}</div>}
      {msg && <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700">{msg}</div>}

      <div className="grid gap-3 sm:grid-cols-2">
        {visible.map((f) => (
          <label key={f.key} className={`grid gap-1 ${f.type === 'json' ? 'sm:col-span-2' : ''}`}>
            <span className="text-xs font-medium">{f.label}{f.secret && secretSet[f.key] && <span className="ml-1 text-emerald-600">· saved</span>}</span>
            {f.type === 'select' ? (
              <select value={form[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} className="h-9 rounded-md border border-input bg-card px-2 text-sm">
                {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : f.type === 'json' ? (
              <textarea value={form[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} rows={6} spellCheck={false}
                placeholder={'{\n  "employeeCode": "emp_no",\n  "fullName": "name",\n  "email": "email",\n  "department": "dept",\n  "managerCode": "manager_no",\n  "status": "status"\n}'}
                className="rounded-md border border-input bg-card px-2 py-1 font-mono text-xs" />
            ) : (
              <input type={f.secret ? 'password' : f.type === 'number' ? 'number' : 'text'} value={form[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)}
                placeholder={f.secret && secretSet[f.key] ? '•••••••• (leave blank to keep)' : f.placeholder ?? ''} autoComplete="off"
                className="h-9 rounded-md border border-input bg-card px-2 text-sm" />
            )}
            {f.help && <span className="text-[11px] text-muted-foreground">{f.help}</span>}
          </label>
        ))}
      </div>

      {test && (
        <div className={`rounded-md border px-3 py-2 text-sm ${test.ok ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700' : 'border-danger/30 bg-danger/5 text-danger'}`}>
          <div className="flex items-center gap-2 font-semibold">{test.ok ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />} {test.message}</div>
          {test.ok && test.sample && test.sample.length > 0 && (
            <div className="mt-1 text-xs text-muted-foreground">Sample: {test.sample.join(' · ')}</div>
          )}
        </div>
      )}
    </Card>
  );
}

function ResultPanel({ result }: { result: SyncResult }): JSX.Element {
  const c = result.counts;
  return (
    <div className="grid gap-3 rounded-md border border-border p-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        {result.mode === 'live' ? <Database className="size-4 text-emerald-600" /> : <RefreshCw className="size-4 text-muted-foreground" />}
        {result.mode === 'live' ? 'Live sync result' : 'Dry-run preview'}
        {!result.canSync && <Badge variant="danger">{result.errors.length} error(s) — not applied</Badge>}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label="Created" value={String(c.created)} />
        <Stat label="Updated" value={String(c.updated)} />
        <Stat label="Deactivated" value={String(c.deactivated)} />
        <Stat label="Warnings" value={String(result.warnings.length)} />
        <Stat label="Errors" value={String(result.errors.length)} />
      </div>
      {result.deactivate.length > 0 && (
        <div className="text-xs"><span className="font-semibold text-rose-600">To deactivate (removed from HR):</span> {result.deactivate.map((d) => `${d.employeeCode}${d.name ? ` (${d.name})` : ''}`).join(', ')} — kept as inactive; feedback preserved.</div>
      )}
      {result.errors.length > 0 && (
        <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs text-danger">
          {result.errors.slice(0, 50).map((e, i) => <li key={i}>{e.entity}{e.key ? ` · ${e.key}` : ''}: {e.message}</li>)}
        </ul>
      )}
      {result.verify && (
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          {Object.entries(result.verify).map(([k, v]) => <span key={k} className="rounded border border-border px-2 py-0.5"><strong className="text-foreground">{v}</strong> {k.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>)}
        </div>
      )}
      {result.runId && <div><Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => hrApi.downloadReport(result.runId!)}><Download className="size-3.5" /> Download report</Button></div>}
    </div>
  );
}
