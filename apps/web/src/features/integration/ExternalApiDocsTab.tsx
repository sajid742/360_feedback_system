import { useEffect, useState } from 'react';
import { BookOpen, Copy, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { integrationApi, type ReportsApiDoc } from './api';

/** Read-only documentation for the external Reports API. No secret is ever shown. */
export function ExternalApiDocsTab(): JSX.Element {
  const [doc, setDoc] = useState<ReportsApiDoc | null>(null);
  const [origin, setOrigin] = useState('');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    integrationApi.reportsApiCatalog().then(setDoc).catch(() => setDoc(null));
    setOrigin(window.location.origin);
  }, []);

  if (!doc) return <Skeleton className="h-96 w-full" />;

  const base = `${origin}${doc.baseUrl}`;
  const example = doc.endpoints[0] ?? { url: `${doc.baseUrl}/executive`, scope: 'reports.api.executive' };
  const exampleUrl = `${origin}${example.url}`;
  const curl = `curl -sS "${exampleUrl}" \\\n  -H "${doc.authHeader}: e360_xxxxxxxx.your-secret-here"`;
  const exampleResponse = JSON.stringify(
    { success: true, message: 'OK', data: { kpis: { participants: 128, completed: 96, completionPct: 75, avgScore: 4.13, enps: { score: 22 } }, readiness: { ready: 34, developing: 61, notYet: 33 } }, errors: null },
    null,
    2,
  );

  const copy = (text: string, tag: string): void => {
    void navigator.clipboard?.writeText(text);
    setCopied(tag);
    setTimeout(() => setCopied(''), 1500);
  };

  return (
    <div className="grid gap-6">
      <div className="rounded-lg border border-border bg-card p-4 shadow-card">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-bold"><BookOpen className="size-4" /> External Reports API <Badge variant="brand">{doc.version}</Badge>{doc.readOnly && <Badge variant="neutral">read-only</Badge>}</h3>
        <div className="grid gap-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Base URL</span>
            <code className="rounded bg-background px-2 py-1 text-xs">{base}</code>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => copy(base, 'base')}><Copy className="mr-1 size-3" />{copied === 'base' ? 'Copied' : 'Copy'}</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Authentication</span>
            <code className="rounded bg-background px-2 py-1 text-xs">{doc.authHeader}: &lt;your key&gt;</code>
            <span className="flex items-center gap-1 text-xs text-emerald-600"><ShieldCheck className="size-3.5" /> HTTPS + header only — never in the URL</span>
          </div>
        </div>
        <ul className="mt-3 grid list-disc gap-1 pl-5 text-xs text-muted-foreground">
          {doc.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground">
            <tr><th className="p-3">Endpoint</th><th className="p-3">Required scope</th><th className="p-3">Parameters</th><th className="p-3">Returns</th></tr>
          </thead>
          <tbody>
            {doc.endpoints.map((e) => (
              <tr key={e.url} className="border-t border-border align-top">
                <td className="p-3"><div className="font-medium">{e.label}</div><code className="text-[11px] text-muted-foreground">{e.method} {e.url}</code></td>
                <td className="p-3"><code className="text-[11px]">{e.scope}</code></td>
                <td className="p-3 text-xs text-muted-foreground">{e.params.length ? e.params.map((p) => `${p.name}${p.required ? '' : '?'}`).join(', ') : '—'}</td>
                <td className="p-3 text-[11px] text-muted-foreground">{e.responseKeys.slice(0, 6).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-4 shadow-card">
          <div className="mb-2 flex items-center justify-between"><h4 className="text-sm font-bold">Example request</h4><Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => copy(curl, 'curl')}><Copy className="mr-1 size-3" />{copied === 'curl' ? 'Copied' : 'Copy'}</Button></div>
          <pre className="overflow-x-auto rounded-md bg-background p-3 text-xs"><code>{curl}</code></pre>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 shadow-card">
          <h4 className="mb-2 text-sm font-bold">Example response</h4>
          <pre className="max-h-56 overflow-auto rounded-md bg-background p-3 text-xs"><code>{exampleResponse}</code></pre>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">Tip: in Power BI use <em>Get Data → Web → Advanced</em>, set the URL to an endpoint above and add an HTTP request header named <code>{doc.authHeader}</code> with the key value. Then expand the <code>data</code> record.</p>
    </div>
  );
}
