import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, ShieldCheck, ShieldAlert, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import { usePermissions } from '@/features/auth/AuthContext';
import { licenseApi, type LicenseStatus, type LicenseView } from './api';

/**
 * Licence administration.
 *
 * The page leads with what an administrator actually needs to know — is it valid, until
 * when, how much of it is used — and keeps installation below that, because installing
 * happens once or twice a year while checking happens far more often.
 */

const TONE: Record<LicenseStatus, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  ACTIVE:       { label: 'Active',        cls: 'bg-emerald-50 text-emerald-800 border-emerald-200', Icon: CheckCircle2 },
  EXPIRING:     { label: 'Expiring soon', cls: 'bg-amber-50 text-amber-900 border-amber-200',      Icon: Clock },
  GRACE_PERIOD: { label: 'Grace period',  cls: 'bg-amber-50 text-amber-900 border-amber-200',      Icon: AlertTriangle },
  EXPIRED:      { label: 'Expired',       cls: 'bg-red-50 text-red-800 border-red-200',            Icon: ShieldAlert },
  NOT_STARTED:  { label: 'Not yet active',cls: 'bg-slate-50 text-slate-700 border-slate-200',      Icon: Clock },
  SUSPENDED:    { label: 'Suspended',     cls: 'bg-red-50 text-red-800 border-red-200',            Icon: ShieldAlert },
  INVALID:      { label: 'Invalid',       cls: 'bg-red-50 text-red-800 border-red-200',            Icon: ShieldAlert },
  NONE:         { label: 'Not licensed',  cls: 'bg-slate-50 text-slate-700 border-slate-200',      Icon: ShieldAlert },
};

export function LicensePage(): JSX.Element {
  const { has } = usePermissions();
  const { success, error: toastError } = useToast();
  const [view, setView] = useState<LicenseView | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const canInstall = has('configuration.manage');

  function load(): void {
    licenseApi.get().then(setView).catch(() => toastError('Could not load licence information.'));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  async function install(): Promise<void> {
    if (!key.trim()) return;
    setBusy(true);
    try {
      const next = await licenseApi.install(key.trim());
      setView(next);
      setKey('');
      success('Licence installed.');
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : 'Could not install that licence.');
    } finally {
      setBusy(false);
    }
  }

  function onFile(file: File | undefined): void {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setKey(String(reader.result).trim());
    reader.readAsText(file);
  }

  if (!view) return <Skeleton className="h-96 w-full" />;
  const tone = TONE[view.status] ?? TONE.NONE;
  const usage = view.usage;

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Licence</h1>
        <p className="text-sm text-muted-foreground">
          What this installation is licensed for, how much of it is in use, and how to renew.
        </p>
      </div>

      {/* Status first — the answer to the question that brought them here. */}
      <Card className={`grid gap-2 border p-5 ${tone.cls}`}>
        <div className="flex items-center gap-2">
          <tone.Icon className="size-5" />
          <span className="text-sm font-extrabold uppercase tracking-wider">{tone.label}</span>
          {view.isDevelopment ? (
            <span className="rounded-full border border-current/30 px-2 py-0.5 text-[11px] font-bold">Development</span>
          ) : null}
        </div>
        <p className="text-sm leading-relaxed">{view.message}</p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="grid content-start gap-3 p-5 lg:col-span-2">
          <h2 className="text-sm font-bold tracking-tight">Licence details</h2>
          {view.license ? (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
              <Row k="Organization" v={view.license.organizationName} />
              <Row k="Licence ID" v={view.license.licenseId} mono />
              <Row k="Edition" v={cap(view.license.edition)} />
              <Row k="Start date" v={date(view.license.startsAt)} />
              <Row k="Expiry date" v={date(view.license.expiresAt)} />
              <Row
                k="Days remaining"
                v={view.daysRemaining === null ? '—' : view.daysRemaining >= 0 ? `${view.daysRemaining}` : `expired ${Math.abs(view.daysRemaining)} days ago`}
              />
              {view.license.notes ? <Row k="Notes" v={view.license.notes} /> : null}
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">No licence is installed.</p>
          )}
        </Card>

        <Card className="grid content-start gap-4 p-5">
          <h2 className="text-sm font-bold tracking-tight">Usage</h2>
          {usage ? (
            <>
              <Meter
                label="Active employees"
                value={usage.employees}
                max={usage.maxEmployees}
                caption={usage.maxEmployees ? `${usage.employeePercent}% of licence` : 'Unlimited'}
              />
              {usage.maxUsers ? (
                <Meter label="Active users" value={usage.users} max={usage.maxUsers} caption={`of ${usage.maxUsers}`} />
              ) : (
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Active users</p>
                  <p className="text-2xl font-extrabold tabular-nums">{usage.users}</p>
                  <p className="text-xs text-muted-foreground">Not limited by this licence</p>
                </div>
              )}
            </>
          ) : null}
        </Card>
      </div>

      <Card className="grid gap-3 p-5">
        <div>
          <h2 className="text-sm font-bold tracking-tight">Included modules</h2>
          <p className="text-xs text-muted-foreground">
            A module not listed here is unavailable to everyone, regardless of their permissions.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {view.modules.map((m) => (
            <span key={m.key} className="flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1 text-xs font-semibold">
              <ShieldCheck className="size-3.5 text-emerald-600" /> {m.label}
            </span>
          ))}
        </div>
      </Card>

      {canInstall ? (
        <Card className="grid gap-3 p-5">
          <div>
            <h2 className="text-sm font-bold tracking-tight">
              {view.license && !view.isDevelopment ? 'Replace or renew licence' : 'Install licence'}
            </h2>
            <p className="text-xs text-muted-foreground">
              Paste the licence supplied to you, or choose the file. It is checked before anything is
              saved, so an incorrect licence cannot displace a working one.
            </p>
          </div>
          <Textarea
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="E360-…"
            className="min-h-[7rem] font-mono text-xs"
            spellCheck={false}
          />
          <div className="flex flex-wrap items-center gap-2">
            <label className="cursor-pointer rounded-md border border-input bg-card px-3 py-2 text-xs font-semibold hover:bg-muted/40">
              Choose file
              <input type="file" accept=".txt,.lic,.key,text/plain" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            </label>
            <Button onClick={install} disabled={busy || !key.trim()}>
              <Upload className="size-4" /> {busy ? 'Installing…' : 'Install licence'}
            </Button>
          </div>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">
          Installing a licence requires the Configuration management permission. Please contact a Super Admin.
        </p>
      )}
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }): JSX.Element {
  return (
    <div>
      <dt className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{k}</dt>
      <dd className={`text-sm font-semibold ${mono ? 'font-mono' : ''}`}>{v}</dd>
    </div>
  );
}

function Meter({ label, value, max, caption }: { label: string; value: number; max: number; caption: string }): JSX.Element {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  // Colour carries the same information as the number, so a page that is scanned
  // rather than read still says "you are near the limit".
  const bar = pct >= 100 ? 'bg-red-500' : pct >= 90 ? 'bg-amber-500' : 'bg-brand';
  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-2xl font-extrabold tabular-nums">
        {value}
        {max > 0 ? <span className="text-base font-bold text-muted-foreground"> / {max}</span> : null}
      </p>
      {max > 0 ? (
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
          <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      <p className="mt-1 text-xs text-muted-foreground">{caption}</p>
    </div>
  );
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
function date(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
