import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Download, History, ScrollText, Search, X } from 'lucide-react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { apiClient, ApiError } from '@/lib/api-client';
import { feedbackAuditApi, type AuditEvent, type AuditFacets, type AuditQuery } from './api';

const PAGE_SIZE = 100;

interface Cycle { id: string; name: string }

/** Colour hint by action family. */
function actionVariant(action: string): BadgeVariant {
  if (action.startsWith('cycle.')) return 'brand';
  if (action.startsWith('link.') || action.startsWith('parent.')) return 'info';
  if (action.startsWith('evaluation.')) return 'neutral';
  if (action.startsWith('score.') || action.startsWith('potential.') || action.startsWith('results.')) return 'warning';
  if (action.startsWith('assignment.') || action.startsWith('participant.') || action.startsWith('source.')) return 'neutral';
  if (action === 'link.revoked' || action === 'link.expired') return 'danger';
  return 'neutral';
}

/** "cycle.started" → "Cycle started". */
function humanize(action: string): string {
  const s = action.replace(/[._]/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmt(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function AuditTrailPage(): JSX.Element {
  const [q, setQ] = useState<AuditQuery>({});
  const [rows, setRows] = useState<AuditEvent[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [facets, setFacets] = useState<AuditFacets>({ actions: [], sourceTypes: [] });
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<AuditEvent | null>(null);

  useEffect(() => {
    feedbackAuditApi.facets().then(setFacets).catch(() => setFacets({ actions: [], sourceTypes: [] }));
    apiClient.get<Cycle[]>('/appraisal/cycles').then(setCycles).catch(() => setCycles([]));
  }, []);

  const load = useCallback(() => {
    setError(null);
    feedbackAuditApi
      .list({ ...q, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      .then((res) => { setRows(res.items); setTotal(res.total); })
      .catch((e) => { setRows([]); setError(e instanceof ApiError ? e.message : 'Failed to load audit trail.'); });
  }, [q, page]);

  // Debounce text-driven filters; page changes load immediately.
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);

  function patch(next: Partial<AuditQuery>) { setPage(0); setQ((prev) => ({ ...prev, ...next })); }
  function clearAll() { setPage(0); setQ({}); }

  async function doExport() {
    setBusy(true);
    try { await feedbackAuditApi.exportCsv(q); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Export failed.'); }
    finally { setBusy(false); }
  }

  const hasFilters = useMemo(() => Object.values(q).some((v) => v !== undefined && v !== ''), [q]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="grid gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-brand/10 text-brand"><ScrollText className="size-4" /></span>
            <h1 className="text-2xl font-extrabold tracking-tight">Audit Trail</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            An append-only record of every 360 feedback activity — cycles, assignments, evaluations, parent links, scores, notifications and result access. Records cannot be edited or deleted.
          </p>
        </div>
        <Button variant="outline" onClick={doExport} disabled={busy || !rows?.length}>
          <Download className="size-4" /> Export CSV
        </Button>
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-4">
          <div className="relative md:col-span-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q.search ?? ''} onChange={(e) => patch({ search: e.target.value })} placeholder="Search action, name, cycle, record id…" className="h-9 pl-8" />
          </div>
          <select value={q.cycleId ?? ''} onChange={(e) => patch({ cycleId: e.target.value })} className="h-9 rounded-md border border-input bg-card px-2 text-sm">
            <option value="">All cycles</option>
            {cycles.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select value={q.action ?? ''} onChange={(e) => patch({ action: e.target.value })} className="h-9 rounded-md border border-input bg-card px-2 text-sm">
            <option value="">All actions</option>
            {facets.actions.map((a) => <option key={a} value={a}>{humanize(a)}</option>)}
          </select>
          <select value={q.sourceType ?? ''} onChange={(e) => patch({ sourceType: e.target.value })} className="h-9 rounded-md border border-input bg-card px-2 text-sm">
            <option value="">All source types</option>
            {facets.sourceTypes.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <Input value={q.evaluatee ?? ''} onChange={(e) => patch({ evaluatee: e.target.value })} placeholder="Evaluatee" className="h-9" />
          <Input value={q.evaluator ?? ''} onChange={(e) => patch({ evaluator: e.target.value })} placeholder="Evaluator" className="h-9" />
          <Input value={q.actor ?? ''} onChange={(e) => patch({ actor: e.target.value })} placeholder="User / actor" className="h-9" />
          <label className="flex items-center gap-1 text-xs text-muted-foreground">From
            <input type="datetime-local" value={q.from ?? ''} onChange={(e) => patch({ from: e.target.value })} className="h-9 flex-1 rounded-md border border-input bg-card px-2 text-sm text-foreground" />
          </label>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">To
            <input type="datetime-local" value={q.to ?? ''} onChange={(e) => patch({ to: e.target.value })} className="h-9 flex-1 rounded-md border border-input bg-card px-2 text-sm text-foreground" />
          </label>
          {hasFilters && (
            <Button variant="ghost" onClick={clearAll} className="h-9 justify-start text-muted-foreground"><X className="size-4" /> Clear filters</Button>
          )}
        </div>
      </Card>

      {error && <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">{error}</div>}

      {/* Table */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-semibold">Timestamp</th>
                <th className="px-3 py-2 font-semibold">Action</th>
                <th className="px-3 py-2 font-semibold">Actor</th>
                <th className="px-3 py-2 font-semibold">Cycle</th>
                <th className="px-3 py-2 font-semibold">Evaluatee</th>
                <th className="px-3 py-2 font-semibold">Evaluator</th>
                <th className="px-3 py-2 font-semibold">Source</th>
                <th className="px-3 py-2 font-semibold"></th>
              </tr>
            </thead>
            <tbody>
              {rows === null && Array.from({ length: 8 }).map((_, i) => (
                <tr key={i} className="border-b border-border/60"><td className="px-3 py-2" colSpan={8}><Skeleton className="h-5 w-full" /></td></tr>
              ))}
              {rows?.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">No audit events match these filters.</td></tr>
              )}
              {rows?.map((r) => (
                <tr key={r.id} className="border-b border-border/60 align-top hover:bg-muted/30">
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{fmt(r.createdAt)}</td>
                  <td className="px-3 py-2"><Badge variant={actionVariant(r.action)}>{humanize(r.action)}</Badge></td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.actorName ?? '—'}</div>
                    {r.actorRole && <div className="text-xs text-muted-foreground">{r.actorRole}</div>}
                  </td>
                  <td className="px-3 py-2">{r.cycleName ?? '—'}</td>
                  <td className="px-3 py-2">{r.evaluateeName ?? '—'}</td>
                  <td className="px-3 py-2">{r.evaluatorName ?? '—'}</td>
                  <td className="px-3 py-2">{r.sourceType ?? '—'}</td>
                  <td className="px-3 py-2 text-right">
                    <Button variant="ghost" size="sm" onClick={() => setDetail(r)} className="h-7 px-2 text-xs"><History className="size-3.5" /> Details</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* Pagination */}
        <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground">
          <span>{total.toLocaleString()} event{total === 1 ? '' : 's'}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Previous</Button>
            <span>Page {page + 1} of {totalPages}</span>
            <Button variant="outline" size="sm" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      </Card>

      {detail && <DetailDrawer event={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

/* ---------------------- Record detail + history ---------------------- */
function DetailDrawer({ event, onClose }: { event: AuditEvent; onClose: () => void }): JSX.Element {
  const [history, setHistory] = useState<AuditEvent[] | null>(null);

  useEffect(() => {
    if (event.entityId) {
      feedbackAuditApi.history(event.entityType, event.entityId).then(setHistory).catch(() => setHistory([]));
    } else {
      setHistory([]);
    }
  }, [event]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-y-auto bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Event detail</h2>
          <Button variant="ghost" size="sm" onClick={onClose}><X className="size-4" /></Button>
        </div>

        <dl className="mt-4 grid grid-cols-3 gap-x-3 gap-y-2 text-sm">
          <Field label="Action" value={humanize(event.action)} />
          <Field label="When" value={fmt(event.createdAt)} />
          <Field label="Actor" value={event.actorName ?? '—'} />
          <Field label="Actor role" value={event.actorRole ?? '—'} />
          <Field label="Cycle" value={event.cycleName ?? '—'} />
          <Field label="Evaluatee" value={event.evaluateeName ?? '—'} />
          <Field label="Evaluator" value={event.evaluatorName ?? '—'} />
          <Field label="Source/type" value={event.sourceType ?? '—'} />
          <Field label="Record" value={`${event.entityType}${event.entityId ? ` · ${event.entityId}` : ''}`} />
          {event.reason && <Field label="Reason" value={event.reason} />}
          <Field label="IP" value={event.ip ?? '—'} />
          <Field label="Device" value={event.userAgent ?? '—'} />
        </dl>

        {(event.previousValue != null || event.newValue != null) && (
          <div className="mt-4 grid gap-2">
            {event.previousValue != null && <JsonBlock label="Previous value" value={event.previousValue} />}
            {event.newValue != null && <JsonBlock label="New value" value={event.newValue} />}
          </div>
        )}

        <h3 className="mt-6 text-sm font-semibold">History of this record</h3>
        <div className="mt-2 grid gap-1">
          {history === null && <Skeleton className="h-16 w-full" />}
          {history?.length === 0 && <p className="text-xs text-muted-foreground">No linked history.</p>}
          {history?.map((h) => (
            <div key={h.id} className={`rounded-md border px-2 py-1.5 text-xs ${h.id === event.id ? 'border-brand/40 bg-brand/5' : 'border-border'}`}>
              <div className="flex items-center justify-between">
                <span className="font-medium">{humanize(h.action)}</span>
                <span className="text-muted-foreground">{fmt(h.createdAt)}</span>
              </div>
              <div className="text-muted-foreground">{h.actorName ?? '—'}{h.actorRole ? ` · ${h.actorRole}` : ''}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <Fragment>
      <dt className="col-span-1 text-xs text-muted-foreground">{label}</dt>
      <dd className="col-span-2 break-words font-medium">{value}</dd>
    </Fragment>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }): JSX.Element {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <pre className="mt-0.5 max-h-40 overflow-auto rounded-md bg-muted/50 p-2 text-xs">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}
