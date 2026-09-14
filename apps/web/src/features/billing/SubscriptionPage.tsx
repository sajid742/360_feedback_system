import { useEffect, useState } from 'react';
import {
  AlertTriangle, ArrowUpRight, Ban, Check, CheckCircle2, Clock, Copy, Landmark, Minus, RotateCcw, ShieldAlert,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import { usePermissions } from '@/features/auth/AuthContext';
import { refreshEntitlements, useEntitlements } from '@/features/license/useEntitlements';
import { billingApi, type BillingSummary, type CheckoutResponse, type InvoiceView, type PlanOffer } from './api';

/**
 * Subscription and billing, for the organisation's own administrator.
 *
 * WHAT THIS SCREEN CAN DO: see the plan, the period, what is used against each limit,
 * the invoices and the payments; choose a different plan; cancel; reactivate.
 *
 * WHAT IT DELIBERATELY CANNOT DO: mark anything paid. Recording money is a platform act
 * — an organisation that could record its own payment could award itself any plan. So
 * choosing a paid plan here produces an INVOICE and the instructions to pay it, and the
 * plan changes when the payment is recognised, either by the provider's webhook or by an
 * operator confirming the bank transfer. That is also why there is no card form
 * anywhere in this application: card details are never handled here.
 */

const TONE: Record<string, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  active:    { label: 'Active',          cls: 'bg-emerald-50 text-emerald-800 border-emerald-200', Icon: CheckCircle2 },
  trialing:  { label: 'Trial',           cls: 'bg-sky-50 text-sky-800 border-sky-200',             Icon: Clock },
  past_due:  { label: 'Payment overdue', cls: 'bg-amber-50 text-amber-900 border-amber-200',       Icon: AlertTriangle },
  grace:     { label: 'Grace period',    cls: 'bg-amber-50 text-amber-900 border-amber-200',       Icon: AlertTriangle },
  expired:   { label: 'Expired',         cls: 'bg-red-50 text-red-800 border-red-200',             Icon: ShieldAlert },
  suspended: { label: 'Suspended',       cls: 'bg-red-50 text-red-800 border-red-200',             Icon: ShieldAlert },
  cancelled: { label: 'Cancelled',       cls: 'bg-slate-50 text-slate-700 border-slate-200',       Icon: Ban },
};

const INVOICE_TONE: Record<InvoiceView['status'], string> = {
  draft: 'bg-slate-50 text-slate-700 border-slate-200',
  open: 'bg-amber-50 text-amber-900 border-amber-200',
  paid: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  void: 'bg-slate-50 text-slate-500 border-slate-200',
  uncollectible: 'bg-red-50 text-red-800 border-red-200',
};

const day = (v: string | null): string => (v ? new Date(v).toLocaleDateString() : '—');
const show = (v: number | null): string => (v === null ? 'Unlimited' : v === 0 ? '—' : v.toLocaleString());

/** Limits a buyer actually asks about, in the order they ask. */
const HEADLINE: { key: string; label: string }[] = [
  { key: 'maxEmployees', label: 'Employees' },
  { key: 'maxUsers', label: 'User accounts' },
  { key: 'maxActiveCycles', label: 'Active cycles' },
  { key: 'maxCampuses', label: 'Campuses' },
];

export function SubscriptionPage(): JSX.Element {
  const { has } = usePermissions();
  const { entitlements } = useEntitlements();
  const { success, error: toastError } = useToast();
  const [view, setView] = useState<BillingSummary | null>(null);
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<CheckoutResponse | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');

  const canManage = has('configuration.manage');

  function load(): void {
    billingApi
      .summary()
      .then((v) => {
        setView(v);
        setInterval(v.billingInterval);
      })
      .catch(() => toastError('Could not load subscription information.'));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  async function choose(plan: PlanOffer): Promise<void> {
    setBusy(plan.code);
    try {
      const r = await billingApi.checkout(plan.code, interval);
      if (r.free) {
        success(`Your organisation is now on ${plan.label}.`);
        // The menu is built from the plan, so it has to be re-read or locked entries
        // would linger until the next full page load.
        refreshEntitlements();
      } else {
        // NOT a success toast: nothing has been bought yet. An invoice exists.
        setResult(r);
      }
      load();
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : 'Could not change the plan.');
    } finally {
      setBusy(null);
    }
  }

  async function cancel(): Promise<void> {
    setBusy('cancel');
    try {
      const r = await billingApi.cancel(reason.trim() || undefined);
      success(r.endsAt ? `Your subscription will end on ${day(r.endsAt)}.` : 'Your subscription will not renew.');
      setCancelling(false);
      setReason('');
      load();
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : 'Could not cancel the subscription.');
    } finally {
      setBusy(null);
    }
  }

  async function reactivate(): Promise<void> {
    setBusy('reactivate');
    try {
      await billingApi.reactivate();
      success('Your subscription will renew as normal.');
      load();
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : 'Could not reactivate the subscription.');
    } finally {
      setBusy(null);
    }
  }

  if (!view) return <Skeleton className="h-96 w-full" />;

  const tone = TONE[view.subscriptionStatus ?? ''] ?? TONE.active;
  const openInvoice = view.invoices.find((i) => i.status === 'open') ?? null;

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Subscription</h1>
        <p className="text-sm text-muted-foreground">Your plan, what it includes, and your invoices.</p>
      </div>

      {/* An installation running on an installed licence has no subscription to manage,
          and saying so is better than showing plan buttons that would do nothing. */}
      {view.source === 'license' ? (
        <Card className="border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
          This installation runs on an installed licence rather than a subscription. Plan changes are handled by your
          supplier through the licence file, and nothing on this page will alter it.
        </Card>
      ) : null}

      {/* ------------------------------------------------------------ current */}
      <Card className="grid gap-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold">{view.planLabel ?? '—'}</h2>
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${tone.cls}`}>
                <tone.Icon className="size-3.5" />
                {tone.label}
              </span>
              {view.cancelAtPeriodEnd ? <Badge variant="outline">Ends at period</Badge> : null}
            </div>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{view.message}</p>
          </div>
          <div className="flex gap-2">
            {view.cancelAtPeriodEnd ? (
              <Button variant="outline" onClick={reactivate} disabled={!canManage || busy !== null}>
                <RotateCcw className="mr-1.5 size-4" />
                Keep my subscription
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setCancelling(true)} disabled={!canManage || busy !== null}>
                Cancel subscription
              </Button>
            )}
          </div>
        </div>

        <div className="grid gap-4 border-t border-border pt-4 text-sm sm:grid-cols-4">
          <Field label="Billed">{view.billingInterval === 'year' ? 'Yearly' : 'Monthly'}</Field>
          <Field label={view.subscriptionStatus === 'trialing' ? 'Trial ends' : 'Current period ends'}>
            {day(view.subscriptionStatus === 'trialing' ? view.trialEndsAt : view.currentPeriodEnd)}
          </Field>
          <Field label="Grace period">{view.graceDays === null ? '—' : `${view.graceDays} days`}</Field>
          <Field label="Currency">{view.currency}</Field>
        </div>

        {/* An open invoice is the single most actionable thing on this page, so it sits
            with the plan rather than only in the table below. */}
        {openInvoice ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <span>
              <strong>{openInvoice.number}</strong> for {openInvoice.totalFormatted} is awaiting payment
              {openInvoice.dueAt ? ` — due ${day(openInvoice.dueAt)}` : ''}. Quote the invoice number as the payment
              reference. Your plan changes once the payment is recorded.
            </span>
          </div>
        ) : null}
      </Card>

      {/* -------------------------------------------------------------- usage */}
      {view.usage.length > 0 ? (
        <Card className="grid gap-3 p-5">
          <h2 className="font-bold">What you are using</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {view.usage.map((u) => (
              <div key={u.key} className="grid gap-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-muted-foreground">{u.label}</span>
                  <span className={`font-semibold ${u.exceeded ? 'text-red-700' : u.warning ? 'text-amber-700' : ''}`}>
                    {u.used.toLocaleString()}
                    <span className="font-normal text-muted-foreground"> / {show(u.limit)}</span>
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full ${u.exceeded ? 'bg-red-500' : u.warning ? 'bg-amber-500' : 'bg-brand'}`}
                    style={{ width: `${Math.min(100, u.percent ?? 0)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {/* --------------------------------------------------------------- plans */}
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-bold">Plans</h2>
        <div className="inline-flex rounded-md border border-border p-0.5 text-sm">
          {(['month', 'year'] as const).map((i) => (
            <button
              key={i}
              type="button"
              onClick={() => setInterval(i)}
              className={`rounded px-3 py-1 font-medium ${interval === i ? 'bg-brand text-white' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {i === 'month' ? 'Monthly' : 'Yearly'}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {view.catalogue.map((p) => {
          const price = p.prices.find((x) => x.interval === interval);
          const current = p.code === view.plan;
          return (
            <Card key={p.code} className={`grid content-start gap-3 p-5 ${current ? 'border-brand ring-1 ring-brand/40' : ''}`}>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-lg font-bold">{p.label}</h3>
                {current ? <Badge variant="brand">Current plan</Badge> : null}
              </div>
              <p className="text-2xl font-extrabold tracking-tight">
                {price?.free ? 'Free' : price?.formatted}
                {price?.free ? null : (
                  <span className="text-sm font-normal text-muted-foreground">/{interval === 'year' ? 'year' : 'month'}</span>
                )}
              </p>
              <p className="text-sm text-muted-foreground">{p.blurb}</p>
              <ul className="mt-1 grid gap-1 text-sm">
                {HEADLINE.map(({ key, label }) => (
                  <li key={key} className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="font-medium">{show((p.limits as unknown as Record<string, number | null>)[key])}</span>
                  </li>
                ))}
              </ul>
              <Button
                className="mt-2"
                // A cheaper plan is a downgrade, not an offer: it gets the quiet button.
                variant={current || price?.free ? 'outline' : 'default'}
                disabled={!canManage || current || busy !== null || view.source === 'license'}
                onClick={() => choose(p)}
              >
                {current ? 'Your plan' : price?.free ? 'Switch to free' : busy === p.code ? 'Working…' : 'Choose this plan'}
                {!current && !price?.free ? <ArrowUpRight className="ml-1.5 size-4" /> : null}
              </Button>
            </Card>
          );
        })}
      </div>

      {/* What is in each plan. Built from the server's catalogue, so the table can never
          disagree with what the guards actually enforce. */}
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="p-3">Included</th>
              {view.catalogue.map((p) => (
                <th key={p.code} className="p-3 text-center">{p.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...new Set(view.catalogue.flatMap((p) => p.modules))].sort().map((module) => (
              <tr key={module} className="border-t border-border">
                {/* The server's own label for the module, so this table reads the same
                    way as the menu and never invents a name of its own. */}
                <td className="p-3">{moduleLabel(entitlements?.catalogue, module)}</td>
                {view.catalogue.map((p) => (
                  <td key={p.code} className="p-3 text-center">
                    {p.modules.includes(module) ? (
                      <Check className="inline size-4 text-emerald-600" />
                    ) : (
                      <Minus className="inline size-4 text-muted-foreground/40" />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* ------------------------------------------------------------ history */}
      <Card className="grid gap-3 p-5">
        <h2 className="font-bold">Invoices</h2>
        {view.invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No invoices yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3">Invoice</th>
                  <th className="py-2 pr-3">Plan</th>
                  <th className="py-2 pr-3">Issued</th>
                  <th className="py-2 pr-3">Due</th>
                  <th className="py-2 pr-3 text-right">Amount</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {view.invoices.map((i) => (
                  <tr key={i.id} className="border-t border-border">
                    <td className="py-2 pr-3 font-medium">{i.number}</td>
                    <td className="py-2 pr-3 capitalize text-muted-foreground">{i.planCode} / {i.interval}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{day(i.issuedAt)}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{day(i.dueAt)}</td>
                    <td className="py-2 pr-3 text-right font-medium">{i.totalFormatted}</td>
                    <td className="py-2">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold capitalize ${INVOICE_TONE[i.status]}`}>
                        {i.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {view.payments.length > 0 ? (
        <Card className="grid gap-3 p-5">
          <h2 className="font-bold">Payments</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3">Date</th>
                  <th className="py-2 pr-3">Invoice</th>
                  <th className="py-2 pr-3">Method</th>
                  <th className="py-2 pr-3">Reference</th>
                  <th className="py-2 pr-3 text-right">Amount</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {view.payments.map((p) => (
                  <tr key={p.id} className="border-t border-border">
                    <td className="py-2 pr-3 text-muted-foreground">{day(p.paidAt ?? p.createdAt)}</td>
                    <td className="py-2 pr-3">{p.invoiceNumber ?? '—'}</td>
                    <td className="py-2 pr-3 capitalize text-muted-foreground">{p.method.replace(/_/g, ' ')}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{p.reference ?? '—'}</td>
                    <td className="py-2 pr-3 text-right font-medium">{p.amountFormatted}</td>
                    <td className="py-2 capitalize">
                      {p.status === 'failed' ? (
                        <span className="text-red-700" title={p.failureReason ?? undefined}>failed</span>
                      ) : (
                        p.status
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {/* ----------------------------------------------- how to pay (dialog) */}
      <Dialog open={result !== null} onOpenChange={(o) => !o && setResult(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Landmark className="size-5" />
              Invoice {result?.invoiceNumber}
            </DialogTitle>
            <DialogDescription>
              Your plan changes once this payment is recorded — not when you close this window.
            </DialogDescription>
          </DialogHeader>
          {result?.url ? (
            <p className="text-sm">
              <a href={result.url} target="_blank" rel="noreferrer" className="font-semibold text-brand hover:underline">
                Continue to the payment page →
              </a>
            </p>
          ) : (
            <>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs leading-relaxed">
                {result?.instructions}
              </pre>
              <Button
                variant="outline"
                size="sm"
                className="justify-self-start"
                onClick={() => {
                  void navigator.clipboard?.writeText(result?.instructions ?? '');
                  success('Payment details copied.');
                }}
              >
                <Copy className="mr-1.5 size-4" />
                Copy details
              </Button>
            </>
          )}
          <DialogFooter>
            <Button onClick={() => setResult(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ------------------------------------------------- cancel (dialog) */}
      <Dialog open={cancelling} onOpenChange={(o) => !o && setCancelling(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel your subscription?</DialogTitle>
            <DialogDescription>
              You keep everything you have paid for until {day(view.currentPeriodEnd)}. Nothing you have recorded is
              deleted — after the period ends the account stays open and readable, and you can renew at any time.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            rows={3}
            placeholder="Anything we should know? (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelling(false)}>
              Keep it
            </Button>
            <Button variant="destructive" onClick={cancel} disabled={busy !== null}>
              Cancel at period end
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The catalogue's label for a module code, falling back to a readable form of the code. */
function moduleLabel(catalogue: { module: string; label: string }[] | undefined, code: string): string {
  const hit = catalogue?.find((c) => c.module === code);
  if (hit) return hit.label;
  return code.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-medium">{children}</p>
    </div>
  );
}
