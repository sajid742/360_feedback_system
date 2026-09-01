import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Link2, Send, Save, RotateCcw, FlaskConical } from 'lucide-react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePermissions } from '@/features/auth/AuthContext';
import { ApiError } from '@/lib/api-client';
import {
  commApi,
  type Channel,
  type CommMeta,
  type CommSettings,
  type Notification,
  type ShortLink,
  type Template,
} from './api';

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  sent: 'success',
  delivered: 'success',
  queued: 'info',
  failed: 'danger',
};

const selectClass =
  'h-10 rounded-md border border-input bg-card px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * The one value every outbound link is built from. It used to sit inside the webhook
 * block bound to the EFFECTIVE url, which meant saving anything on this tab wrote the
 * resolved default — usually http://localhost:5173 — into the database, where it then
 * shadowed PUBLIC_APP_URL permanently. It now binds to what was explicitly configured;
 * blank means inherit, and the effective value is shown as placeholder plus a status line.
 */
function PublicUrlField({ general, setGeneral, settings }: { general: { publicBaseUrlConfigured: string; webhookSecret: string }; setGeneral: (v: { publicBaseUrlConfigured: string; webhookSecret: string }) => void; settings: CommSettings }): JSX.Element {
  const g = settings.providers.general;
  const source = { database: 'set here', environment: 'from PUBLIC_APP_URL', default: 'built-in development default' }[g.publicBaseUrlSource ?? 'default'];
  return (
    <Field label="Public application URL">
      <Input
        value={general.publicBaseUrlConfigured}
        onChange={(e) => setGeneral({ ...general, publicBaseUrlConfigured: e.target.value })}
        placeholder={g.publicBaseUrl}
      />
      <p className="mt-1 text-xs text-muted-foreground">
        Parent evaluations, password resets and short links are all built from this. Leave it blank to
        inherit the server's <code>PUBLIC_APP_URL</code>.
      </p>
      <p className="mt-1 text-xs">
        <span className="text-muted-foreground">Links are being sent as</span>{' '}
        <span className={g.publicBaseUrlUsable === false ? 'font-medium text-red-600' : 'font-medium'}>{g.publicBaseUrl}</span>{' '}
        <span className="text-muted-foreground">({source})</span>
      </p>
      {g.publicBaseUrlUsable === false ? (
        <p className="mt-1 text-xs text-red-600">
          That address only resolves on the recipient's own machine, so links sent to parents will not open.
          Set <code>PUBLIC_APP_URL</code> on the server, or enter the address people actually use here.
        </p>
      ) : null}
    </Field>
  );
}

export function CommunicationPage(): JSX.Element {
  const { has } = usePermissions();
  const canManage = has('communication.manage');
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Communication</h1>
        <p className="text-sm text-muted-foreground">
          Send messages and manage links, templates, providers and branding across Email, SMS, and WhatsApp.
        </p>
      </div>
      <Card className="p-4 sm:p-5">
        <Tabs defaultValue="send">
          <TabsList>
            <TabsTrigger value="send">Send</TabsTrigger>
            <TabsTrigger value="notifications">Notifications</TabsTrigger>
            <TabsTrigger value="links">Short Links</TabsTrigger>
            {canManage ? <TabsTrigger value="templates">Templates</TabsTrigger> : null}
            {canManage ? <TabsTrigger value="providers">Providers</TabsTrigger> : null}
            {canManage ? <TabsTrigger value="automation">Branding &amp; Channels</TabsTrigger> : null}
          </TabsList>
          <TabsContent value="send">
            <SendPanel />
          </TabsContent>
          <TabsContent value="notifications">
            <NotificationsPanel />
          </TabsContent>
          <TabsContent value="links">
            <ShortLinksPanel />
          </TabsContent>
          {canManage ? (
            <TabsContent value="templates">
              <TemplatesPanel />
            </TabsContent>
          ) : null}
          {canManage ? (
            <TabsContent value="providers">
              <ProvidersPanel />
            </TabsContent>
          ) : null}
          {canManage ? (
            <TabsContent value="automation">
              <AutomationPanel />
            </TabsContent>
          ) : null}
        </Tabs>
      </Card>
    </div>
  );
}

function SendPanel(): JSX.Element {
  const [form, setForm] = useState({ channel: 'email' as Channel, recipient: '', subject: '', body: '' });
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSending(true);
    setError(null);
    setResult(null);
    try {
      await commApi.send(form);
      setResult('Message queued for delivery.');
      setForm((f) => ({ ...f, recipient: '', subject: '', body: '' }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Send failed.');
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid max-w-lg gap-4">
      <div className="grid gap-2">
        <Label htmlFor="channel">Channel</Label>
        <select
          id="channel"
          value={form.channel}
          onChange={(e) => setForm((f) => ({ ...f, channel: e.target.value as Channel }))}
          className={selectClass}
        >
          <option value="email">Email</option>
          <option value="sms">SMS</option>
          <option value="whatsapp">WhatsApp</option>
        </select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="recipient">Recipient</Label>
        <Input id="recipient" value={form.recipient} onChange={(e) => setForm((f) => ({ ...f, recipient: e.target.value }))} placeholder="email or phone" />
      </div>
      {form.channel === 'email' ? (
        <div className="grid gap-2">
          <Label htmlFor="subject">Subject</Label>
          <Input id="subject" value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} />
        </div>
      ) : null}
      <div className="grid gap-2">
        <Label htmlFor="body">Message</Label>
        <Textarea id="body" value={form.body} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} />
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {result ? <p className="text-sm text-emerald-600">{result}</p> : null}
      <Button type="submit" disabled={sending} className="w-fit">
        <Send /> {sending ? 'Sending…' : 'Send'}
      </Button>
    </form>
  );
}

function NotificationsPanel(): JSX.Element {
  const [items, setItems] = useState<Notification[] | null>(null);
  useEffect(() => {
    commApi.listNotifications().then(setItems);
  }, []);
  if (!items) return <Skeleton className="h-40 w-full" />;
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="p-3">Recipient</th>
            <th className="p-3">Channel</th>
            <th className="p-3">Status</th>
            <th className="p-3">Reason / provider</th>
            <th className="p-3">When</th>
          </tr>
        </thead>
        <tbody>
          {items.map((n) => (
            <tr key={n.id} className="border-t border-border align-top">
              <td className="p-3">{n.recipient}</td>
              <td className="p-3">{n.channel}</td>
              <td className="p-3">
                <Badge variant={STATUS_VARIANT[n.status] ?? 'neutral'}>{n.status}</Badge>
              </td>
              {/*
                The reason a message did not arrive was recorded on the row all along
                and simply never shown, so this table reported "failed" or "skipped"
                without ever saying why — the one question it exists to answer.
              */}
              <td className="max-w-md p-3 text-xs text-muted-foreground">
                {n.error ? <span className="break-words">{n.error}</span>
                  : n.provider ? <span>sent via {n.provider}</span>
                  : <span>—</span>}
              </td>
              <td className="p-3 text-muted-foreground">{new Date(n.createdAt).toLocaleString()}</td>
            </tr>
          ))}
          {items.length === 0 ? (
            <tr>
              <td colSpan={5} className="p-8 text-center text-muted-foreground">
                No notifications yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function ShortLinksPanel(): JSX.Element {
  const [items, setItems] = useState<ShortLink[] | null>(null);
  const [url, setUrl] = useState('');

  const reload = useCallback(() => {
    commApi.listShortLinks().then(setItems);
  }, []);
  useEffect(() => reload(), [reload]);

  async function create(): Promise<void> {
    if (!url.trim()) return;
    await commApi.createShortLink(url.trim());
    setUrl('');
    reload();
  }

  if (!items) return <Skeleton className="h-40 w-full" />;
  return (
    <div className="grid gap-4">
      <div className="flex gap-2">
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/notices/term-2-schedule" />
        <Button onClick={create}>
          <Link2 /> Shorten
        </Button>
      </div>
      <div className="grid gap-2">
        {items.map((l) => (
          <div key={l.id} className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2">
            <div className="min-w-0">
              <p className="font-mono text-sm font-medium">/r/{l.code}</p>
              <p className="truncate text-xs text-muted-foreground">{l.targetUrl}</p>
            </div>
            <Badge variant="info">{l.clicks} clicks</Badge>
          </div>
        ))}
        {items.length === 0 ? <p className="text-sm text-muted-foreground">No short links yet.</p> : null}
      </div>
    </div>
  );
}

/* ------------------------------ Templates -------------------------------- */

function TemplatesPanel(): JSX.Element {
  const [meta, setMeta] = useState<CommMeta | null>(null);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [event, setEvent] = useState<CommMeta['events'][number]['event']>('cycle_started');
  const [channel, setChannel] = useState<Channel>('email');
  const [draft, setDraft] = useState<Template | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(() => {
    commApi.listTemplates().then(setTemplates);
  }, []);
  useEffect(() => {
    commApi.meta().then(setMeta);
    reload();
  }, [reload]);

  const current = useMemo(
    () => templates?.find((t) => t.event === event && t.channel === channel) ?? null,
    [templates, event, channel],
  );
  useEffect(() => {
    if (current) setDraft({ ...current });
  }, [current]);

  async function save(): Promise<void> {
    if (!draft) return;
    setSaving(true);
    setStatus(null);
    try {
      await commApi.saveTemplate({ event, channel, subject: draft.subject, body: draft.body, isActive: draft.isActive });
      setStatus('Template saved.');
      reload();
    } catch (err) {
      setStatus(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  async function reset(): Promise<void> {
    setSaving(true);
    setStatus(null);
    try {
      const restored = await commApi.resetTemplate({ event, channel });
      setDraft({ ...restored });
      setStatus('Reverted to the built-in default.');
      reload();
    } catch (err) {
      setStatus(err instanceof ApiError ? err.message : 'Reset failed.');
    } finally {
      setSaving(false);
    }
  }

  if (!meta || !templates || !draft) return <Skeleton className="h-64 w-full" />;
  const selectedEvent = meta.events.find((e) => e.event === event);

  return (
    <div className="grid gap-5 lg:grid-cols-[220px_1fr]">
      <div className="grid content-start gap-2">
        <Label>Event</Label>
        <select value={event} onChange={(e) => setEvent(e.target.value as typeof event)} className={selectClass}>
          {meta.events.map((e) => (
            <option key={e.event} value={e.event}>
              {e.label}
            </option>
          ))}
        </select>
        <Label className="mt-2">Channel</Label>
        <select value={channel} onChange={(e) => setChannel(e.target.value as Channel)} className={selectClass}>
          {meta.channels.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <p className="mt-2 text-xs text-muted-foreground">{selectedEvent?.description}</p>
        <div className="mt-1">
          <Badge variant={current?.isCustom ? 'info' : 'neutral'}>{current?.isCustom ? 'Customised' : 'Default'}</Badge>
        </div>
      </div>

      <div className="grid gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} />
          Enabled — send this notification for this channel
        </label>
        {channel !== 'sms' ? (
          <div className="grid gap-2">
            <Label htmlFor="tpl-subject">Subject</Label>
            <Input id="tpl-subject" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
          </div>
        ) : null}
        <div className="grid gap-2">
          <Label htmlFor="tpl-body">Body</Label>
          <Textarea id="tpl-body" rows={10} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Placeholders — click to insert</p>
          <div className="flex flex-wrap gap-1.5">
            {meta.placeholders.map((p) => (
              <button
                key={p.token}
                type="button"
                onClick={() => setDraft({ ...draft, body: `${draft.body}{{${p.token}}}` })}
                className="rounded-md border border-border bg-muted/50 px-2 py-1 font-mono text-xs hover:bg-muted"
                title={p.label}
              >
                {`{{${p.token}}}`}
              </button>
            ))}
          </div>
        </div>
        {status ? <p className="text-sm text-emerald-600">{status}</p> : null}
        <div className="flex gap-2">
          <Button onClick={save} disabled={saving} className="w-fit">
            <Save /> {saving ? 'Saving…' : 'Save template'}
          </Button>
          <Button variant="outline" onClick={reset} disabled={saving || !current?.isCustom} className="w-fit">
            <RotateCcw /> Reset to default
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ Providers -------------------------------- */

function ProvidersPanel(): JSX.Element {
  const [settings, setSettings] = useState<CommSettings | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState({ channel: 'email' as Channel, recipient: '' });
  const [testStatus, setTestStatus] = useState<string | null>(null);

  // Editable copies; secret fields start blank and only overwrite when typed.
  const [email, setEmail] = useState({ enabled: false, host: '', port: 587, secure: false, auth: true, user: '', senderName: '', from: '', connectionTimeout: 10000, pass: '', allowUntrustedCertificate: false });
  const [sms, setSms] = useState({ enabled: false, provider: 'twilio', senderId: '', accountSid: '', authToken: '', endpoint: '', httpMethod: 'POST', bodyFormat: 'json', authType: 'bearer', apiKey: '', apiKeyHeader: '', username: '', password: '', oauthTokenUrl: '', oauthClientId: '', oauthClientSecret: '', toParam: 'to', messageParam: 'message', fromParam: 'from', retryMaxAttempts: 3, retryBackoffMs: 1000 });
  const [wa, setWa] = useState({ enabled: false, provider: 'meta', baseUrl: '', phoneNumberId: '', accessToken: '', accountSid: '', authToken: '', session: 'default', apiKey: '', businessNumber: '', webhookUrl: '' });
  // Delivery-webhook verification (F5): public base URL + the shared secret the
  // provider signs callbacks with. Secret is write-only — blank leaves it as-is.
  const [general, setGeneral] = useState({ publicBaseUrlConfigured: '', webhookSecret: '' });

  useEffect(() => {
    commApi.getSettings().then((s) => {
      setSettings(s);
      const e = s.providers.email, m = s.providers.sms, w = s.providers.whatsapp;
      setEmail({ enabled: e.enabled, host: e.host, port: e.port, secure: e.secure, auth: e.auth, user: e.user, senderName: e.senderName, from: e.from, connectionTimeout: e.connectionTimeout, pass: '', allowUntrustedCertificate: Boolean(e.allowUntrustedCertificate) });
      setSms({ enabled: m.enabled, provider: m.provider, senderId: m.senderId, accountSid: m.accountSid, authToken: '', endpoint: m.endpoint, httpMethod: m.httpMethod, bodyFormat: m.bodyFormat, authType: m.authType, apiKey: '', apiKeyHeader: m.apiKeyHeader, username: m.username, password: '', oauthTokenUrl: m.oauthTokenUrl, oauthClientId: m.oauthClientId, oauthClientSecret: '', toParam: m.toParam, messageParam: m.messageParam, fromParam: m.fromParam, retryMaxAttempts: m.retryMaxAttempts, retryBackoffMs: m.retryBackoffMs });
      setWa({ enabled: w.enabled, provider: w.provider, baseUrl: w.baseUrl, phoneNumberId: w.phoneNumberId, accessToken: '', accountSid: w.accountSid, authToken: '', session: w.session, apiKey: '', businessNumber: w.businessNumber, webhookUrl: w.webhookUrl });
      // Bind to what was EXPLICITLY saved, never to the effective value. Loading the
      // effective value here is what used to freeze "http://localhost:5173" into the
      // database on the next save, after which PUBLIC_APP_URL was ignored for good.
      setGeneral({ publicBaseUrlConfigured: s.providers.general.publicBaseUrlConfigured ?? '', webhookSecret: '' });
    });
  }, []);

  async function save(): Promise<void> {
    setSaving(true);
    setStatus(null);
    try {
      await commApi.saveProviders({ email, sms, whatsapp: wa, general });
      setStatus('Provider settings saved. Secrets left blank are unchanged.');
      const s = await commApi.getSettings();
      setSettings(s);
      setEmail((v) => ({ ...v, pass: '' }));
      setSms((v) => ({ ...v, authToken: '', apiKey: '', password: '', oauthClientSecret: '' }));
      setWa((v) => ({ ...v, accessToken: '', authToken: '', apiKey: '' }));
      setGeneral((v) => ({ ...v, webhookSecret: '' }));
    } catch (err) {
      setStatus(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  async function runTest(): Promise<void> {
    setTestStatus(null);
    try {
      const r = await commApi.testSend(test);
      setTestStatus(r.status === 'sent' ? 'Test message sent.' : `Test ${r.status ?? 'attempted'}${r.error ? `: ${r.error}` : ''}.`);
    } catch (err) {
      setTestStatus(err instanceof ApiError ? err.message : 'Test failed.');
    }
  }

  if (!settings) return <Skeleton className="h-72 w-full" />;

  return (
    <div className="grid gap-6">
      <section className="grid gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Email (SMTP)</h3>
          <Toggle checked={email.enabled} onChange={(v) => setEmail({ ...email, enabled: v })} label="Enabled" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="SMTP Host"><Input value={email.host} onChange={(e) => setEmail({ ...email, host: e.target.value })} placeholder="smtp.example.com" /></Field>
          <Field label="SMTP Port"><Input type="number" value={email.port} onChange={(e) => setEmail({ ...email, port: Number(e.target.value) })} /></Field>
          <Field label="Username"><Input value={email.user} onChange={(e) => setEmail({ ...email, user: e.target.value })} /></Field>
          <Field label={`Password ${settings.providers.email.hasPass ? '(set — blank keeps)' : ''}`}><Input type="password" value={email.pass} onChange={(e) => setEmail({ ...email, pass: e.target.value })} /></Field>
          <Field label="Sender Name"><Input value={email.senderName} onChange={(e) => setEmail({ ...email, senderName: e.target.value })} placeholder="Your organisation" /></Field>
          <Field label="Sender Email"><Input value={email.from} onChange={(e) => setEmail({ ...email, from: e.target.value })} placeholder="360@example.com" /></Field>
          <Field label="Connection Timeout (ms)"><Input type="number" value={email.connectionTimeout} onChange={(e) => setEmail({ ...email, connectionTimeout: Number(e.target.value) })} /></Field>
          <div className="flex items-end gap-4">
            {/*
              This used to be a checkbox labelled "TLS/SSL", which is the wrong question.
              `secure` means IMPLICIT TLS (SMTPS, port 465) — a TLS handshake from the
              very first byte. On a STARTTLS port such as 587 the server answers with a
              plaintext greeting, so ticking it produced an opaque
              "wrong version number" SSL error and no mail. Naming the two modes and
              tying them to their usual ports removes the guess.
            */}
            <label className="flex items-center gap-2 text-sm">
              Security
              <select
                value={email.secure ? 'ssl' : 'starttls'}
                onChange={(e) => {
                  const ssl = e.target.value === 'ssl';
                  setEmail({ ...email, secure: ssl, port: ssl ? (email.port === 587 ? 465 : email.port) : (email.port === 465 ? 587 : email.port) });
                }}
                className={selectClass}
              >
                <option value="starttls">STARTTLS / None — port 587 or 25</option>
                <option value="ssl">SSL/TLS (implicit) — port 465</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={email.auth} onChange={(e) => setEmail({ ...email, auth: e.target.checked })} /> Authentication</label>
          </div>
          {/*
            Deliberately last, deliberately labelled with its consequence. Antivirus and
            corporate proxies that inspect HTTPS re-sign SMTP connections with their own
            authority, which Node does not trust — the send then fails with "self-signed
            certificate in certificate chain" even though the host, port and password are
            all correct. This unticks that check for administrators who cannot install the
            proxy's root certificate; NODE_EXTRA_CA_CERTS is the better answer and the
            hint below says so.
          */}
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={email.allowUntrustedCertificate}
              onChange={(e) => setEmail({ ...email, allowUntrustedCertificate: e.target.checked })}
            />
            <span>
              Accept untrusted certificate
              <span className="block text-xs text-muted-foreground">
                Send even if the server's TLS certificate cannot be verified. Tick this only for a test or internal
                mail server, or when antivirus/proxy TLS inspection causes
                &ldquo;self-signed certificate in certificate chain&rdquo;. The better fix is to start the API with
                <code className="mx-1">NODE_EXTRA_CA_CERTS</code>
                pointing at that authority&rsquo;s root certificate, which keeps verification switched on.
              </span>
            </span>
          </label>
        </div>
      </section>

      <section className="grid gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">SMS</h3>
          <Toggle checked={sms.enabled} onChange={(v) => setSms({ ...sms, enabled: v })} label="Enabled" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Provider">
            <select value={sms.provider} onChange={(e) => setSms({ ...sms, provider: e.target.value })} className={selectClass}>
              <option value="twilio">Twilio</option>
              <option value="generic">Generic HTTP gateway</option>
            </select>
          </Field>
          <Field label="Sender ID / From"><Input value={sms.senderId} onChange={(e) => setSms({ ...sms, senderId: e.target.value })} /></Field>
          {sms.provider === 'twilio' ? (
            <>
              <Field label="Account SID"><Input value={sms.accountSid} onChange={(e) => setSms({ ...sms, accountSid: e.target.value })} /></Field>
              <Field label={`Auth Token ${settings.providers.sms.hasAuthToken ? '(set — blank keeps)' : ''}`}><Input type="password" value={sms.authToken} onChange={(e) => setSms({ ...sms, authToken: e.target.value })} /></Field>
            </>
          ) : (
            <>
              <Field label="Provider URL / API endpoint"><Input value={sms.endpoint} onChange={(e) => setSms({ ...sms, endpoint: e.target.value })} placeholder="https://sms.example.com/send" /></Field>
              <Field label="HTTP method">
                <select value={sms.httpMethod} onChange={(e) => setSms({ ...sms, httpMethod: e.target.value })} className={selectClass}>
                  <option value="POST">POST</option><option value="GET">GET</option>
                </select>
              </Field>
              <Field label="Body format">
                <select value={sms.bodyFormat} onChange={(e) => setSms({ ...sms, bodyFormat: e.target.value })} className={selectClass}>
                  <option value="json">JSON</option><option value="form">Form-encoded</option>
                </select>
              </Field>
              <Field label="Authentication">
                <select value={sms.authType} onChange={(e) => setSms({ ...sms, authType: e.target.value })} className={selectClass}>
                  <option value="none">None</option><option value="apikey">API Key (header)</option><option value="basic">Basic</option><option value="bearer">Bearer token</option><option value="oauth2">OAuth2 client-credentials</option>
                </select>
              </Field>
              {sms.authType === 'apikey' ? (<>
                <Field label="API key header"><Input value={sms.apiKeyHeader} onChange={(e) => setSms({ ...sms, apiKeyHeader: e.target.value })} placeholder="X-API-Key" /></Field>
                <Field label={`API key ${settings.providers.sms.hasApiKey ? '(set — blank keeps)' : ''}`}><Input type="password" value={sms.apiKey} onChange={(e) => setSms({ ...sms, apiKey: e.target.value })} /></Field>
              </>) : null}
              {sms.authType === 'bearer' ? (
                <Field label={`Bearer token ${settings.providers.sms.hasApiKey ? '(set — blank keeps)' : ''}`}><Input type="password" value={sms.apiKey} onChange={(e) => setSms({ ...sms, apiKey: e.target.value })} /></Field>
              ) : null}
              {sms.authType === 'basic' ? (<>
                <Field label="Username"><Input value={sms.username} onChange={(e) => setSms({ ...sms, username: e.target.value })} /></Field>
                <Field label={`Password ${settings.providers.sms.hasPassword ? '(set — blank keeps)' : ''}`}><Input type="password" value={sms.password} onChange={(e) => setSms({ ...sms, password: e.target.value })} /></Field>
              </>) : null}
              {sms.authType === 'oauth2' ? (<>
                <Field label="Token URL"><Input value={sms.oauthTokenUrl} onChange={(e) => setSms({ ...sms, oauthTokenUrl: e.target.value })} /></Field>
                <Field label="Client ID"><Input value={sms.oauthClientId} onChange={(e) => setSms({ ...sms, oauthClientId: e.target.value })} /></Field>
                <Field label={`Client secret ${settings.providers.sms.hasOauthClientSecret ? '(set — blank keeps)' : ''}`}><Input type="password" value={sms.oauthClientSecret} onChange={(e) => setSms({ ...sms, oauthClientSecret: e.target.value })} /></Field>
              </>) : null}
              <Field label="Recipient field"><Input value={sms.toParam} onChange={(e) => setSms({ ...sms, toParam: e.target.value })} /></Field>
              <Field label="Message field"><Input value={sms.messageParam} onChange={(e) => setSms({ ...sms, messageParam: e.target.value })} /></Field>
              <Field label="Retry attempts"><Input type="number" value={sms.retryMaxAttempts} onChange={(e) => setSms({ ...sms, retryMaxAttempts: Number(e.target.value) })} /></Field>
              <Field label="Retry backoff (ms)"><Input type="number" value={sms.retryBackoffMs} onChange={(e) => setSms({ ...sms, retryBackoffMs: Number(e.target.value) })} /></Field>
            </>
          )}
        </div>
        <p className="text-xs text-muted-foreground">Message templates per event &amp; channel are managed in the Templates tab; delivery status is tracked under Notifications.</p>
      </section>

      <section className="grid gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">WhatsApp</h3>
          <Toggle checked={wa.enabled} onChange={(v) => setWa({ ...wa, enabled: v })} label="Enabled" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Provider">
            <select value={wa.provider} onChange={(e) => setWa({ ...wa, provider: e.target.value })} className={selectClass}>
              <option value="meta">Meta Cloud API</option>
              <option value="twilio">Twilio WhatsApp</option>
              <option value="waha">WAHA (WhatsApp HTTP API)</option>
              <option value="mock">Mock (record only)</option>
            </select>
          </Field>
          {wa.provider !== 'mock' ? <Field label="Base URL"><Input value={wa.baseUrl} onChange={(e) => setWa({ ...wa, baseUrl: e.target.value })} placeholder={wa.provider === 'waha' ? 'http://localhost:3000' : 'https://graph.facebook.com/v18.0'} /></Field> : null}
          {wa.provider === 'meta' ? (<>
            <Field label="Phone Number ID"><Input value={wa.phoneNumberId} onChange={(e) => setWa({ ...wa, phoneNumberId: e.target.value })} /></Field>
            <Field label={`Access Token ${settings.providers.whatsapp.hasAccessToken ? '(set — blank keeps)' : ''}`}><Input type="password" value={wa.accessToken} onChange={(e) => setWa({ ...wa, accessToken: e.target.value })} /></Field>
          </>) : null}
          {wa.provider === 'twilio' ? (<>
            <Field label="Account SID"><Input value={wa.accountSid} onChange={(e) => setWa({ ...wa, accountSid: e.target.value })} /></Field>
            <Field label={`Auth Token ${settings.providers.whatsapp.hasAuthToken ? '(set — blank keeps)' : ''}`}><Input type="password" value={wa.authToken} onChange={(e) => setWa({ ...wa, authToken: e.target.value })} /></Field>
            <Field label="Business Number"><Input value={wa.businessNumber} onChange={(e) => setWa({ ...wa, businessNumber: e.target.value })} placeholder="+14155238886" /></Field>
          </>) : null}
          {wa.provider === 'waha' ? (<>
            <Field label="Session"><Input value={wa.session} onChange={(e) => setWa({ ...wa, session: e.target.value })} placeholder="default" /></Field>
            <Field label={`API Key ${settings.providers.whatsapp.hasApiKey ? '(set — blank keeps)' : ''}`}><Input type="password" value={wa.apiKey} onChange={(e) => setWa({ ...wa, apiKey: e.target.value })} /></Field>
          </>) : null}
          {wa.provider !== 'mock' ? <Field label="Webhook URL (optional)"><Input value={wa.webhookUrl} onChange={(e) => setWa({ ...wa, webhookUrl: e.target.value })} /></Field> : null}
        </div>
      </section>

      <section className="grid gap-3">
        <h3 className="text-sm font-semibold">Public application URL</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <PublicUrlField general={general} setGeneral={setGeneral} settings={settings} />
        </div>
      </section>

      <section className="grid gap-3">
        <h3 className="text-sm font-semibold">Delivery webhooks</h3>
        <p className="text-xs text-muted-foreground">
          Providers call back to <code>/api/v1/communication/webhooks/&lt;provider&gt;</code> to report delivery status.
          Those callbacks must be signed: set a shared secret here and configure the same value at the provider.
          Callbacks that are unsigned or signed with the wrong secret are rejected, so delivery status will stop
          updating until both sides match.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`Webhook secret ${settings.providers.general.hasWebhookSecret ? '(set — blank keeps)' : '(not set — callbacks are rejected)'}`}>
            <div className="flex gap-2">
              <Input type="password" value={general.webhookSecret} onChange={(e) => setGeneral({ ...general, webhookSecret: e.target.value })} />
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  const bytes = new Uint8Array(24);
                  crypto.getRandomValues(bytes);
                  const secret = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
                  setGeneral({ ...general, webhookSecret: secret });
                  setStatus('Secret generated — copy it to your provider, then save.');
                }}
              >
                Generate
              </Button>
            </div>
          </Field>
        </div>
        {general.webhookSecret ? (
          <p className="break-all rounded-md bg-muted/50 px-3 py-2 font-mono text-xs">{general.webhookSecret}</p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Signature header: <code>X-Webhook-Signature: sha256=&lt;HMAC-SHA256 of the raw body&gt;</code>
          {' '}(<code>X-Hub-Signature-256</code> and <code>X-Twilio-Signature</code> are also accepted).
        </p>
      </section>

      {status ? <p className="text-sm text-emerald-600">{status}</p> : null}
      <Button onClick={save} disabled={saving} className="w-fit">
        <Save /> {saving ? 'Saving…' : 'Save provider settings'}
      </Button>

      <section className="grid gap-3 rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold">Send a test message</h3>
        <p className="text-xs text-muted-foreground">Bypasses the enable switch so you can validate credentials before turning a channel on.</p>
        <div className="flex flex-wrap items-end gap-2">
          <select value={test.channel} onChange={(e) => setTest({ ...test, channel: e.target.value as Channel })} className={selectClass}>
            <option value="email">Email</option>
            <option value="sms">SMS</option>
            <option value="whatsapp">WhatsApp</option>
          </select>
          <Input value={test.recipient} onChange={(e) => setTest({ ...test, recipient: e.target.value })} placeholder="email or phone" className="max-w-xs" />
          <Button variant="outline" onClick={runTest} disabled={!test.recipient.trim()}>
            <FlaskConical /> Send test
          </Button>
        </div>
        {testStatus ? <p className="text-sm text-muted-foreground">{testStatus}</p> : null}
      </section>
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }): JSX.Element {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/* --------------------------- Branding & Channels ------------------------- */

function AutomationPanel(): JSX.Element {
  const [settings, setSettings] = useState<CommSettings | null>(null);
  const [branding, setBranding] = useState({ organizationName: '', logoUrl: '', primaryColor: '#2563eb', supportEmail: '', footer: '' });
  const [channels, setChannels] = useState<Channel[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    commApi.getSettings().then((s) => {
      setSettings(s);
      setBranding({ ...s.branding });
      setChannels(s.defaults.channels);
    });
  }, []);

  function toggle(c: Channel): void {
    setChannels((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  }

  async function save(): Promise<void> {
    setSaving(true);
    setStatus(null);
    try {
      await commApi.saveBranding(branding);
      await commApi.saveDefaults(channels);
      setStatus('Branding and default channels saved.');
    } catch (err) {
      setStatus(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return <Skeleton className="h-72 w-full" />;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/*
        The branding fields that used to live here as a column of inputs now belong to
        Brand Studio, where they are edited against a live preview. Keeping a second
        editor for the same record would mean two places to change one logo.
      */}
      <section className="grid content-start gap-3">
        <h3 className="text-sm font-semibold">Branding</h3>
        <div className="rounded-lg border border-border bg-muted/40 p-4">
          <p className="text-sm font-medium">
            {branding.organizationName || 'Your organisation'} · {branding.primaryColor}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Name, logo, colours and the sign-in page are configured in Brand Studio, with a live
            preview of what staff and parents see.
          </p>
          <Link to="/branding" className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-brand hover:underline">
            Open Brand Studio →
          </Link>
        </div>
      </section>

      <section className="grid content-start gap-3">
        <h3 className="text-sm font-semibold">Default channels</h3>
        <p className="text-sm text-muted-foreground">
          Channels a cycle-start notification and other automated events fan out to by default. Internal users always
          also receive an in-app notification.
        </p>
        <div className="grid gap-2">
          {(['email', 'whatsapp', 'sms'] as Channel[]).map((c) => (
            <label key={c} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm capitalize">
              <input type="checkbox" checked={channels.includes(c)} onChange={() => toggle(c)} /> {c}
            </label>
          ))}
        </div>
        {status ? <p className="text-sm text-emerald-600">{status}</p> : null}
        <Button onClick={save} disabled={saving} className="w-fit">
          <Save /> {saving ? 'Saving…' : 'Save'}
        </Button>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
