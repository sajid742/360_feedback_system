import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { BillingService } from './billing.service';
import { BillingProviderRegistry } from './providers/provider.registry';
import type { PlanCode } from '../license/plans';
import type { BillingInterval } from './billing.types';

/** How many open bills one sweep will ask about. A cap, so a backlog cannot stampede. */
const MAX_PER_RUN = 200;

/**
 * Ask the provider about bills we are still waiting on.
 *
 * WHY THIS IS NOT OPTIONAL ON INVOICE RAILS. A card checkout finishes in seconds while
 * the customer watches. A 1BILL payment does not: the customer pays at an ATM, in a
 * branch, or through an agent, hours or days after the bill was issued, and the news
 * reaches us over someone else's network. If that one callback is lost — a deploy landed
 * mid-delivery, a proxy dropped it, a certificate expired that morning — the invoice
 * stays open for ever and a customer who has genuinely paid sits locked out of the plan
 * they bought, with our own records insisting they never paid.
 *
 * Polling makes the callback an OPTIMISATION FOR SPEED rather than the only route to the
 * truth. It is the same principle as refusing to trust the browser's return from a
 * payment page, one layer further out: never let a single message you do not control be
 * the only thing standing between a customer and what they paid for.
 *
 * It converges rather than duplicating. Everything routes through
 * `BillingService.recordPayment`, which is idempotent on the provider's payment id — so
 * a callback and a sweep that both see the same payment record it once between them, in
 * whichever order they arrive.
 *
 * ONE REPLICA, like every other scheduled job here. See the Deployment Manual.
 */
@Injectable()
export class BillingReconcileService {
  private readonly log = new Logger(BillingReconcileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly providers: BillingProviderRegistry,
  ) {}

  /**
   * Hourly, not daily.
   *
   * A daily sweep would mean a customer whose callback was lost at 09:00 waits until
   * the next morning for a plan they have already paid for. Hourly costs one cheap
   * query against open invoices — usually none at all — and bounds that wait to an hour.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async runScheduled(): Promise<void> {
    try {
      const r = await this.run();
      if (r.checked > 0) {
        this.log.log(`Billing reconciliation: ${r.settled} settled, ${r.checked} checked, ${r.unreachable} unreachable.`);
      }
    } catch (err) {
      this.log.error(`Billing reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Exposed so a platform administrator — and the tests — can run it on demand.
   *
   * ONE AT A TIME. Two hundred bills at up to fifteen seconds each is a run that can
   * outlast its own hourly schedule, and the manual route can be pressed at any moment.
   * Overlapping sweeps would multiply outbound load on the partner and re-enter payment
   * recording concurrently for the same invoices.
   */
  async run(): Promise<{ checked: number; settled: number; unreachable: number; details: string[] }> {
    if (this.running) {
      return { checked: 0, settled: 0, unreachable: 0, details: ['A reconciliation sweep is already running.'] };
    }
    this.running = true;
    try {
      return await this.sweep();
    } finally {
      this.running = false;
    }
  }

  private running = false;

  private async sweep(): Promise<{ checked: number; settled: number; unreachable: number; details: string[] }> {
    const details: string[] = [];
    let checked = 0;
    let settled = 0;
    let unreachable = 0;

    // ONLY the providers that can actually be asked. Without this filter the cap fills
    // with invoices on rails that have nothing to poll — an installation migrated from
    // bank transfer accumulates old permanently-open ones — and the 1BILL bills this
    // service exists to recover are never reached at all.
    const askable = this.providers.known().filter((k) => typeof this.providers.byProviderKey(k)?.fetchStatus === 'function');
    if (askable.length === 0) return { checked: 0, settled: 0, unreachable: 0, details: [] };

    const open = await this.prisma.invoice.findMany({
      where: { status: 'open', deletedAt: null, provider: { in: askable } },
      orderBy: { issuedAt: 'asc' },
      take: MAX_PER_RUN,
      select: {
        id: true,
        number: true,
        organizationId: true,
        provider: true,
        providerInvoiceId: true,
        currency: true,
        totalMinor: true,
        planCode: true,
        interval: true,
        dueAt: true,
        organization: { select: { name: true } },
      },
    });

    for (const invoice of open) {
      // Each invoice is asked of the provider that ISSUED it, not the one currently
      // configured — an invoice raised before a provider migration is still that
      // provider's to answer for.
      const adapter = this.providers.byProviderKey(invoice.provider);
      // An adapter with no way to ask — manual bank transfer, for one — has nothing to
      // reconcile against. That is not a failure; it is what "an operator records it"
      // means.
      if (!adapter?.fetchStatus) continue;

      // A BILL THAT WAS NEVER REGISTERED HAS NOTHING TO ASK ABOUT. Registration can fail
      // after the invoice exists — a partner outage, or a timeout that fired while the
      // partner was committing — and without this the invoice would sit open for ever
      // holding an ID no bank recognises. Retrying here is what makes the claim that
      // "reconciliation will pick it up" actually true.
      if (!invoice.providerInvoiceId) {
        try {
          const again = await this.billing.registerBill({
            organizationId: invoice.organizationId,
            organizationName: invoice.organization?.name ?? 'Customer',
            planCode: invoice.planCode as PlanCode,
            interval: invoice.interval as BillingInterval,
            invoiceId: invoice.id,
            invoiceNumber: invoice.number,
            amountMinor: invoice.totalMinor,
            currency: invoice.currency,
            dueAt: invoice.dueAt ?? undefined,
          });
          if (again.providerInvoiceId) {
            invoice.providerInvoiceId = again.providerInvoiceId;
            details.push(`${invoice.number}: registered with the provider on retry`);
          } else {
            details.push(`${invoice.number}: still could not be registered`);
            continue;
          }
        } catch {
          details.push(`${invoice.number}: still could not be registered`);
          continue;
        }
      }

      checked += 1;
      let status;
      try {
        status = await adapter.fetchStatus({
          invoiceNumber: invoice.number,
          providerInvoiceId: invoice.providerInvoiceId,
        });
      } catch (err) {
        // A throwing adapter is treated exactly as an unreachable one. It must never
        // read as "unpaid".
        unreachable += 1;
        // The provider's own words go to the log, never into `details` — that array is
        // returned by the platform route and rendered on a screen, and a partner's error
        // body routinely echoes what was sent, including the credential it rejected.
        this.log.warn(`Inquiry for ${invoice.number} threw: ${err instanceof Error ? err.message : String(err)}`);
        details.push(`${invoice.number}: provider could not be asked`);
        continue;
      }

      if (status.state === 'unknown') {
        unreachable += 1;
        continue;
      }
      if (status.state !== 'paid') continue;

      // A provider that reports paid but states no amount is taken to have collected the
      // invoice in full — that is what "paid" means on a fixed-amount bill, and the
      // alternative is recording zero against it.
      const amountMinor = status.amountMinor ?? invoice.totalMinor;

      // AN AMOUNT THAT IS NOT THE INVOICE TOTAL IS A UNIT MISMATCH, NOT A PAYMENT.
      // These bills are fixed-amount: the customer cannot choose what to send. So a
      // figure that differs means the provider is quoting something else — major units
      // instead of minor is the classic — and recording it would either overstate
      // revenue or, at 1/100th, leave a fully paid customer locked out for ever while
      // every later sweep dedupes on the payment it already wrote. Refuse and say so.
      if (amountMinor !== invoice.totalMinor) {
        this.log.error(
          `Invoice ${invoice.number} reported paid as ${amountMinor} but is for ${invoice.totalMinor} — ` +
            'not recorded. Check the unit the provider quotes amounts in.',
        );
        details.push(`${invoice.number}: amount mismatch (${amountMinor} vs ${invoice.totalMinor}), skipped`);
        continue;
      }
      if (status.currency && status.currency !== invoice.currency) {
        this.log.error(
          `Invoice ${invoice.number} reported paid in ${status.currency} but is in ${invoice.currency} — not recorded.`,
        );
        details.push(`${invoice.number}: currency mismatch, skipped`);
        continue;
      }

      try {
        await this.billing.recordPayment(
          { userId: null, email: `reconcile:${adapter.key}` },
          null,
          invoice.id,
          {
            amountMinor,
            currency: status.currency,
            method: 'bank_transfer',
            provider: invoice.provider,
            // The same key the callback path falls back to, character for character.
            // They used to differ — `recon:` here, `evt:` there — so a provider whose
            // status inquiry carries no transaction id would have been recorded twice:
            // once by the sweep and again when the callback finally arrived.
            providerPaymentId: status.providerPaymentId ?? `bill:${invoice.number}`,
            reference: status.providerPaymentId ?? invoice.number,
            paidAt: status.paidAt,
            notes: `Recorded by reconciliation — the provider reported this bill paid.`,
          },
        );
        settled += 1;
        details.push(`${invoice.number}: settled from provider status`);
        this.log.log(`Reconciliation settled ${invoice.number} from ${adapter.key}.`);
      } catch (err) {
        details.push(`${invoice.number}: could not be recorded`);
        this.log.error(`Reconciliation could not record ${invoice.number}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { checked, settled, unreachable, details };
  }
}
