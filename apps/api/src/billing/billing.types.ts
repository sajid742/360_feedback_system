/**
 * The billing port.
 *
 * WHY A PORT AND NOT A STRIPE CLIENT. Stripe does not operate in Pakistan — it
 * supports 46 countries and Pakistan is not one of them — so a Pakistan-registered
 * vendor cannot open an account at all. What collects money today is an invoice and a
 * bank transfer; what might collect it later is a local gateway (Safepay, PayPro,
 * GoPayFast) or a merchant of record (Paddle) if the product is sold internationally.
 *
 * Everything above this interface — invoices, payments, the event log, idempotency,
 * the lifecycle, the screens — is provider-agnostic. Adding a gateway is one file
 * implementing these four methods plus a secret in the environment.
 */
import type { PlanCode } from '../license/plans';

/** How often the customer is billed. */
export const BILLING_INTERVALS = ['month', 'year'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];
export const isBillingInterval = (v: string): v is BillingInterval =>
  (BILLING_INTERVALS as readonly string[]).includes(v);

/** What an invoice is doing. */
export const INVOICE_STATUSES = ['draft', 'open', 'paid', 'void', 'uncollectible'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PAYMENT_METHODS = ['bank_transfer', 'cheque', 'cash', 'card', 'complimentary'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ['succeeded', 'failed', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * What a checkout produced.
 *
 * A hosted gateway returns a `url` for the browser to visit. Invoice billing returns
 * `instructions` instead — the bank details and the invoice number to quote — because
 * there is no page to send anyone to. The screen renders whichever it gets, so the
 * same button works for both without the front end knowing which provider is live.
 */
export interface CheckoutResult {
  /** null on the free plan — nothing was invoiced, so there is no invoice to point at. */
  invoiceId: string | null;
  invoiceNumber: string | null;
  amountMinor: bigint;
  currency: string;
  /** Hosted-checkout providers only. */
  url?: string;
  /** Invoice billing only — what to tell the customer. */
  instructions?: string;
  /** True when nothing is owed (the free plan), so the caller can skip payment entirely. */
  free: boolean;
}

/**
 * A webhook, once it has been verified and understood.
 *
 * Providers disagree about everything except that an event has an id, a type and a
 * body. The adapter narrows its own vocabulary to this; nothing above the adapter
 * knows what a provider calls its events.
 */
export interface BillingEventIntent {
  /** The provider's id for this event — the idempotency key. */
  eventId: string;
  type: string;
  /** What to actually do. `ignore` is a first-class outcome, not a failure. */
  action: 'payment_succeeded' | 'payment_failed' | 'subscription_cancelled' | 'ignore';
  /** Our invoice number or id, when the event refers to one. */
  invoiceRef?: string;
  /** The provider's payment id, for the idempotent payment insert. */
  providerPaymentId?: string;
  amountMinor?: bigint;
  currency?: string;
  failureReason?: string;
  organizationId?: string;
}

export interface BillingProvider {
  /** Stable key, matching `BILLING_PROVIDER` and the `provider` column. */
  readonly key: string;

  /** Does this provider send webhooks at all? Invoice billing does not. */
  readonly sendsWebhooks: boolean;

  /**
   * Turn an issued invoice into something the customer can act on: a hosted payment
   * page, or instructions to pay it. The invoice already exists and is priced — the
   * provider never decides the amount, which is what stops a browser proposing one.
   */
  startCheckout(input: {
    organizationId: string;
    organizationName: string;
    planCode: PlanCode;
    interval: BillingInterval;
    invoiceId: string;
    invoiceNumber: string;
    amountMinor: bigint;
    currency: string;
    /** When payment is due. Invoice rails print it; hosted pages usually ignore it. */
    dueAt?: Date;
  }): Promise<{ url?: string; instructions?: string; providerInvoiceId?: string }>;

  /**
   * Verify a webhook's signature over the RAW request body.
   *
   * Takes bytes, not a parsed object: every scheme signs the exact bytes sent, and
   * re-serialising JSON changes them. Returns null when the signature does not verify —
   * the caller records the attempt and refuses it rather than throwing.
   */
  verifySignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;

  /**
   * Narrow a verified provider event to something this application acts on.
   *
   * Takes `unknown`, not an object: the body is whatever an unauthenticated caller
   * sent, and `null`, a string and a number are all valid JSON. An adapter that
   * assumed an object here would throw before the delivery could be logged.
   */
  translate(payload: unknown): BillingEventIntent;

  /**
   * Ask the provider what became of a bill we issued. OPTIONAL.
   *
   * WHY THIS EXISTS. On invoice rails the customer pays hours later, at a branch
   * counter or an ATM, and the notification comes back over someone else's network. A
   * callback that is lost — a deploy mid-delivery, a proxy hiccup, an expired
   * certificate — leaves an invoice open for ever and a customer who has genuinely paid
   * locked out of the plan they bought. Polling closes that hole, so the callback is an
   * optimisation for speed rather than the only path to the truth.
   *
   * An adapter with no way to ask simply omits it, and reconciliation skips it.
   */
  fetchStatus?(ref: { invoiceNumber: string; providerInvoiceId: string | null }): Promise<ProviderBillStatus>;
}

/** What a provider says about a bill we issued. */
export interface ProviderBillStatus {
  /** `unknown` when the provider could not be reached — NEVER treated as unpaid. */
  state: 'paid' | 'open' | 'cancelled' | 'unknown';
  amountMinor?: bigint;
  currency?: string;
  /** The provider's payment id, so recording it stays idempotent. */
  providerPaymentId?: string;
  paidAt?: Date;
  detail?: string;
}

/** Minor units → a display string. Kept in one place so no screen invents its own. */
export function formatMoney(amountMinor: bigint | number, currency: string): string {
  const minor = typeof amountMinor === 'bigint' ? amountMinor : BigInt(Math.round(amountMinor));
  const major = Number(minor) / 100;
  return `${currency} ${major.toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

/** Add one billing period to a date, in UTC. */
export function addInterval(from: Date, interval: BillingInterval): Date {
  const d = new Date(from.getTime());
  if (interval === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}
