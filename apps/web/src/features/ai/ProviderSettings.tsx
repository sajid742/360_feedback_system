import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, KeyRound, Plug, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import { usePermissions } from '@/features/auth/AuthContext';
import { aiApi, type AiProviderView } from './api';

/**
 * Connect an external language model.
 *
 * WHAT THIS ACTUALLY BUYS, stated plainly on the screen: one paragraph. Everything else
 * the AI Insights page shows — blind spots, recommendations, readiness, sentiment — is
 * computed on this server and does not change. An administrator deciding whether to send
 * staff data to a third party deserves to know it is buying prose, not analysis.
 *
 * THE KEY IS WRITE-ONLY. It is never returned by the API, so the field shows only the
 * last four characters of what is stored and an empty box means "keep it". Requiring the
 * key on every save would mean re-typing a secret to change a model name, which teaches
 * people to keep it in a text file.
 */
export function ProviderSettings(): JSX.Element {
  const { has } = usePermissions();
  const { success, error: toastError } = useToast();
  const [view, setView] = useState<AiProviderView | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);

  const canManage = has('configuration.manage');

  function load(): void {
    aiApi
      .provider()
      .then((v) => {
        setView(v);
        setBaseUrl(v.baseUrl ?? '');
        setModel(v.model ?? '');
        // On a FRESH setup the server reports `enabled: false` because nothing is
        // configured yet — but the switch is the intent for what is about to be saved,
        // and somebody filling this form in means to turn it on. Defaulting to off here
        // would have them save a provider that does nothing and wonder why.
        setEnabled(v.baseUrl ? v.enabled : true);
      })
      .catch(() => toastError('Could not load the provider settings.'));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  async function save(): Promise<void> {
    setBusy('save');
    setResult(null);
    try {
      const next = await aiApi.saveProvider({
        baseUrl: baseUrl.trim(),
        // Empty means "keep the stored key" — the server treats it that way.
        apiKey: apiKey.trim() || undefined,
        model: model.trim() || undefined,
        enabled,
      });
      setView(next);
      setApiKey('');
      success('Provider saved.');
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : 'Could not save the provider.');
    } finally {
      setBusy(null);
    }
  }

  async function test(): Promise<void> {
    setBusy('test');
    try {
      const r = await aiApi.testProvider();
      setResult({ ok: r.ok, detail: r.detail });
    } catch (err) {
      setResult({ ok: false, detail: err instanceof ApiError ? err.message : 'The test could not be run.' });
    } finally {
      setBusy(null);
    }
  }

  async function remove(): Promise<void> {
    setBusy('remove');
    setResult(null);
    try {
      const next = await aiApi.removeProvider();
      setView(next);
      setBaseUrl('');
      setApiKey('');
      setModel('');
      setEnabled(true);
      success('Provider removed. Insights now use the built-in engine.');
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : 'Could not remove the provider.');
    } finally {
      setBusy(null);
    }
  }

  if (!view) return <Skeleton className="h-80 w-full" />;

  return (
    <div className="grid gap-5 pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">Language model</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Optional. Connecting a model changes <b>one thing</b>: the written summary on the Individual insights tab.
            Blind spots, recommendations, promotion readiness and sentiment are all calculated on this server and are
            identical either way.
          </p>
        </div>
        <Badge variant={view.configured ? 'success' : 'neutral'}>
          {view.configured ? `Connected · ${view.model}` : 'Built-in engine'}
        </Badge>
      </div>

      {/* The disclosure belongs next to the button that causes it, not in a manual. */}
      <Card className="border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="flex items-center gap-2 font-semibold">
          <AlertTriangle className="size-4 shrink-0" />
          What leaves your organisation when this is on
        </p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <div>
            <p className="font-medium">Sent to the provider</p>
            <ul className="mt-1 list-disc pl-5">
              <li>The employee&rsquo;s name</li>
              <li>Their overall score and your target score</li>
              <li>Competency names with self and others&rsquo; scores</li>
              <li>Recommendations, readiness score and band</li>
              <li>Counts of positive, neutral and negative comments</li>
            </ul>
          </div>
          <div>
            <p className="font-medium">Never sent</p>
            <ul className="mt-1 list-disc pl-5">
              <li>The text of any comment</li>
              <li>Any reviewer&rsquo;s name or identity</li>
              <li>E-mail addresses or contact details</li>
              <li>Anything about employees other than the one being viewed</li>
            </ul>
          </div>
        </div>
        <p className="mt-3">
          One request is made each time an individual insight is opened. If you cannot send staff names outside your
          organisation, run a model on your own hardware &mdash; point this at Ollama or LM Studio on your own network
          and nothing leaves it.
        </p>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="ai-base-url">Base URL</Label>
          <Input
            id="ai-base-url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            disabled={!canManage}
          />
          <p className="text-xs text-muted-foreground">
            Any endpoint that speaks the OpenAI <code>/chat/completions</code> shape: OpenAI, Azure OpenAI, OpenRouter,
            or your own Ollama / LM Studio. Must be <code>https</code> on the public internet. Plain{' '}
            <code>http</code> is accepted for a model on your own private network &mdash; <code>localhost</code>, a
            container name such as <code>http://ollama:11434/v1</code>, <code>host.docker.internal</code>, or a
            10.x / 192.168.x address.
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="ai-key">API key</Label>
          <Input
            id="ai-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={view.apiKeyHint ? `Stored — ends ${view.apiKeyHint}` : 'sk-…'}
            disabled={!canManage}
          />
          <p className="text-xs text-muted-foreground">
            {view.apiKeyHint
              ? 'Leave blank to keep the stored key. It is never shown again once saved.'
              : 'Stored for this organisation only, and never returned by the API.'}
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="ai-model">Model</Label>
          <Input
            id="ai-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4o-mini"
            disabled={!canManage}
          />
          <p className="text-xs text-muted-foreground">The model name exactly as your provider spells it.</p>
        </div>

        <div className="flex items-center gap-3 sm:col-span-2">
          <Switch id="ai-enabled" checked={enabled} onCheckedChange={setEnabled} disabled={!canManage} />
          <Label htmlFor="ai-enabled" className="cursor-pointer">
            Use this provider
            <span className="ml-2 font-normal text-muted-foreground">
              Turn it off to keep the settings but fall back to the built-in engine.
            </span>
          </Label>
        </div>
      </div>

      {result ? (
        <Card
          className={`flex items-start gap-2 p-3 text-sm ${
            result.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900'
          }`}
        >
          {result.ok ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          )}
          <span>{result.detail}</span>
        </Card>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button onClick={save} disabled={!canManage || busy !== null || !baseUrl.trim()}>
          <KeyRound className="mr-1.5 size-4" />
          {busy === 'save' ? 'Saving…' : 'Save provider'}
        </Button>
        <Button variant="outline" onClick={test} disabled={!canManage || busy !== null || !view.configured}>
          <Plug className="mr-1.5 size-4" />
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </Button>
        {view.baseUrl ? (
          <Button variant="outline" onClick={remove} disabled={!canManage || busy !== null}>
            <Trash2 className="mr-1.5 size-4" />
            Remove
          </Button>
        ) : null}
      </div>

      {!canManage ? (
        <p className="text-sm text-muted-foreground">
          You can see these settings but not change them. Changing a provider needs the <b>Manage configuration</b>{' '}
          permission.
        </p>
      ) : null}

      <Card className="p-4 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">If the provider stops answering</p>
        <p className="mt-1">
          Nothing breaks. A failure, a timeout or a wrong key all produce the same result: the summary is written by the
          built-in engine instead, the badge on this page reads <b>Built-in engine</b>, and a warning goes to the
          application log. Because that fallback is silent by design, use <b>Test connection</b> after any change rather
          than waiting to notice.
        </p>
      </Card>
    </div>
  );
}
