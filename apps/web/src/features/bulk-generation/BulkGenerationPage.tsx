import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Layers, Loader2, Send, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StatCard } from '@/components/shared/StatCard';
import { ApiError } from '@/lib/api-client';
import { questionnaireApi, type TemplateSummary } from '@/features/questionnaire/api';
import { bulkApi, DEFAULT_CONFIG, type BulkConfig, type GenerateResult, type PreviewSummary, type RunRow, type Scopes } from './api';

const CHANNELS = [
  { key: 'in_app', label: 'In-app' },
  { key: 'email', label: 'Email' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'sms', label: 'SMS' },
];

export function BulkGenerationPage(): JSX.Element {
  return (
    <div className="grid gap-6">
      <div>
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-brand/10 text-brand"><Layers className="size-4" /></span>
          <h1 className="text-2xl font-extrabold tracking-tight">Bulk Feedback Generation</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Generate a Feedback Cycle and its reviewer &amp; parent assignments in bulk across the organization, a campus, or a department —
          from the existing employee hierarchy. Preview and confirm before anything is created.
        </p>
      </div>
      <Tabs defaultValue="generate">
        <TabsList>
          <TabsTrigger value="generate">Generate</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="generate"><GenerateTab /></TabsContent>
        <TabsContent value="history"><HistoryTab /></TabsContent>
      </Tabs>
    </div>
  );
}

function GenerateTab(): JSX.Element {
  const [scopes, setScopes] = useState<Scopes | null>(null);
  const [scopeType, setScopeType] = useState<'all' | 'campus' | 'department'>('all');
  const [scopeId, setScopeId] = useState('');
  const [config, setConfig] = useState<BulkConfig>(DEFAULT_CONFIG);
  const [cycle, setCycle] = useState({ name: '', startDate: '', endDate: '', submissionDeadline: '', templateId: '' });
  // Questionnaire is REQUIRED: a cycle without one gives every evaluator an empty,
  // unsubmittable form (F-C3). Only published templates are offered.
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);

  const [preview, setPreview] = useState<PreviewSummary | null>(null);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [busy, setBusy] = useState<'preview' | 'generate' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => { bulkApi.scopes().then(setScopes).catch(() => setScopes(null)); }, []);
  useEffect(() => {
    questionnaireApi
      .listTemplates()
      .then((rows) => {
        const usable = rows.filter((t) => t.status === 'published');
        setTemplates(usable);
        // Preselect when there is exactly one, so the common case is one click.
        if (usable.length === 1) setCycle((c) => (c.templateId ? c : { ...c, templateId: usable[0].id }));
      })
      .catch(() => setTemplates([]));
  }, []);

  // Any change to scope/config invalidates a stale preview.
  const invalidate = useCallback(() => { setPreview(null); setResult(null); }, []);
  function setEval(key: keyof BulkConfig['evaluators'], v: boolean) { setConfig((c) => ({ ...c, evaluators: { ...c.evaluators, [key]: v } })); invalidate(); }
  function setPeer(key: keyof BulkConfig['peer'], v: number | boolean) { setConfig((c) => ({ ...c, peer: { ...c.peer, [key]: v } })); invalidate(); }
  function toggleChannel(ch: string) { setConfig((c) => ({ ...c, channels: c.channels.includes(ch) ? c.channels.filter((x) => x !== ch) : [...c.channels, ch] })); invalidate(); }

  const scopeOptions = scopeType === 'campus' ? scopes?.campuses ?? [] : scopeType === 'department' ? scopes?.departments ?? [] : [];
  const scopeReady = scopeType === 'all' || !!scopeId;

  async function runPreview() {
    setBusy('preview'); setError(null); setResult(null);
    try {
      setPreview(await bulkApi.preview({ scopeType, scopeId: scopeId || undefined, config }));
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Preview failed.'); }
    finally { setBusy(null); }
  }

  async function runGenerate() {
    setConfirm(false); setBusy('generate'); setError(null);
    try {
      const res = await bulkApi.generate({ scopeType, scopeId: scopeId || undefined, config, cycle: { ...cycle, submissionDeadline: cycle.submissionDeadline || undefined } });
      setResult(res); setPreview(res.summary);
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Generation failed.'); }
    finally { setBusy(null); }
  }

  // A questionnaire is mandatory — without it the generated cycle is unusable (F-C3).
  const cycleReady = cycle.name.trim() && cycle.startDate && cycle.endDate && cycle.templateId;

  return (
    <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
      {/* ---- Left: configuration ---- */}
      <div className="grid gap-4">
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-bold">1 · Scope</h3>
          <div className="grid gap-2">
            {(['all', 'campus', 'department'] as const).map((s) => (
              <label key={s} className="flex items-center gap-2 text-sm">
                <input type="radio" name="scope" checked={scopeType === s} onChange={() => { setScopeType(s); setScopeId(''); invalidate(); }} />
                {s === 'all' ? 'Entire organization' : s === 'campus' ? 'Campus (Institute)' : 'Department'}
              </label>
            ))}
            {scopeType !== 'all' ? (
              <select value={scopeId} onChange={(e) => { setScopeId(e.target.value); invalidate(); }} className="mt-1 h-9 rounded-md border border-input bg-card px-2 text-sm">
                <option value="">— select {scopeType} —</option>
                {scopeOptions.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.employees})</option>)}
              </select>
            ) : (
              <p className="text-xs text-muted-foreground">{scopes ? `${scopes.totalActiveEmployees} active employees` : '…'}</p>
            )}
          </div>
        </Card>

        <Card className="p-4">
          <h3 className="mb-3 text-sm font-bold">2 · Evaluators &amp; rules</h3>
          <div className="grid gap-2 text-sm">
            {([['manager', 'Line Manager'], ['peer', 'Peer'], ['subordinate', 'Subordinate'], ['self', 'Self'], ['parent', 'Parent (SIS)']] as const).map(([k, label]) => (
              <label key={k} className="flex items-center gap-2">
                <input type="checkbox" checked={config.evaluators[k]} onChange={(e) => setEval(k, e.target.checked)} />
                {label}
              </label>
            ))}
            {/*
              How far up the reporting line to ask. 1 is the immediate line manager and
              is exactly what this generator always did; each extra level walks one more
              hop and writes into its own quadrant (manager_l2, manager_l3, …) with its
              own weight, editable afterwards on the cycle's Sources tab.
            */}
            {config.evaluators.manager && (
              <div className="ml-6 grid gap-1 border-l border-border pl-3">
                <Label className="text-xs">Manager levels</Label>
                <select
                  value={config.managerLevels}
                  onChange={(e) => { setConfig((c) => ({ ...c, managerLevels: Number(e.target.value) })); invalidate(); }}
                  className="h-8 w-56 rounded-md border border-input bg-card px-2 text-sm"
                >
                  <option value={1}>1 — immediate manager only</option>
                  <option value={2}>2 — plus their manager</option>
                  <option value={3}>3 — plus one level above that</option>
                  <option value={4}>4 levels</option>
                  <option value={5}>5 levels</option>
                </select>
                {config.managerLevels > 1 && (
                  <p className="text-xs text-muted-foreground">
                    Creates one quadrant per level. Employees near the top of the chart simply get fewer levels —
                    the preview lists them. Set each level&rsquo;s weight on the cycle&rsquo;s Sources tab after generating.
                  </p>
                )}
              </div>
            )}
          </div>
          <div className="mt-3 grid gap-2 border-t border-border pt-3 text-sm">
            <div className="grid grid-cols-2 gap-2">
              <div><Label className="text-xs">Min peers</Label><Input type="number" min={0} value={config.peer.min} onChange={(e) => setPeer('min', Number(e.target.value))} className="h-8" /></div>
              <div><Label className="text-xs">Max peers</Label><Input type="number" min={1} value={config.peer.max} onChange={(e) => setPeer('max', Number(e.target.value))} className="h-8" /></div>
            </div>
            <label className="flex items-center gap-2"><input type="checkbox" checked={config.peer.crossDepartment} onChange={(e) => setPeer('crossDepartment', e.target.checked)} /> Allow cross-department peers</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={config.allowOutOfScope} onChange={(e) => { setConfig((c) => ({ ...c, allowOutOfScope: e.target.checked })); invalidate(); }} /> Allow evaluators outside the selected scope</label>
          </div>
          <div className="mt-3 border-t border-border pt-3">
            <Label className="text-xs">Notification channels</Label>
            <div className="mt-1 flex flex-wrap gap-3 text-sm">
              {CHANNELS.map((c) => (
                <label key={c.key} className="flex items-center gap-1.5"><input type="checkbox" checked={config.channels.includes(c.key)} onChange={() => toggleChannel(c.key)} /> {c.label}</label>
              ))}
            </div>
            <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={config.notify} onChange={(e) => { setConfig((c) => ({ ...c, notify: e.target.checked })); invalidate(); }} /> Activate cycle &amp; queue notifications on generate</label>
          </div>
        </Card>

        <Card className="p-4">
          <h3 className="mb-3 text-sm font-bold">3 · New cycle</h3>
          <div className="grid gap-2">
            <div><Label className="text-xs">Cycle name</Label><Input value={cycle.name} onChange={(e) => setCycle((c) => ({ ...c, name: e.target.value }))} placeholder="e.g. Annual 360 — 2026" className="h-9" /></div>
            <div className="grid grid-cols-2 gap-2">
              <div><Label className="text-xs">Start</Label><Input type="date" value={cycle.startDate} onChange={(e) => setCycle((c) => ({ ...c, startDate: e.target.value }))} className="h-9" /></div>
              <div><Label className="text-xs">End</Label><Input type="date" value={cycle.endDate} onChange={(e) => setCycle((c) => ({ ...c, endDate: e.target.value }))} className="h-9" /></div>
            </div>
            <div><Label className="text-xs">Submission deadline (optional)</Label><Input type="date" value={cycle.submissionDeadline} onChange={(e) => setCycle((c) => ({ ...c, submissionDeadline: e.target.value }))} className="h-9" /></div>
            <div>
              <Label className="text-xs">Questionnaire</Label>
              <select
                value={cycle.templateId}
                onChange={(e) => setCycle((c) => ({ ...c, templateId: e.target.value }))}
                className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
              >
                <option value="">— Select a questionnaire —</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              {templates.length === 0 ? (
                <p className="mt-1 text-xs text-amber-600">
                  No published questionnaire found. Publish one under Questionnaires before generating a cycle.
                </p>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">Evaluators answer this form. A cycle without one cannot be completed.</p>
              )}
            </div>
          </div>
        </Card>

        <div className="flex gap-2">
          <Button variant="outline" disabled={!scopeReady || busy !== null} onClick={runPreview}>
            {busy === 'preview' ? <Loader2 className="animate-spin" /> : <Users />} Preview
          </Button>
          <Button disabled={!preview || !cycleReady || busy !== null} onClick={() => setConfirm(true)}>
            {busy === 'generate' ? <Loader2 className="animate-spin" /> : <Send />} Generate
          </Button>
        </div>
        {!cycleReady && preview ? <p className="text-xs text-amber-600">Fill in the new-cycle name, dates and questionnaire to generate.</p> : null}
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </div>

      {/* ---- Right: preview / result ---- */}
      <div className="grid content-start gap-4">
        {result ? <ResultBanner result={result} /> : null}
        {!preview ? (
          <Card className="grid place-items-center p-12 text-center text-sm text-muted-foreground">
            <Users className="mb-2 size-8 opacity-40" />
            Choose a scope and options, then <span className="font-medium">Preview</span> to see what will be created.
          </Card>
        ) : (
          <PreviewPanel preview={preview} />
        )}
      </div>

      {confirm ? (
        <ConfirmModal preview={preview!} cycleName={cycle.name} notify={config.notify} onCancel={() => setConfirm(false)} onConfirm={runGenerate} />
      ) : null}
    </div>
  );
}

function PreviewPanel({ preview }: { preview: PreviewSummary }): JSX.Element {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Evaluatees" value={preview.employees} tone="brand" hint={`scope: ${preview.scope.name}`} />
        <StatCard label="Total assignments" value={preview.totalAssignments} tone="violet" hint={`${preview.messages.total} messages`} />
        <StatCard label="Parent evaluations" value={preview.parentEvaluations} tone="teal" hint={`${preview.teachers} teachers · ${preview.parents} parents`} />
        <StatCard label="Manager reviews" value={preview.managers} tone="slate" />
        <StatCard label="Peer reviews" value={preview.peers} tone="slate" />
        <StatCard label="Subordinate reviews" value={preview.subordinates} tone="slate" />
      </div>

      <Card className="p-4">
        <h3 className="mb-2 text-sm font-bold">Messages to be sent</h3>
        <div className="flex flex-wrap gap-2 text-sm">
          <Badge variant="info">WhatsApp: {preview.messages.whatsapp}</Badge>
          <Badge variant="info">Email: {preview.messages.email}</Badge>
          <Badge variant="info">SMS: {preview.messages.sms}</Badge>
          <Badge variant="info">In-app: {preview.messages.inApp}</Badge>
          <Badge variant="neutral">Total: {preview.messages.total}</Badge>
        </div>
        {preview.selfAssignments > 0 ? <p className="mt-2 text-xs text-muted-foreground">Includes {preview.selfAssignments} self-assessments.</p> : null}
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        <IssueList title="Employees with missing managers" names={preview.issues.missingManagers} />
        {preview.issues.shortChains && preview.issues.shortChains.length > 0 ? (
          <IssueList title="Employees near the top of the chart (fewer manager levels)" names={preview.issues.shortChains} />
        ) : null}
        <IssueList title="Employees with no eligible peers" names={preview.issues.noPeers} />
        <IssueList title="Employees with no subordinates" names={preview.issues.noSubordinates} />
        <IssueList title="Teachers with no parent/student link" names={preview.issues.teachersNoParents} />
      </div>
    </>
  );
}

function IssueList({ title, names }: { title: string; names: string[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Card className="p-3">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between text-left">
        <span className="flex items-center gap-2 text-sm font-medium">
          {names.length > 0 ? <AlertTriangle className="size-4 text-amber-500" /> : <CheckCircle2 className="size-4 text-emerald-500" />}
          {title}
        </span>
        <Badge variant={names.length > 0 ? 'warning' : 'success'}>{names.length}</Badge>
      </button>
      {open && names.length > 0 ? (
        <ul className="mt-2 max-h-40 overflow-auto text-xs text-muted-foreground">
          {names.map((n, i) => <li key={i} className="border-t border-border py-1">{n}</li>)}
        </ul>
      ) : null}
    </Card>
  );
}

function ResultBanner({ result }: { result: GenerateResult }): JSX.Element {
  const problems = [...result.failed.map((f) => ({ ...f, kind: 'failed' as const })), ...result.skipped.map((s) => ({ ...s, kind: 'skipped' as const }))];
  return (
    <Card className="border-emerald-200 bg-emerald-50 p-4">
      <div className="flex items-center gap-2 text-emerald-800">
        <CheckCircle2 className="size-5" />
        <p className="font-semibold">
          Generated {result.assignmentsCreated} assignments{result.cycleStatus === 'active' ? ' and activated the cycle' : ''}.
        </p>
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-sm">
        <Badge variant="success">Created: {result.assignmentsCreated}</Badge>
        <Badge variant={result.skippedCount ? 'warning' : 'neutral'}>Skipped: {result.skippedCount}</Badge>
        <Badge variant={result.failedCount ? 'danger' : 'neutral'}>Failed: {result.failedCount}</Badge>
        <Badge variant="info">Messages queued: {result.messagesQueued}</Badge>
      </div>
      {problems.length > 0 ? (
        <div className="mt-3 overflow-x-auto rounded-lg border border-amber-200 bg-white">
          <table className="w-full text-xs">
            <thead className="bg-amber-50 text-left uppercase text-amber-700"><tr><th className="p-2">Outcome</th><th className="p-2">Type</th><th className="p-2">Who</th><th className="p-2">Reason</th></tr></thead>
            <tbody>
              {problems.slice(0, 100).map((p, i) => (
                <tr key={i} className="border-t border-amber-100">
                  <td className="p-2"><Badge variant={p.kind === 'failed' ? 'danger' : 'warning'}>{p.kind}</Badge></td>
                  <td className="p-2">{p.type}</td><td className="p-2">{p.who}</td><td className="p-2 text-muted-foreground">{p.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

function ConfirmModal({ preview, cycleName, notify, onCancel, onConfirm }: { preview: PreviewSummary; cycleName: string; notify: boolean; onCancel: () => void; onConfirm: () => void }): JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <Card className="w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-bold">Confirm bulk generation</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          This will create the cycle <span className="font-medium text-foreground">“{cycleName}”</span> and{' '}
          <span className="font-medium text-foreground">{preview.totalAssignments}</span> assignments for{' '}
          <span className="font-medium text-foreground">{preview.employees}</span> employees in{' '}
          <span className="font-medium text-foreground">{preview.scope.name}</span>.
        </p>
        <ul className="mt-3 grid gap-1 text-sm">
          <li>· {preview.parentEvaluations} parent evaluations</li>
          <li>· {notify ? `${preview.messages.total} notifications will be queued and the cycle activated` : 'no notifications (cycle stays draft)'}</li>
        </ul>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={onConfirm}><Send /> Confirm &amp; generate</Button>
        </div>
      </Card>
    </div>
  );
}

function HistoryTab(): JSX.Element {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  useEffect(() => { bulkApi.runs().then(setRuns).catch(() => setRuns([])); }, []);

  if (!runs) return <Card className="p-10 text-center text-sm text-muted-foreground">Loading…</Card>;
  if (runs.length === 0) return <Card className="p-10 text-center text-sm text-muted-foreground">No bulk runs yet.</Card>;
  return (
    <Card className="overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground">
          <tr><th className="p-3">When</th><th className="p-3">Scope</th><th className="p-3">Cycle</th><th className="p-3">By</th><th className="p-3">Created</th><th className="p-3">Skipped</th><th className="p-3">Failed</th><th className="p-3">Messages</th><th className="p-3">Status</th></tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-t border-border">
              <td className="p-3 text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</td>
              <td className="p-3">{r.scopeName}</td>
              <td className="p-3 font-medium">{r.cycleName}</td>
              <td className="p-3 text-xs text-muted-foreground">{r.initiatedByName ?? '—'}</td>
              <td className="p-3">{r.assignmentsCreated}</td>
              <td className="p-3">{r.skippedCount}</td>
              <td className="p-3">{r.failedCount}</td>
              <td className="p-3">{r.messagesQueued}</td>
              <td className="p-3"><Badge variant={r.status === 'completed' ? 'success' : r.status === 'partial' ? 'warning' : 'danger'}>{r.status}</Badge></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
