import { useEffect, useState } from 'react';
import { Copy, KeyRound, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { integrationApi, type ApiKey, type CreatedApiKey, type ReportsApiScope } from './api';

function fmtDate(s: string | null): string {
  return s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' }) : '—';
}

export function ApiKeysTab(): JSX.Element {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [catalog, setCatalog] = useState<ReportsApiScope[]>([]);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expiresAt, setExpiresAt] = useState('');
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scopeLabel = (scope: string): string => catalog.find((c) => c.scope === scope)?.label ?? scope;

  const load = (): void => {
    integrationApi.listKeys().then(setKeys).catch(() => setKeys([]));
  };
  useEffect(() => {
    load();
    integrationApi.reportsApiCatalog().then((d) => setCatalog(d.scopes)).catch(() => setCatalog([]));
  }, []);

  const toggle = (scope: string): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });

  const create = async (): Promise<void> => {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const created = await integrationApi.createKey({
        name: name.trim(),
        scopes: [...selected],
        expiresAt: expiresAt || undefined,
      });
      setJustCreated(created);
      setName('');
      setSelected(new Set());
      setExpiresAt('');
      load();
    } catch (e) {
      setError((e as Error).message ?? 'Could not create the key.');
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string): Promise<void> => {
    await integrationApi.revokeKey(id);
    load();
  };

  const copyKey = (): void => {
    if (justCreated) {
      void navigator.clipboard?.writeText(justCreated.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="grid gap-6">
      {justCreated ? (
        <div className="rounded-lg border border-brand/40 bg-brand/5 p-4">
          <p className="mb-1 text-sm font-semibold text-brand">API key created — copy it now</p>
          <p className="mb-3 text-xs text-muted-foreground">This is the only time the full key is shown. Store it securely and share it with the external dashboard administrator over a secure channel.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-md bg-background px-3 py-2 text-sm">{justCreated.key}</code>
            <Button variant="outline" size="sm" onClick={copyKey}>
              <Copy className="mr-1 size-3.5" />{copied ? 'Copied' : 'Copy'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setJustCreated(null)}>Done</Button>
          </div>
        </div>
      ) : null}

      <div className="rounded-lg border border-border bg-card p-4 shadow-card">
        <h3 className="mb-1 flex items-center gap-2 text-sm font-bold"><KeyRound className="size-4" /> Issue a new external dashboard API key</h3>
        <p className="mb-3 text-xs text-muted-foreground">The key can read only the dashboards/reports you grant below, and only for this organization. Access is read-only.</p>
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1">
              <Label htmlFor="key-name" className="text-xs">Name</Label>
              <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Executive Dashboard - Power BI" />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="key-expiry" className="text-xs">Expiry (optional)</Label>
              <Input id="key-expiry" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label className="text-xs">Permitted data (scopes)</Label>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {catalog.map((c) => (
                <label key={c.scope} className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 text-sm hover:bg-muted/40">
                  <input type="checkbox" className="mt-0.5" checked={selected.has(c.scope)} onChange={() => toggle(c.scope)} />
                  <span>
                    <span className="font-medium">{c.label}</span>
                    <span className="block text-[11px] text-muted-foreground">{c.description}</span>
                  </span>
                </label>
              ))}
            </div>
            {catalog.length > 0 && (
              <div className="flex gap-2 text-xs">
                <button className="text-brand hover:underline" onClick={() => setSelected(new Set(catalog.map((c) => c.scope)))}>Select all</button>
                <span className="text-muted-foreground">·</span>
                <button className="text-brand hover:underline" onClick={() => setSelected(new Set())}>Clear</button>
              </div>
            )}
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
          <div>
            <Button onClick={create} disabled={creating || !name.trim() || selected.size === 0}>{creating ? 'Creating…' : 'Create key'}</Button>
            {selected.size === 0 && <span className="ml-2 text-xs text-muted-foreground">Select at least one scope.</span>}
          </div>
        </div>
      </div>

      {!keys ? (
        <Skeleton className="h-40 w-full" />
      ) : keys.length === 0 ? (
        <Empty text="No API keys yet. Issue one above to enable an external dashboard." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground">
              <tr><th className="p-3">Name</th><th className="p-3">Prefix</th><th className="p-3">Scopes</th><th className="p-3">Created</th><th className="p-3">Expires</th><th className="p-3">Last used</th><th className="p-3">Status</th><th className="p-3"></th></tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className="border-t border-border align-top">
                  <td className="p-3 font-medium">{k.name}</td>
                  <td className="p-3"><code className="text-xs">{k.prefix}…</code></td>
                  <td className="p-3">
                    <div className="flex max-w-xs flex-wrap gap-1">
                      {k.scopes.length ? k.scopes.map((s) => <Badge key={s} variant="neutral" className="text-[10px]">{scopeLabel(s)}</Badge>) : <span className="text-xs text-muted-foreground">none</span>}
                    </div>
                  </td>
                  <td className="p-3 text-xs text-muted-foreground">{fmtDate(k.createdAt)}</td>
                  <td className="p-3 text-xs text-muted-foreground">{fmtDate(k.expiresAt)}</td>
                  <td className="p-3 text-xs text-muted-foreground">{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'never'}</td>
                  <td className="p-3"><Badge variant={k.status === 'active' ? 'success' : k.status === 'expired' ? 'warning' : 'neutral'}>{k.status}</Badge></td>
                  <td className="p-3 text-right">
                    {k.status === 'active' ? (
                      <Button variant="ghost" size="sm" onClick={() => revoke(k.id)} title="Revoke immediately"><Trash2 className="size-3.5" /></Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }): JSX.Element {
  return <div className="rounded-lg border border-dashed border-border bg-muted/40 p-10 text-center text-sm text-muted-foreground">{text}</div>;
}
