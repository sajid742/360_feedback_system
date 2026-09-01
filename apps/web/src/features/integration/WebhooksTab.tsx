import { useEffect, useState } from 'react';
import { Copy, Send, Trash2, Webhook } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  integrationApi,
  WEBHOOK_EVENTS,
  type CreatedWebhook,
  type TestResult,
  type WebhookDelivery,
  type WebhookEndpoint,
} from './api';

export function WebhooksTab(): JSX.Element {
  const [hooks, setHooks] = useState<WebhookEndpoint[] | null>(null);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<CreatedWebhook | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [testResult, setTestResult] = useState<Record<string, TestResult>>({});

  const load = (): void => {
    integrationApi.listWebhooks().then(setHooks);
  };
  useEffect(load, []);

  const toggleEvent = (event: string): void => {
    setEvents((prev) => (prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]));
  };

  const create = async (): Promise<void> => {
    if (!url.trim()) return;
    setCreating(true);
    try {
      const created = await integrationApi.createWebhook({ url: url.trim(), events });
      setJustCreated(created);
      setUrl('');
      setEvents([]);
      load();
    } finally {
      setCreating(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    await integrationApi.deleteWebhook(id);
    if (expanded === id) setExpanded(null);
    load();
  };

  const runTest = async (id: string): Promise<void> => {
    const result = await integrationApi.test(id);
    setTestResult((prev) => ({ ...prev, [id]: result }));
    if (expanded === id) integrationApi.deliveries(id).then(setDeliveries);
  };

  const toggleExpand = (id: string): void => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    integrationApi.deliveries(id).then(setDeliveries);
  };

  return (
    <div className="grid gap-6">
      {justCreated ? (
        <div className="rounded-lg border border-brand/40 bg-brand/5 p-4">
          <p className="mb-1 text-sm font-semibold text-brand">Webhook created — copy the signing secret now</p>
          <p className="mb-3 text-xs text-muted-foreground">Use it to verify the <code>X-E360-Signature</code> (HMAC-SHA256) header. Shown only once.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-md bg-background px-3 py-2 text-sm">{justCreated.secret}</code>
            <Button variant="outline" size="sm" onClick={() => navigator.clipboard?.writeText(justCreated.secret)}>
              <Copy className="mr-1 size-3.5" />Copy
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setJustCreated(null)}>Done</Button>
          </div>
        </div>
      ) : null}

      <div className="rounded-lg border border-border bg-card p-4 shadow-card">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-bold"><Webhook className="size-4" /> Register a webhook endpoint</h3>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="hook-url" className="text-xs">Endpoint URL</Label>
            <Input id="hook-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.example.com/e360" />
          </div>
          <div className="grid gap-1">
            <Label className="text-xs">Events (none selected = all events)</Label>
            <div className="flex flex-wrap gap-2">
              {WEBHOOK_EVENTS.map((ev) => (
                <button
                  key={ev}
                  type="button"
                  onClick={() => toggleEvent(ev)}
                  className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                    events.includes(ev) ? 'border-brand bg-brand/10 text-brand' : 'border-border text-muted-foreground hover:bg-muted'
                  }`}
                >
                  {ev}
                </button>
              ))}
            </div>
          </div>
          <div>
            <Button onClick={create} disabled={creating || !url.trim()}>{creating ? 'Registering…' : 'Register endpoint'}</Button>
          </div>
        </div>
      </div>

      {!hooks ? (
        <Skeleton className="h-40 w-full" />
      ) : hooks.length === 0 ? (
        <Empty text="No webhook endpoints yet. Register one above to receive event notifications." />
      ) : (
        <div className="grid gap-3">
          {hooks.map((h) => (
            <div key={h.id} className="rounded-lg border border-border bg-card p-4 shadow-card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="truncate text-sm font-medium">{h.url}</code>
                    <Badge variant={h.isActive ? 'success' : 'neutral'}>{h.isActive ? 'active' : 'inactive'}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {h.events.length ? h.events.join(', ') : 'all events'} · secret {h.secretMasked}
                  </p>
                  {testResult[h.id] ? (
                    <p className="mt-1 text-xs">
                      Last test:{' '}
                      <Badge variant={testResult[h.id].status === 'success' ? 'success' : 'danger'}>
                        {testResult[h.id].status}{testResult[h.id].statusCode ? ` (${testResult[h.id].statusCode})` : ''}
                      </Badge>
                      {testResult[h.id].error ? <span className="ml-1 text-muted-foreground">{testResult[h.id].error}</span> : null}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="sm" onClick={() => runTest(h.id)}><Send className="mr-1 size-3.5" />Test</Button>
                  <Button variant="ghost" size="sm" onClick={() => toggleExpand(h.id)}>{expanded === h.id ? 'Hide' : 'Deliveries'}</Button>
                  <Button variant="ghost" size="sm" onClick={() => remove(h.id)}><Trash2 className="size-3.5" /></Button>
                </div>
              </div>

              {expanded === h.id ? (
                <div className="mt-3 border-t border-border pt-3">
                  {deliveries.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No deliveries recorded yet — send a test or trigger a subscribed event.</p>
                  ) : (
                    <div className="grid gap-1">
                      {deliveries.map((d) => (
                        <div key={d.id} className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-1.5 text-xs">
                          <span className="font-medium">{d.event}</span>
                          <span className="flex items-center gap-2 text-muted-foreground">
                            <span>{new Date(d.createdAt).toLocaleString()}</span>
                            <Badge variant={d.status === 'success' ? 'success' : 'danger'}>{d.status}{d.statusCode ? ` ${d.statusCode}` : ''}</Badge>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }): JSX.Element {
  return <div className="rounded-lg border border-dashed border-border bg-muted/40 p-10 text-center text-sm text-muted-foreground">{text}</div>;
}
