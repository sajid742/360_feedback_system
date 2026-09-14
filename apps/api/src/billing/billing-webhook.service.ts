import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { BillingService } from './billing.service';
import { BillingProviderRegistry } from './providers/provider.registry';
import type { BillingEventIntent } from './billing.types';

/** What the controller returns. Always a 200 — see the class comment. */
export interface WebhookOutcome {
  received: true;
  status: 'processed' | 'duplicate' | 'ignored' | 'rejected' | 'failed';
  detail?: string;
}

/**
 * Inbound payment webhooks.
 *
 * FOUR PROPERTIES, AND EACH IS LOAD-BEARING.
 *
 * 1. SIGNED. The signature is verified over the RAW bytes before anything is parsed or
 *    stored as meaningful. An unsigned endpoint that changes subscriptions is an open
 *    door to whoever guesses the URL.
 *
 * 2. IDEMPOTENT — BY DATABASE INDEX, NOT BY LOGIC. Every event is inserted into
 *    `billing_events` with a unique key of (provider, providerEventId). A retry hits
 *    the conflict and stops. Application-level "have I seen this?" checks lose races;
 *    a unique index does not.
 *
 * 3. RETRY-SAFE. Once an event is stored we answer 200, even if applying it failed.
 *    Providers retry on a non-2xx, so returning 500 on a bad event produces an endless
 *    redelivery of something that will never succeed. The failure is recorded with its
 *    error and can be replayed deliberately.
 *
 * 4. AUDITABLE. Every delivery is kept — including forged ones, stored with
 *    `signatureValid: false` and never applied. An attack attempt is then visible
 *    rather than silent.
 *
 * THE BROWSER IS NEVER TRUSTED to confirm a payment. A customer returning from a
 * payment page only sees a page; money is recognised here, or by an operator recording
 * a bank transfer, and nowhere else.
 */
@Injectable()
export class BillingWebhookService {
  private readonly log = new Logger(BillingWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly providers: BillingProviderRegistry,
  ) {}

  async handle(
    providerKey: string,
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<WebhookOutcome> {
    // The provider key comes off the URL path, which anyone can write. It is bounded
    // here because it is stored in a VARCHAR(24) and is half of the idempotency key —
    // an over-long value would fail the insert before the delivery could be recorded,
    // which is exactly the case this endpoint must never fail on.
    const provider = (providerKey || 'unknown').slice(0, 24);

    // THE ADAPTER IS CHOSEN BY THE PATH, NOT BY WHAT THIS INSTALLATION IS CONFIGURED
    // TO SEND WITH. Each provider signs with its own secret, so a callback must be
    // verified by the adapter it actually came from. The two differ exactly when it
    // matters most — during a migration, while yesterday's provider is still delivering
    // callbacks for bills it is still collecting.
    const adapter = this.providers.byProviderKey(provider);

    // An unknown key is a misconfiguration or a probe. It is still RECORDED — that is
    // the point of the event log — but nothing is verified or applied, because doing
    // either would mean picking someone else's secret to check it with.
    const valid = adapter ? adapter.verifySignature(rawBody, headers) : false;

    // Whatever arrived. `null`, a bare string and a number are all valid JSON, and an
    // unparseable body is not JSON at all — every one of them is still a DELIVERY, and
    // recording it is the point of this table.
    let payload: unknown = null;
    let parsed = true;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      parsed = false;
    }

    const intent: BillingEventIntent = adapter
      ? adapter.translate(payload)
      : { eventId: '', type: 'unknown.provider', action: 'ignore' };
    // An event with no id of its own cannot be de-duplicated by the provider's key, so
    // one is derived from the body. Two identical bodies are the same event by any
    // useful definition.
    const eventId = (intent.eventId || `sha:${this.digest(rawBody)}`).slice(0, 160);

    // Only an object can be stored as a JSON column value here; anything else is kept
    // as a string so the raw delivery is still inspectable.
    const stored: Prisma.InputJsonValue =
      payload !== null && typeof payload === 'object'
        ? (payload as Prisma.InputJsonValue)
        : { raw: rawBody.toString('utf8').slice(0, 4000), parsed };

    let eventRowId: string;
    try {
      const row = await this.prisma.billingEvent.create({
        data: {
          provider,
          providerEventId: eventId,
          type: intent.type.slice(0, 120),
          signatureValid: valid,
          status: 'received',
          payload: stored,
        },
        select: { id: true },
      });
      eventRowId = row.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Seen before. This is the normal, healthy outcome of a provider retry.
        this.log.log(`Duplicate webhook ${provider}/${eventId} ignored.`);
        return { received: true, status: 'duplicate' };
      }
      // Even a failure to RECORD the delivery must not become a 500: the provider would
      // redeliver it for ever. It is logged loudly instead.
      this.log.error(
        `Could not record webhook ${provider}/${eventId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { received: true, status: 'failed', detail: 'Could not be recorded.' };
    }

    if (!adapter) {
      await this.finish(eventRowId, 'failed', `No adapter for provider "${provider}".`);
      this.log.warn(
        `Webhook for unknown provider "${provider}" recorded and refused ` +
          `(this build has: ${this.providers.known().join(', ')}).`,
      );
      return { received: true, status: 'rejected', detail: 'Unknown provider.' };
    }

    if (!valid) {
      await this.finish(eventRowId, 'failed', 'Signature verification failed.');
      // Deliberately NOT written to audit_logs: a forged webhook belongs to no
      // organisation, and audit_logs is per-tenant by design. The `billing_events` row —
      // kept with `signatureValid: false`, its full payload and its timestamps — is the
      // audit record for this, and the platform billing screen lists it.
      this.log.warn(`Webhook ${provider}/${eventId} REJECTED — signature did not verify.`);
      return { received: true, status: 'rejected', detail: 'Invalid signature.' };
    }

    if (!parsed) {
      await this.finish(eventRowId, 'failed', 'Body was not valid JSON.');
      return { received: true, status: 'failed', detail: 'Body was not valid JSON.' };
    }

    try {
      const applied = await this.apply(intent, eventId, provider);
      await this.finish(eventRowId, applied.handled ? 'processed' : 'ignored', applied.detail, applied.organizationId);
      return { received: true, status: applied.handled ? 'processed' : 'ignored', detail: applied.detail };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.finish(eventRowId, 'failed', message);
      this.log.error(`Webhook ${provider}/${eventId} failed: ${message}`);
      // Still a 200 — see property 3.
      return { received: true, status: 'failed', detail: 'Recorded for review.' };
    }
  }

  /** Turn an intent into a state change. Everything routes through BillingService. */
  private async apply(intent: BillingEventIntent, eventId: string, provider: string): Promise<{
    handled: boolean;
    detail?: string;
    organizationId?: string;
  }> {
    if (intent.action === 'ignore') return { handled: false, detail: `No action for "${intent.type}".` };

    const invoice = intent.invoiceRef ? await this.findInvoice(intent.invoiceRef, provider) : null;
    if (!invoice) {
      return { handled: false, detail: `No invoice matched "${intent.invoiceRef ?? '(none)'}".` };
    }

    if (intent.action === 'payment_succeeded') {
      await this.billing.recordPayment(
        { userId: null, email: `webhook:${intent.type}` },
        null,
        invoice.id,
        {
          amountMinor: intent.amountMinor,
          currency: intent.currency,
          // Every rail this application collects on settles bank-to-bank — a manual
          // transfer, or 1BILL through the banking network. Stamping these as `card` made
          // the same 1BILL payment read as a card payment or a transfer depending only on
          // whether the callback or the reconciliation sweep got there first.
          method: 'bank_transfer',
          provider: invoice.provider,
          // A provider that states no payment id of its own still needs ONE stable key,
          // or a redelivery that slipped past the event log would insert a second
          // payment. It must be the SAME key the reconciliation sweep falls back to —
          // they used to differ, so a provider whose status inquiry carries no
          // transaction id was recorded once by each.
          providerPaymentId: intent.providerPaymentId ?? `bill:${invoice.number}`,
          reference: intent.providerPaymentId ?? eventId,
          notes: `Recorded from webhook ${intent.eventId}`,
        },
      );
      return { handled: true, detail: `Payment applied to ${invoice.number}.`, organizationId: invoice.organizationId };
    }

    if (intent.action === 'payment_failed') {
      await this.billing.recordFailure(invoice.id, {
        provider: invoice.provider,
        providerPaymentId: intent.providerPaymentId,
        amountMinor: intent.amountMinor,
        reason: intent.failureReason,
      });
      return { handled: true, detail: `Failure recorded against ${invoice.number}.`, organizationId: invoice.organizationId };
    }

    // subscription_cancelled — end at the period, never immediately, and never delete.
    const sub = await this.prisma.subscription.findFirst({
      where: { organizationId: invoice.organizationId, deletedAt: null },
    });
    if (sub) {
      await this.prisma.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } });
    }
    return { handled: true, detail: 'Subscription set to end at the period.', organizationId: invoice.organizationId };
  }

  /**
   * Find the invoice a callback is about.
   *
   * Our own invoice number is globally unique and is tried FIRST. A provider reference is
   * only matched within that provider's own invoices: `provider_invoice_id` carries no
   * unique index and its shape is the provider's to choose, so matching it across every
   * provider and every tenant could land one partner's echoed reference on another
   * organisation's invoice. Newest first, so a reused reference resolves to the live bill
   * rather than an archived one.
   */
  private async findInvoice(
    ref: string,
    provider: string,
  ): Promise<{ id: string; number: string; organizationId: string; provider: string } | null> {
    const select = { id: true, number: true, organizationId: true, provider: true };

    const byNumber = await this.prisma.invoice.findFirst({ where: { deletedAt: null, number: ref }, select });
    if (byNumber) return byNumber;

    const byProviderRef = await this.prisma.invoice.findFirst({
      where: { deletedAt: null, provider, providerInvoiceId: ref },
      orderBy: { issuedAt: 'desc' },
      select,
    });
    if (byProviderRef) return byProviderRef;

    if (!this.isUuid(ref)) return null;
    return this.prisma.invoice.findFirst({ where: { deletedAt: null, id: ref }, select });
  }

  private isUuid(v: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  }

  private digest(buf: Buffer): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('node:crypto').createHash('sha256').update(buf).digest('hex').slice(0, 32);
  }

  private async finish(id: string, status: string, error?: string, organizationId?: string): Promise<void> {
    await this.prisma.billingEvent.update({
      where: { id },
      data: { status, error: error ?? null, processedAt: new Date(), organizationId: organizationId ?? null },
    });
  }

  /** The event log, for the platform screen. */
  async events(limit = 100): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.billingEvent.findMany({ orderBy: { receivedAt: 'desc' }, take: limit });
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      eventId: r.providerEventId,
      type: r.type,
      signatureValid: r.signatureValid,
      status: r.status,
      error: r.error,
      receivedAt: r.receivedAt,
      processedAt: r.processedAt,
    }));
  }
}
