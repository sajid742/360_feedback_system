import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BillingEventIntent, BillingProvider } from '../billing.types';
import { formatMoney } from '../billing.types';

/**
 * Invoice and bank transfer — the provider that actually collects money in Pakistan.
 *
 * There is no hosted page and no card: the customer receives an invoice number and the
 * bank details, pays by transfer or cheque quoting that number, and a platform
 * administrator records the payment. The subscription changes when the money arrives,
 * which is both correct for invoice billing and the reason no proration arithmetic is
 * needed anywhere in this system.
 *
 * IT STILL IMPLEMENTS THE WEBHOOK METHODS. Not because it receives webhooks — it does
 * not — but because the verification scheme below is the one a gateway adapter will
 * reuse, and having it here means the webhook pipeline is exercised by the tests
 * rather than first meeting reality on the day a gateway is switched on. An
 * installation with no `BILLING_WEBHOOK_SECRET` set rejects every webhook, which is
 * the correct posture for a deployment that expects none.
 */
@Injectable()
export class InvoiceBillingProvider implements BillingProvider {
  readonly key = 'invoice';
  readonly sendsWebhooks = false;

  async startCheckout(input: {
    organizationName: string;
    invoiceNumber: string;
    amountMinor: bigint;
    currency: string;
  }): Promise<{ url?: string; instructions?: string; providerInvoiceId?: string }> {
    const bank = {
      name: process.env.BILLING_BANK_NAME ?? '',
      title: process.env.BILLING_BANK_ACCOUNT_TITLE ?? '',
      number: process.env.BILLING_BANK_ACCOUNT_NUMBER ?? '',
      iban: process.env.BILLING_BANK_IBAN ?? '',
      branch: process.env.BILLING_BANK_BRANCH ?? '',
    };
    const amount = formatMoney(input.amountMinor, input.currency);

    // An installation that has not configured its bank details would otherwise render
    // a confident-looking payment instruction with blanks in it. Say what is missing.
    if (!bank.name && !bank.iban && !bank.number) {
      return {
        instructions:
          `Invoice ${input.invoiceNumber} for ${amount} has been issued. ` +
          'Bank details are not configured on this installation — set BILLING_BANK_NAME, ' +
          'BILLING_BANK_ACCOUNT_TITLE and BILLING_BANK_IBAN, or contact your supplier for how to pay.',
      };
    }

    const lines = [
      `Invoice ${input.invoiceNumber} — ${amount}`,
      '',
      'Pay by bank transfer to:',
      bank.title ? `  Account title : ${bank.title}` : '',
      bank.name ? `  Bank          : ${bank.name}` : '',
      bank.branch ? `  Branch        : ${bank.branch}` : '',
      bank.number ? `  Account no.   : ${bank.number}` : '',
      bank.iban ? `  IBAN          : ${bank.iban}` : '',
      '',
      `Quote invoice number ${input.invoiceNumber} as the payment reference — that is how the`,
      'payment is matched to your subscription. Your plan changes once the payment is recorded.',
    ];
    return { instructions: lines.filter((l) => l !== '').join('\n') };
  }

  /**
   * HMAC-SHA256 over the raw body, compared in constant time.
   *
   * This is the scheme every major gateway uses in some form, so it is the sensible
   * default for the adapter a local provider will be written against. Two properties
   * matter and are easy to get wrong:
   *
   *   - the signature is over the BYTES RECEIVED. Parsing and re-serialising JSON
   *     changes key order and whitespace and the signature stops matching, which is
   *     why the controller keeps the raw buffer;
   *   - the comparison is `timingSafeEqual`, not `===`, so a forger cannot learn the
   *     correct prefix a byte at a time from response timing.
   *
   * With no secret configured this returns false for everything. Failing closed is
   * right: an unsigned webhook endpoint is an open door to anyone who guesses the URL.
   */
  verifySignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    const secret = (process.env.BILLING_WEBHOOK_SECRET ?? '').trim();
    if (!secret) return false;

    const header = headers['x-billing-signature'] ?? headers['x-signature'] ?? headers['x-webhook-signature'];
    const presented = (Array.isArray(header) ? header[0] : header)?.trim();
    if (!presented) return false;

    // Accept a bare hex digest or a `sha256=<hex>` form; providers differ and both are
    // unambiguous.
    const value = presented.startsWith('sha256=') ? presented.slice(7) : presented;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');

    // timingSafeEqual throws on a length mismatch, which would itself leak the length.
    if (value.length !== expected.length) return false;
    try {
      return timingSafeEqual(Buffer.from(value, 'utf8'), Buffer.from(expected, 'utf8'));
    } catch {
      return false;
    }
  }

  /**
   * Narrow a verified event.
   *
   * The vocabulary is deliberately small and provider-neutral. A real gateway adapter
   * maps its own event names onto the same four actions; nothing above this layer ever
   * learns what a particular provider calls things.
   */
  translate(payload: unknown): BillingEventIntent {
    // `payload` is whatever an unauthenticated caller sent. `null`, a bare string and a
    // number are all valid JSON, so this cannot assume an object: reading `.type` off
    // null throws, and a throw here would escape before the delivery is logged.
    const body: Record<string, unknown> =
      payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};

    // Every string is bounded. These land in VARCHAR columns, and an over-long value
    // would fail the insert — again before the delivery could be recorded.
    const str = (v: unknown, max = 160): string | undefined =>
      typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;
    const num = (v: unknown): bigint | undefined => {
      // Negative and non-integer amounts are dropped rather than passed on: a negative
      // "payment" would reduce the amount collected against an invoice.
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return BigInt(Math.round(v));
      if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
      return undefined;
    };

    const type = str(body.type, 120) ?? str(body.event, 120) ?? 'unknown';
    const raw = body.data;
    const data: Record<string, unknown> =
      raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : body;
    const eventId = str(body.id) ?? str(body.event_id) ?? '';

    const base = {
      eventId,
      type,
      invoiceRef: str(data.invoice_number) ?? str(data.invoice_id) ?? str(data.reference),
      providerPaymentId: str(data.payment_id) ?? str(data.transaction_id) ?? str(data.id),
      amountMinor: num(data.amount_minor) ?? num(data.amount),
      currency: str(data.currency),
      organizationId: str(data.organization_id),
    };

    if (/payment.*(succeed|success|complete|captur|paid)/i.test(type)) {
      return { ...base, action: 'payment_succeeded' };
    }
    if (/payment.*(fail|declin|error)/i.test(type)) {
      return { ...base, action: 'payment_failed', failureReason: str(data.failure_reason) ?? str(data.message) };
    }
    if (/subscription.*(cancel|delet)/i.test(type)) {
      return { ...base, action: 'subscription_cancelled' };
    }
    // Anything else is recorded and ignored. An unrecognised event is not an error —
    // providers add event types, and refusing them would make the endpoint fail on a
    // change we do not care about.
    return { ...base, action: 'ignore' };
  }
}
