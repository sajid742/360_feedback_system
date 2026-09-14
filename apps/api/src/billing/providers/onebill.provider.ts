import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BillingEventIntent, BillingProvider, ProviderBillStatus } from '../billing.types';
import { formatMoney } from '../billing.types';

/**
 * 1BILL (1LINK) — through a billing partner.
 *
 * WHAT 1BILL IS, BECAUSE IT IS NOT A CHECKOUT GATEWAY. 1LINK runs Pakistan's central
 * bill-presentment hub. Every biller has a **1BILL prefix**; a customer's full 1BILL ID
 * is that prefix followed by a consumer number. The customer types that ID into ANY
 * bank's mobile app, internet banking, ATM or branch counter — the prefix is what routes
 * it, which is why there is no biller dropdown to find and no card to enter. The money
 * arrives by bank settlement and we are told about it afterwards.
 *
 * So there is no hosted page to redirect to and nothing for the customer to "complete"
 * in a browser. `startCheckout` REGISTERS a bill and hands back an ID to quote; the
 * subscription changes when the payment is reported, exactly as it does for a manual
 * bank transfer.
 *
 * DIRECT VERSUS INDIRECT, AND WHY THIS ADAPTER IS THE INDIRECT ONE. A **direct** biller
 * holds its own prefix and a host-to-host link with 1LINK, and must EXPOSE endpoints
 * that 1LINK calls — a Bill Inquiry answering "what does consumer 4471-20260007 owe?"
 * and a Bill Payment advice — on 1LINK's own message schema, with a sponsor bank, fixed
 * connectivity and daily settlement files. An **indirect** biller sits under a billing
 * partner's prefix; the partner holds the bill data we push to it, answers 1LINK's
 * inquiries on our behalf, and calls us back when a bill is paid. That is an ordinary
 * outbound REST call plus a signed callback, which is the shape this port was built for.
 *
 * ┌──────────┐  create bill   ┌─────────┐   bill data    ┌───────┐   any bank app,
 * │   this   │ ─────────────► │ billing │ ─────────────► │ 1LINK │ ◄── ATM, branch,
 * │   app    │ ◄───────────── │ partner │ ◄───────────── │  hub  │     internet banking
 * └──────────┘  paid callback └─────────┘  payment advice└───────┘
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * THE FIELD NAMES BELOW ARE NOT CONFIRMED AGAINST A PARTNER SPEC.
 *
 * 1LINK's BPS message schema and each partner's wrapper around it are distributed under
 * their onboarding pack, not published. Everything partner-specific in this file is
 * therefore confined to the three marked blocks — REQUEST SHAPE, CALLBACK SHAPE and
 * STATUS SHAPE — and nothing outside them depends on a field name. Correct those three
 * against the partner's document before go-live; nothing else in the application has to
 * change, and the tests will still pass because they drive the simulator through the
 * same three blocks.
 * ════════════════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class OneBillProvider implements BillingProvider {
  readonly key = '1bill';
  readonly sendsWebhooks = true;

  private readonly log = new Logger(OneBillProvider.name);

  /* ------------------------------------------------------------- config */

  private cfg(): {
    baseUrl: string;
    apiKey: string;
    clientId: string;
    prefix: string;
    timeoutMs: number;
    simulate: boolean;
  } {
    return {
      baseUrl: sanitiseBaseUrl(process.env.ONEBILL_BASE_URL ?? ''),
      apiKey: (process.env.ONEBILL_API_KEY ?? '').trim(),
      clientId: (process.env.ONEBILL_CLIENT_ID ?? '').trim(),
      // The partner's 1BILL prefix. Displayed, never sent — the partner knows its own.
      prefix: (process.env.ONEBILL_PREFIX ?? '').trim(),
      timeoutMs: this.positiveInt(process.env.ONEBILL_TIMEOUT_MS, 15_000, 60_000),
      // Set on a machine with no partner to call. The flow still works end to end
      // against a locally derived consumer number, which is what makes it testable.
      simulate: /^(1|true|yes)$/i.test((process.env.ONEBILL_SIMULATE ?? '').trim()),
    };
  }

  private positiveInt(raw: string | undefined, fallback: number, max: number): number {
    const n = Number(raw ?? '');
    return Number.isFinite(n) && n > 0 && n <= max ? Math.floor(n) : fallback;
  }

  /**
   * The consumer number for one of our invoices.
   *
   * Derived from the invoice number rather than random, so it is reproducible from the
   * invoice alone — which matters when someone is reconciling a bank statement by hand
   * months later. `INV-2026-0007` becomes `20260007`: numeric, because ATM keypads and
   * OTC tellers cannot type letters, and unique because the sequence is unique per year.
   *
   * The partner's own assignment always wins when it returns one; this is the fallback
   * and the simulator's answer.
   */
  private consumerNumberFor(invoiceNumber: string): string {
    const digits = invoiceNumber.replace(/\D+/g, '');
    if (digits.length > 0) return digits;
    // An invoice number with no digits in it cannot happen today, but if the format ever
    // changes this must stay DERIVED rather than random: a clock-based fallback would
    // give a different answer on every call, so the number quoted to the customer and
    // the number reconciliation later asks about would never match again.
    return String(
      [...invoiceNumber].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1_000_000_000, 7),
    ).padStart(9, '0');
  }

  /** What the customer actually types. Prefix is presentation; the partner routes it. */
  private displayId(consumerNumber: string): string {
    const { prefix } = this.cfg();
    return prefix ? `${prefix}${consumerNumber}` : consumerNumber;
  }

  /* ----------------------------------------------------------- checkout */

  async startCheckout(input: {
    organizationId: string;
    organizationName: string;
    planCode: string;
    interval: string;
    invoiceId: string;
    invoiceNumber: string;
    amountMinor: bigint;
    currency: string;
    dueAt?: Date;
  }): Promise<{ url?: string; instructions?: string; providerInvoiceId?: string }> {
    const cfg = this.cfg();
    const fallbackConsumer = this.consumerNumberFor(input.invoiceNumber);

    // Nothing to call: either deliberately simulated, or not configured yet. The bill is
    // still presented with a derived number so the flow is complete and testable, and
    // the instructions say plainly that it has not been registered — an ID that no bank
    // will recognise must never be handed over as though it were live.
    if (cfg.simulate || !cfg.baseUrl) {
      const registered = cfg.simulate;
      this.log.warn(
        cfg.simulate
          ? `ONEBILL_SIMULATE is on — bill for ${input.invoiceNumber} was not sent to a partner.`
          : `ONEBILL_BASE_URL is not set — bill for ${input.invoiceNumber} was not registered.`,
      );
      return {
        providerInvoiceId: fallbackConsumer,
        instructions: this.instructions(fallbackConsumer, input, registered ? 'simulated' : 'unconfigured'),
      };
    }

    /* ══════════════ REQUEST SHAPE — confirm against the partner's spec ══════════════
     * A partner's create-bill call takes, in some spelling: who the bill is for, how
     * much, in what currency, when it is due, and our own reference. The names differ
     * between partners; the CONTENT does not.
     */
    const body = {
      consumer_number: fallbackConsumer,
      consumer_name: input.organizationName,
      // Minor units. If a partner wants major units, divide HERE and nowhere else —
      // everything above this line is integer paisa by design.
      amount: Number(input.amountMinor),
      currency: input.currency,
      due_date: (input.dueAt ?? new Date(Date.now() + 14 * 86_400_000)).toISOString().slice(0, 10),
      bill_reference: input.invoiceNumber,
      description: `${input.planCode} subscription (${input.interval})`,
      client_id: cfg.clientId || undefined,
    };

    try {
      const res = await this.post<{
        consumer_number?: string;
        bill_number?: string;
        onebill_id?: string;
        status?: string;
        message?: string;
      }>(`${cfg.baseUrl}/bills`, body, cfg);

      const consumer = res.consumer_number ?? res.bill_number ?? res.onebill_id ?? fallbackConsumer;
      /* ════════════════════════ end REQUEST SHAPE ════════════════════════ */

      this.log.log(`1BILL bill registered for ${input.invoiceNumber} as ${this.displayId(consumer)}.`);
      return { providerInvoiceId: consumer, instructions: this.instructions(consumer, input, 'registered') };
    } catch (err) {
      // A partner outage must not lose the invoice or fail the customer's request. The
      // invoice already exists and is payable by other means; the instructions say what
      // happened, and reconciliation will pick the bill up once it is registered.
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`1BILL registration failed for ${input.invoiceNumber}: ${message}`);
      return { instructions: this.instructions(fallbackConsumer, input, 'failed') };
    }
  }

  /** What the customer is shown. The ID and the channels are the whole message. */
  private instructions(
    consumerNumber: string,
    input: { invoiceNumber: string; amountMinor: bigint; currency: string },
    state: 'registered' | 'simulated' | 'unconfigured' | 'failed',
  ): string {
    const amount = formatMoney(input.amountMinor, input.currency);
    const id = this.displayId(consumerNumber);

    if (state === 'unconfigured' || state === 'failed') {
      return [
        `Invoice ${input.invoiceNumber} — ${amount}`,
        '',
        state === 'failed'
          ? 'This invoice could not be registered with our payment partner just now, so the'
          : '1BILL is not configured on this installation, so the',
        'ID below is not yet live at the banks. The invoice itself stands and is payable —',
        'please contact your supplier for how to pay it, quoting the invoice number.',
      ].join('\n');
    }

    return [
      `Invoice ${input.invoiceNumber} — ${amount}`,
      '',
      `1BILL ID: ${id}`,
      '',
      'Pay this from any Pakistani bank account, at no extra step for you:',
      '  • your bank\'s mobile app or internet banking — choose Bill Payment, then 1BILL,',
      '    and enter the ID above',
      '  • any ATM — Bill Payment, then 1BILL',
      '  • any bank branch counter, or an agent such as Easypaisa or JazzCash',
      '',
      'The amount is already attached to the ID, so there is nothing else to type. Your',
      'plan changes once the payment reaches us — usually within a few minutes of paying,',
      'and by the next working day at the latest.',
      state === 'simulated'
        ? '\n(Simulation mode: this ID is generated locally and is not live at any bank.)'
        : '',
    ]
      .filter((l) => l !== '')
      .join('\n');
  }

  /* ----------------------------------------------------------- callback */

  /**
   * Verify a partner callback.
   *
   * Same scheme as the invoice adapter and for the same reasons — HMAC-SHA256 over the
   * RAW bytes, compared in constant time — but keyed on its OWN secret. Sharing one
   * secret across providers would mean rotating it for one forced an outage on the
   * other, and a partner compromise would hand over the keys to everything.
   *
   * Fails closed: no secret configured, nothing is accepted.
   */
  verifySignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    const secret = (process.env.ONEBILL_WEBHOOK_SECRET ?? '').trim();
    if (!secret) return false;

    const header =
      headers['x-onebill-signature'] ?? headers['x-1bill-signature'] ?? headers['x-signature'] ?? headers['signature'];
    const presented = (Array.isArray(header) ? header[0] : header)?.trim();
    if (!presented) return false;

    const value = presented.startsWith('sha256=') ? presented.slice(7) : presented;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    if (value.length !== expected.length) return false;
    try {
      return timingSafeEqual(Buffer.from(value, 'utf8'), Buffer.from(expected, 'utf8'));
    } catch {
      return false;
    }
  }

  /**
   * Narrow a verified callback.
   *
   * `payload` is whatever an unauthenticated caller sent, so this cannot assume an
   * object: `null`, a bare string and a number are all valid JSON, and throwing here
   * would escape before the delivery could be logged.
   */
  translate(payload: unknown): BillingEventIntent {
    const body: Record<string, unknown> =
      payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};

    const str = (v: unknown, max = 160): string | undefined =>
      typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;
    const num = (v: unknown): bigint | undefined => {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return BigInt(Math.round(v));
      if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
      return undefined;
    };

    const raw = body.data ?? body.transaction ?? body;
    const data: Record<string, unknown> =
      raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : body;

    /* ══════════════ CALLBACK SHAPE — confirm against the partner's spec ══════════════
     * A paid-bill callback carries, in some spelling: which bill, which transaction,
     * how much, and that it succeeded. 1LINK settles through the banks, so a "failed"
     * callback is rare — a payment that fails at the bank simply never reaches us — but
     * reversals and voids do happen and are mapped onto the failure action.
     */
    const base = {
      eventId: str(body.event_id) ?? str(body.id) ?? str(data.stan) ?? '',
      type: str(body.event, 120) ?? str(body.type, 120) ?? str(data.status, 120) ?? 'unknown',
      // Our own invoice number if the partner echoes it, else the consumer number —
      // both resolve, because the consumer number is stored as `providerInvoiceId`.
      invoiceRef: str(data.bill_reference) ?? str(data.consumer_number) ?? str(data.bill_number),
      // The bank's transaction identifier. This is the idempotency key for the payment.
      providerPaymentId: str(data.transaction_id) ?? str(data.stan) ?? str(data.auth_id) ?? str(body.id),
      amountMinor: num(data.amount_minor) ?? num(data.amount) ?? num(data.transaction_amount),
      currency: str(data.currency, 3),
      organizationId: undefined as string | undefined,
    };
    const outcome = classify(base.type, data.response_code);
    /* ════════════════════════ end CALLBACK SHAPE ════════════════════════ */

    if (outcome === 'paid') return { ...base, action: 'payment_succeeded' };
    if (outcome === 'failed') {
      return {
        ...base,
        action: 'payment_failed',
        failureReason: str(data.response_message) ?? str(data.message) ?? 'Reported by the payment partner.',
      };
    }
    return { ...base, action: 'ignore' };
  }

  /* ------------------------------------------------------ reconciliation */

  /**
   * Ask the partner what became of a bill.
   *
   * `unknown` on any doubt — an unreachable partner, a shape we do not recognise. An
   * unreachable partner must never be read as "unpaid", because the caller would then
   * leave a paid customer suspended on the strength of a network error.
   */
  async fetchStatus(ref: { invoiceNumber: string; providerInvoiceId: string | null }): Promise<ProviderBillStatus> {
    const cfg = this.cfg();
    if (cfg.simulate || !cfg.baseUrl) return { state: 'unknown', detail: 'No partner configured.' };

    const id = ref.providerInvoiceId ?? this.consumerNumberFor(ref.invoiceNumber);
    try {
      /* ═══════════════ STATUS SHAPE — confirm against the partner's spec ═══════════════ */
      const res = await this.get<{
        status?: string;
        paid?: boolean;
        amount?: number | string;
        amount_minor?: number | string;
        currency?: string;
        transaction_id?: string;
        paid_at?: string;
      }>(`${cfg.baseUrl}/bills/${encodeURIComponent(id)}`, cfg);

      // `res.paid === true` is an explicit yes. Everything else goes through the SAME
      // token classifier the callback uses — substring matching here read "UNPAID" as
      // paid, because "unpaid" contains "paid", and would have settled every open bill
      // on the platform for free.
      const outcome = classify(res.status ?? '', undefined);
      const paid = res.paid === true || (res.paid !== false && outcome === 'paid');
      const cancelled = outcome === 'cancelled';
      const amount = res.amount_minor ?? res.amount;
      const paidAt = res.paid_at ? new Date(res.paid_at) : undefined;
      /* ════════════════════════ end STATUS SHAPE ════════════════════════ */

      if (paid) {
        return {
          state: 'paid',
          amountMinor: amount === undefined ? undefined : BigInt(Math.round(Number(amount))),
          currency: res.currency,
          providerPaymentId: res.transaction_id,
          paidAt: paidAt && !Number.isNaN(paidAt.getTime()) ? paidAt : undefined,
        };
      }
      if (cancelled) return { state: 'cancelled' };
      return { state: 'open' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`1BILL status inquiry failed for ${ref.invoiceNumber}: ${message}`);
      return { state: 'unknown', detail: message };
    }
  }

  /* ---------------------------------------------------------- transport */

  private headers(cfg: { apiKey: string; clientId: string }): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    // Credentials come from the environment and are never logged. The two common
    // spellings are sent together so a partner using either is satisfied.
    if (cfg.apiKey) {
      h.Authorization = `Bearer ${cfg.apiKey}`;
      h['X-API-Key'] = cfg.apiKey;
    }
    if (cfg.clientId) h['X-Client-Id'] = cfg.clientId;
    return h;
  }

  private async post<T>(url: string, body: unknown, cfg: ReturnType<OneBillProvider['cfg']>): Promise<T> {
    return this.send<T>(url, { method: 'POST', body: JSON.stringify(body) }, cfg);
  }

  private async get<T>(url: string, cfg: ReturnType<OneBillProvider['cfg']>): Promise<T> {
    return this.send<T>(url, { method: 'GET' }, cfg);
  }

  /**
   * One HTTP call, with a hard timeout.
   *
   * The timeout is the point. This runs inside a customer's checkout request, and a
   * partner that accepts the connection and then never answers would otherwise hold the
   * request open until something upstream gives up — the customer sees a spinner, gives
   * up, presses the button again, and now there are two bills.
   */
  private async send<T>(url: string, init: RequestInit, cfg: ReturnType<OneBillProvider['cfg']>): Promise<T> {
    // CREDENTIALS DO NOT FOLLOW REDIRECTS. `fetch` follows them by default, and while
    // undici strips `Authorization` across origins it does NOT strip a custom header —
    // so `X-API-Key` would ride a 302 to wherever it pointed. A partner that needs a
    // redirect can be given the final URL instead.
    const res = await fetch(url, {
      ...init,
      headers: this.headers(cfg),
      redirect: 'manual',
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });

    if (res.status >= 300 && res.status < 400) {
      throw new Error(`Partner redirected (${res.status}). Set ONEBILL_BASE_URL to the final address.`);
    }

    // A response body is read into memory, so it is bounded BEFORE it is read: a partner
    // — or anything that has taken over the address — answering with a multi-hundred-
    // megabyte body would otherwise take the process down mid-sweep.
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw new Error(`Partner response too large (${declared} bytes).`);
    }
    const text = (await res.text()).slice(0, MAX_RESPONSE_BYTES);

    if (!res.ok) {
      // The STATUS AND NOTHING ELSE. A partner's error body routinely echoes what was
      // sent — including the credential it just rejected — and this message reaches the
      // application log and the platform billing screen.
      throw new Error(`Partner answered ${res.status} ${res.statusText}.`);
    }
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      throw new Error('Partner response was not valid JSON.');
    }
  }
}

/** A partner response is read into memory, so it is bounded before it is read. */
const MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * Refuse a base URL that would send credentials in clear.
 *
 * `http://` to anything but a loopback address puts the API key on the wire in plain
 * text. Returning empty makes the adapter behave as unconfigured — bills are still
 * issued and the customer is told they are not registered — which is a far better
 * outcome than leaking the credential on every checkout.
 */
function sanitiseBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return trimmed;
    new Logger(OneBillProvider.name).error(
      `ONEBILL_BASE_URL is ${url.protocol}// — credentials would be sent in clear. Ignoring it; use https.`,
    );
    return '';
  } catch {
    new Logger(OneBillProvider.name).error('ONEBILL_BASE_URL is not a valid URL. Ignoring it.');
    return '';
  }
}

/**
 * Decide what a provider's status or event name means — BY TOKEN, never by substring.
 *
 * Substring matching is how "UNPAID" came to mean paid, because "unpaid" contains
 * "paid"; the same trap turns "settlement_failed", "refund.completed" and
 * "reversal.completed" into successful payments. Both mistakes invent money.
 *
 * So the string is split into words and NEGATIVES ARE CHECKED FIRST. The bias is
 * deliberate: failing to recognise a payment costs the customer an hour until the
 * reconciliation sweep catches it, while wrongly recognising one gives the service away
 * and books revenue that never arrived.
 */
export function classify(raw: string, responseCode?: unknown): 'paid' | 'failed' | 'cancelled' | 'unknown' {
  const words = new Set(
    String(raw ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  const has = (...any: string[]): boolean => any.some((w) => words.has(w));

  // 1. Anything that is not a completed collection, checked before anything positive.
  // `not` and `no` are in here because tokenising splits "NOT PAID" into two words, and
  // the second one would otherwise be read as a yes. No positive status carries either.
  if (has('unpaid', 'notpaid', 'not', 'no', 'partial', 'partially', 'pending', 'awaiting', 'due', 'outstanding')) {
    return 'unknown';
  }
  if (has('reversed', 'reversal', 'refund', 'refunded', 'chargeback', 'failed', 'failure', 'fail', 'declined', 'error')) {
    return 'failed';
  }
  if (has('cancelled', 'canceled', 'void', 'voided', 'expired')) return 'cancelled';

  // 2. An explicit, unambiguous yes.
  if (has('paid', 'success', 'successful', 'completed', 'complete', 'settled', 'captured', 'credited')) return 'paid';

  // 3. A success response code CORROBORATES a payment message; it never stands alone.
  //    "00" in BPS means "message processed", not "money received", so on its own it
  //    proves nothing. Numbers and strings are both accepted — JSON spells it either way.
  const code = typeof responseCode === 'number' ? String(responseCode) : typeof responseCode === 'string' ? responseCode : '';
  if (code !== '' && /^0+$/.test(code.trim()) && has('payment', 'bill', 'transaction', 'txn')) return 'paid';

  return 'unknown';
}
