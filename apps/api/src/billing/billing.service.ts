import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth/current-user';
import { EntitlementService } from '../license/entitlement.service';
import { PLANS, PLAN_CODES, isPlanCode, type PlanCode } from '../license/plans';
import { BillingNotifyService } from './billing-notify.service';
import { BILLING_PROVIDER } from './providers/provider.registry';
import {
  addInterval,
  formatMoney,
  isBillingInterval,
  type BillingInterval,
  type BillingProvider,
  type CheckoutResult,
} from './billing.types';
import { DEFAULT_PRICES, billingCurrency, billingTaxPercent, invoiceDueDays, isFreeAmount } from './plan-pricing';

/** What a screen needs to render one invoice. BigInt never leaves this service. */
export interface InvoiceView {
  id: string;
  number: string;
  planCode: string;
  interval: string;
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  totalFormatted: string;
  status: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  issuedAt: Date;
  dueAt: Date | null;
  paidAt: Date | null;
  notes: string | null;
}

@Injectable()
export class BillingService {
  private readonly log = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    private readonly notify: BillingNotifyService,
  ) {}

  /* ------------------------------------------------------------- pricing */

  /**
   * The price list, seeded from code on first read.
   *
   * Seeding lazily rather than in a migration keeps the defaults in one place — the
   * code — while making the table authoritative the moment anyone edits it. Adding a
   * plan later therefore needs no migration either.
   */
  async prices(): Promise<
    { planCode: string; currency: string; interval: string; amountMinor: bigint; providerPriceId: string | null }[]
  > {
    const currency = billingCurrency();
    const existing = await this.prisma.planPrice.findMany({
      where: { currency, provider: this.provider.key, deletedAt: null, isActive: true },
    });
    if (existing.length > 0) return existing;

    const rows: Prisma.PlanPriceCreateManyInput[] = [];
    for (const code of PLAN_CODES) {
      for (const interval of ['month', 'year'] as BillingInterval[]) {
        rows.push({
          planCode: code,
          currency,
          interval,
          amountMinor: BigInt(DEFAULT_PRICES[code]?.[interval] ?? 0),
          provider: this.provider.key,
        });
      }
    }
    // skipDuplicates: two requests can race here on a cold install; the unique index
    // decides and neither caller needs to care.
    await this.prisma.planPrice.createMany({ data: rows, skipDuplicates: true });
    this.log.log(`Seeded ${rows.length} default ${currency} prices for ${this.provider.key} billing.`);
    return this.prisma.planPrice.findMany({
      where: { currency, provider: this.provider.key, deletedAt: null, isActive: true },
    });
  }

  async priceFor(planCode: PlanCode, interval: BillingInterval): Promise<bigint> {
    const all = await this.prices();
    const row = all.find((p) => p.planCode === planCode && p.interval === interval);
    if (row) return row.amountMinor;
    // A plan with no row is not an error — it is free. Falling back to the code default
    // keeps a newly added plan working before anyone has priced it.
    return BigInt(DEFAULT_PRICES[planCode]?.[interval] ?? 0);
  }

  /* ------------------------------------------------------------ checkout */

  /**
   * Start a plan change.
   *
   * THE CLIENT SENDS A PLAN CODE AND AN INTERVAL. NOTHING ELSE. The amount is looked
   * up here, server-side, so there is no request shape in which a browser can propose
   * what it would like to pay. That single rule is what makes price tampering
   * impossible rather than merely difficult.
   */
  async checkout(
    user: AuthUser,
    ctx: RequestContext,
    input: { planCode: string; interval: string },
  ): Promise<CheckoutResult> {
    if (!isPlanCode(input.planCode)) throw new BadRequestException('Unknown plan.');
    if (!isBillingInterval(input.interval)) throw new BadRequestException('Billing interval must be "month" or "year".');
    const planCode = input.planCode;
    const interval = input.interval;

    const org = await this.requireOrg(user.organizationId);
    const amountMinor = await this.priceFor(planCode, interval);
    const currency = billingCurrency();

    // The free plan needs no invoice, no payment and no approval. Making a customer
    // wait for an operator to "approve" a zero-rupee invoice would be theatre.
    if (isFreeAmount(amountMinor)) {
      await this.applyPlan(user.organizationId, planCode, interval, null, user.userId);
      await this.audit.record({
        organizationId: user.organizationId,
        userId: user.userId,
        action: 'billing.plan.selected_free',
        entityType: 'subscription',
        entityId: user.organizationId,
        newValue: { planCode, interval },
        ...ctx,
      });
      await this.notify.planChanged(user.organizationId, PLANS[planCode].label);
      return { invoiceId: null, invoiceNumber: null, amountMinor: 0n, currency, free: true };
    }

    const open = await this.prisma.invoice.findFirst({
      where: { organizationId: user.organizationId, status: 'open', planCode, interval, deletedAt: null },
    });
    if (open) {
      // Re-issuing would leave two open invoices for the same thing and two bank
      // transfers to reconcile. Hand back the one that already exists.
      throw new ConflictException(
        `Invoice ${open.number} for the ${PLANS[planCode].label} plan is already open. Pay or cancel it before requesting another.`,
      );
    }

    const invoice = await this.issueInvoice({
      organizationId: user.organizationId,
      planCode,
      interval,
      amountMinor,
      currency,
      createdBy: user.userId,
      notes: `Requested by ${user.email}`,
    });

    const started = await this.registerBill({
      organizationId: user.organizationId,
      organizationName: org.name,
      planCode,
      interval,
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      amountMinor: invoice.totalMinor,
      currency: invoice.currency,
      dueAt: invoice.dueAt ?? undefined,
    });

    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: 'billing.checkout.started',
      entityType: 'invoice',
      entityId: invoice.id,
      newValue: { planCode, interval, number: invoice.number, total: Number(invoice.totalMinor) },
      ...ctx,
    });
    await this.notify.invoiceIssued(
      user.organizationId,
      invoice.number,
      formatMoney(invoice.totalMinor, invoice.currency),
      started.instructions,
    );

    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      amountMinor: invoice.totalMinor,
      currency: invoice.currency,
      instructions: started.instructions,
      url: started.url,
      free: false,
    };
  }

  /**
   * Register an invoice with the payment provider and record what it said.
   *
   * EVERY invoice a customer is expected to pay goes through here — the one they raise
   * themselves at checkout AND the one an operator raises for a renewal. That is not
   * symmetry for its own sake: on 1BILL an unregistered invoice has no consumer number,
   * which means no bank will recognise it and the customer simply cannot pay it. An
   * operator issuing a renewal that is unpayable would be a quiet, recurring failure.
   *
   * A PROVIDER OUTAGE NEVER FAILS THE CALLER. The invoice already exists and is payable
   * by other means; throwing here would hand back an error while leaving an orphan open
   * invoice behind. The adapter's own error path returns usable instructions, and this
   * catch is the backstop for anything it does not handle. The hourly reconciliation
   * sweep picks the bill up once the provider is reachable again.
   */
  async registerBill(input: {
    organizationId: string;
    organizationName: string;
    planCode: PlanCode;
    interval: BillingInterval;
    invoiceId: string;
    invoiceNumber: string;
    amountMinor: bigint;
    currency: string;
    dueAt?: Date;
  }): Promise<{ url?: string; instructions?: string; providerInvoiceId?: string }> {
    let started: { url?: string; instructions?: string; providerInvoiceId?: string } = {};
    try {
      started = await this.provider.startCheckout(input);
    } catch (err) {
      this.log.error(
        `Provider ${this.provider.key} could not register ${input.invoiceNumber}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      started = {
        instructions:
          `Invoice ${input.invoiceNumber} has been issued for ${formatMoney(input.amountMinor, input.currency)}.\n\n` +
          'It could not be registered with the payment provider just now. The invoice stands — ' +
          'please contact your supplier for how to pay it, quoting the invoice number.',
      };
    }

    // The provider's own reference for this bill. For 1BILL it is the consumer number —
    // the thing the customer types into their bank — so losing it would leave them
    // holding an invoice they cannot pay, and leave reconciliation nothing to ask about.
    //
    // This write is inside the guard too. It used to sit outside, so a failure here —
    // a statement timeout, a connection blip — escaped into the caller and returned a
    // 500 for an invoice that already existed AND had already been registered at the
    // provider: the worst of both, and exactly what this method claims to prevent.
    if (started.providerInvoiceId) {
      try {
        await this.prisma.invoice.update({
          where: { id: input.invoiceId },
          data: { providerInvoiceId: started.providerInvoiceId.slice(0, 120), provider: this.provider.key },
        });
      } catch (err) {
        this.log.error(
          `Registered ${input.invoiceNumber} with ${this.provider.key} but could not store the reference: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return started;
  }

  /* ------------------------------------------------------------ invoices */

  /**
   * Create an invoice.
   *
   * The number is `INV-<year>-<sequence>`, and the sequence is derived inside a
   * transaction from the highest existing number for that year. Two concurrent issues
   * can still collide; the unique index catches it and the retry picks the next one,
   * which is simpler and safer than a counter table nobody remembers to back up.
   */
  async issueInvoice(input: {
    organizationId: string;
    planCode: PlanCode;
    interval: BillingInterval;
    amountMinor: bigint;
    currency: string;
    createdBy: string | null;
    notes?: string;
    periodStart?: Date;
  }): Promise<{ id: string; number: string; totalMinor: bigint; currency: string; dueAt: Date | null }> {
    const taxPercent = billingTaxPercent();
    const subtotal = input.amountMinor;
    // Integer arithmetic throughout: 17% of 2,500,000 paisa is exact, and rounding
    // happens once, deliberately, rather than wherever a float lands.
    const tax = (subtotal * BigInt(Math.round(taxPercent * 100))) / 10_000n;
    const total = subtotal + tax;

    const dueAt = new Date(Date.now() + invoiceDueDays() * 86_400_000);

    const subscription = await this.prisma.subscription.findFirst({
      where: { organizationId: input.organizationId, deletedAt: null },
      select: { id: true, planCode: true, currentPeriodEnd: true },
    });

    // A RENEWAL EXTENDS; IT DOES NOT RESTART. A customer on a yearly plan with three
    // months left who pays the renewal early must not lose those three months, so the
    // new period begins where the paid one ends. Only for the SAME plan: an upgrade is
    // a different product and starts when it is paid for.
    const renewalFrom =
      subscription &&
      subscription.planCode === input.planCode &&
      subscription.currentPeriodEnd &&
      subscription.currentPeriodEnd.getTime() > Date.now()
        ? subscription.currentPeriodEnd
        : null;
    const periodStart = input.periodStart ?? renewalFrom ?? new Date();
    const periodEnd = addInterval(periodStart, input.interval);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const number = await this.nextInvoiceNumber();
      try {
        const row = await this.prisma.invoice.create({
          data: {
            organizationId: input.organizationId,
            subscriptionId: subscription?.id ?? null,
            number,
            planCode: input.planCode,
            interval: input.interval,
            currency: input.currency,
            subtotalMinor: subtotal,
            taxMinor: tax,
            totalMinor: total,
            status: 'open',
            periodStart,
            periodEnd,
            dueAt,
            provider: this.provider.key,
            notes: input.notes ?? null,
            createdBy: input.createdBy,
            updatedBy: input.createdBy,
          },
          select: { id: true, number: true, totalMinor: true, currency: true, dueAt: true },
        });
        return row;
      } catch (err) {
        // P2002 is the unique-number collision. Anything else is a real failure.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
    }
    throw new ConflictException('Could not allocate an invoice number. Please try again.');
  }

  /**
   * The next invoice number for this year.
   *
   * The maximum is taken NUMERICALLY, in the database. Sorting the strings would be
   * wrong the moment a year passes ten thousand invoices: `"INV-2026-9999"` sorts
   * ABOVE `"INV-2026-10000"`, so the sequence would silently pin at 9999 and every
   * later call would return a number that already exists. The padding is cosmetic and
   * the sequence is free to outgrow it.
   */
  private async nextInvoiceNumber(): Promise<string> {
    const year = new Date().getUTCFullYear();
    const prefix = `INV-${year}-`;
    const rows = await this.prisma.$queryRaw<{ max: number | null }[]>`
      SELECT COALESCE(MAX(CAST(split_part(number, '-', 3) AS INTEGER)), 0)::int AS max
      FROM invoices
      WHERE number LIKE ${prefix + '%'} AND split_part(number, '-', 3) ~ '^[0-9]+$'
    `;
    const seq = (rows[0]?.max ?? 0) + 1;
    return `${prefix}${String(seq).padStart(4, '0')}`;
  }

  /* ------------------------------------------------------------ payments */

  /**
   * Record a payment against an invoice and apply the plan it bought.
   *
   * This is the one place a subscription starts or renews, whether the payment came
   * from an operator recording a bank transfer or from a verified webhook — so the
   * state transition, the audit entry and the notification cannot diverge between the
   * two paths.
   */
  async recordPayment(
    actor: { userId: string | null; email: string | null },
    ctx: RequestContext | null,
    invoiceId: string,
    input: {
      amountMinor?: bigint;
      method?: string;
      reference?: string;
      paidAt?: Date;
      notes?: string;
      provider?: string;
      providerPaymentId?: string;
      /** Set by a webhook that stated one. A mismatch with the invoice is refused. */
      currency?: string;
    },
  ): Promise<InvoiceView> {
    const invoice = await this.prisma.invoice.findFirst({ where: { id: invoiceId, deletedAt: null } });
    if (!invoice) throw new NotFoundException('Invoice not found.');
    if (invoice.status === 'void') throw new BadRequestException('This invoice has been voided.');

    const amount = input.amountMinor ?? invoice.totalMinor;
    // A negative amount would REDUCE the paid total and understate collected revenue.
    // Nothing legitimate sends one; a refund is a separate concept this module does not
    // yet implement, and pretending a negative payment is one would be worse than
    // refusing it.
    if (amount < 0n) throw new BadRequestException('A payment amount cannot be negative.');
    // A payment quoted in another currency cannot settle this invoice. Recording 100 USD
    // against a PKR invoice as though it were 100 PKR is a silent money error.
    if (input.currency && input.currency !== invoice.currency) {
      throw new BadRequestException(
        `This payment is in ${input.currency} but invoice ${invoice.number} is in ${invoice.currency}.`,
      );
    }

    // A provider payment id makes the insert idempotent on its own: a webhook
    // delivered twice cannot create two payment rows even if the event log is bypassed.
    // A provider that sends no id of its own gets one derived from the event, because
    // without any key at all a redelivery would insert a second payment.
    const providerPaymentId = input.providerPaymentId ?? null;
    if (providerPaymentId) {
      const seen = await this.prisma.payment.findFirst({
        where: { provider: input.provider ?? this.provider.key, providerPaymentId, deletedAt: null },
      });
      if (seen) return this.toInvoiceView(invoice);
    }

    // THE WHOLE RECOGNITION IS ONE TRANSACTION, and it starts by locking the invoice
    // row. Without the lock two operators recording the same bank transfer at the same
    // moment both read a short paid-total, both decide the invoice is now settled, and
    // the customer is activated twice and e-mailed twice for one payment.
    const settled = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoice.id}::uuid FOR UPDATE`;
      await tx.payment.create({
        data: {
          organizationId: invoice.organizationId,
          invoiceId: invoice.id,
          provider: input.provider ?? this.provider.key,
          providerPaymentId,
          method: input.method ?? 'bank_transfer',
          currency: invoice.currency,
          amountMinor: amount,
          status: 'succeeded',
          reference: input.reference ?? null,
          paidAt: input.paidAt ?? new Date(),
          recordedBy: actor.userId,
          notes: input.notes ?? null,
        },
      });
      const rows = await tx.payment.findMany({
        where: { invoiceId: invoice.id, status: 'succeeded', deletedAt: null },
        select: { amountMinor: true },
      });
      const total = rows.reduce((sum, r) => sum + r.amountMinor, 0n);
      if (total < invoice.totalMinor) return { paidTotal: total, justSettled: false };
      // RE-READ INSIDE THE LOCK. The snapshot taken before the transaction is stale by
      // definition — two settlements that both read `open` before either committed would
      // both conclude they were the one that settled it, and the plan would be applied
      // and the customer e-mailed twice. Only the state behind the lock can answer this.
      const current = await tx.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
        select: { status: true },
      });
      const already = current.status === 'paid';
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { status: 'paid', paidAt: input.paidAt ?? new Date(), updatedBy: actor.userId },
      });
      return { paidTotal: total, justSettled: !already };
    });

    const paidTotal = settled.paidTotal;
    // Part payments are recorded but do not activate the plan. Saying so plainly beats
    // silently activating on a short transfer.
    if (paidTotal < invoice.totalMinor) {
      await this.audit.record({
        organizationId: invoice.organizationId,
        userId: actor.userId,
        action: 'billing.payment.partial',
        entityType: 'invoice',
        entityId: invoice.id,
        newValue: { paid: Number(paidTotal), total: Number(invoice.totalMinor), reference: input.reference ?? null },
        ...(ctx ?? {}),
      });
      return this.toInvoiceView(await this.prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } }));
    }

    const updated = await this.prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    if (!settled.justSettled) return this.toInvoiceView(updated);

    // A LAPSED INVOICE DOES NOT MOVE THE PLAN BACKWARDS. An old Professional invoice
    // paid months late must not downgrade an organisation that has since bought
    // Enterprise, nor back-date its period to a range that has already passed — which
    // would expire the tenant on the next nightly sweep. The money is still recorded;
    // only the plan change is withheld, and it is audited so an operator can see why.
    const stale = invoice.periodEnd !== null && invoice.periodEnd.getTime() <= Date.now();
    if (stale) {
      this.log.warn(
        `Invoice ${invoice.number} settled but its period ended ${invoice.periodEnd?.toISOString()} — plan NOT applied.`,
      );
      await this.audit.record({
        organizationId: invoice.organizationId,
        userId: actor.userId,
        action: 'billing.payment.recorded_late',
        entityType: 'invoice',
        entityId: invoice.id,
        newValue: { number: invoice.number, periodEnd: invoice.periodEnd, planApplied: false },
        ...(ctx ?? {}),
      });
    } else {
      await this.applyPlan(
        invoice.organizationId,
        invoice.planCode as PlanCode,
        invoice.interval as BillingInterval,
        invoice.periodEnd,
        actor.userId,
        invoice.periodStart ?? undefined,
      );
    }

    await this.audit.record({
      organizationId: invoice.organizationId,
      userId: actor.userId,
      action: 'billing.payment.recorded',
      entityType: 'invoice',
      entityId: invoice.id,
      newValue: {
        number: invoice.number,
        planCode: invoice.planCode,
        amount: Number(amount),
        method: input.method ?? 'bank_transfer',
        reference: input.reference ?? null,
        recordedBy: actor.email,
      },
      ...(ctx ?? {}),
    });
    await this.notify.paymentReceived(
      invoice.organizationId,
      invoice.number,
      formatMoney(amount, invoice.currency),
      PLANS[invoice.planCode as PlanCode]?.label ?? invoice.planCode,
    );

    return this.toInvoiceView(updated);
  }

  /** A failed payment is recorded, not thrown away — it is what a dunning process reads. */
  async recordFailure(
    invoiceId: string,
    input: { provider?: string; providerPaymentId?: string; amountMinor?: bigint; reason?: string },
  ): Promise<void> {
    const invoice = await this.prisma.invoice.findFirst({ where: { id: invoiceId, deletedAt: null } });
    if (!invoice) return;
    if (input.providerPaymentId) {
      const seen = await this.prisma.payment.findFirst({
        where: { provider: input.provider ?? this.provider.key, providerPaymentId: input.providerPaymentId, deletedAt: null },
      });
      if (seen) return;
    }
    await this.prisma.payment.create({
      data: {
        organizationId: invoice.organizationId,
        invoiceId: invoice.id,
        provider: input.provider ?? this.provider.key,
        providerPaymentId: input.providerPaymentId ?? null,
        method: 'card',
        currency: invoice.currency,
        amountMinor: input.amountMinor ?? invoice.totalMinor,
        status: 'failed',
        failureReason: input.reason ?? null,
      },
    });
    await this.audit.record({
      organizationId: invoice.organizationId,
      userId: null,
      action: 'billing.payment.failed',
      entityType: 'invoice',
      entityId: invoice.id,
      newValue: { number: invoice.number, reason: input.reason ?? null },
    });
    await this.notify.paymentFailed(invoice.organizationId, invoice.number, input.reason ?? 'The payment was declined.');
  }

  /* --------------------------------------------------------- the plan */

  /**
   * Put a plan on the subscription. The single writer of a paid plan change.
   *
   * A cancellation flag is cleared here on purpose: paying for a period is an
   * unambiguous statement that the customer is staying.
   */
  async applyPlan(
    organizationId: string,
    planCode: PlanCode,
    interval: BillingInterval,
    periodEnd: Date | null,
    actorUserId: string | null,
    periodStart?: Date,
  ): Promise<void> {
    const existing = await this.prisma.subscription.findFirst({ where: { organizationId, deletedAt: null } });
    const data = {
      planCode,
      billingInterval: interval,
      status: 'active',
      currentPeriodStart: periodStart ?? new Date(),
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      // A paid plan ends a trial: leaving the date behind would make the screen count
      // down to a trial end that no longer means anything.
      trialEndsAt: null,
      updatedBy: actorUserId,
    };
    if (existing) await this.prisma.subscription.update({ where: { id: existing.id }, data });
    else await this.prisma.subscription.create({ data: { organizationId, createdBy: actorUserId, ...data } });
    this.entitlements.invalidate(organizationId);
  }

  /**
   * Cancel at the end of the paid period.
   *
   * NOT immediately, and nothing is deleted. The customer has paid to the period end
   * and keeps everything until then; the lifecycle job lapses it afterwards. An
   * immediate cancellation would be taking away something already bought.
   */
  async cancel(user: AuthUser, ctx: RequestContext, reason?: string): Promise<{ cancelAtPeriodEnd: boolean; endsAt: Date | null }> {
    const sub = await this.prisma.subscription.findFirst({ where: { organizationId: user.organizationId, deletedAt: null } });
    if (!sub) throw new NotFoundException('This organization has no subscription to cancel.');
    if (sub.cancelAtPeriodEnd) return { cancelAtPeriodEnd: true, endsAt: sub.currentPeriodEnd };

    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: { cancelAtPeriodEnd: true, notes: reason ?? sub.notes, updatedBy: user.userId },
    });
    this.entitlements.invalidate(user.organizationId);
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: 'billing.subscription.cancelled',
      entityType: 'subscription',
      entityId: sub.id,
      previousValue: { cancelAtPeriodEnd: false },
      newValue: { cancelAtPeriodEnd: true, endsAt: sub.currentPeriodEnd, reason: reason ?? null },
      ...ctx,
    });
    await this.notify.cancelled(user.organizationId, sub.currentPeriodEnd);
    return { cancelAtPeriodEnd: true, endsAt: sub.currentPeriodEnd };
  }

  /** Undo a pending cancellation before the period ends. */
  async reactivate(user: AuthUser, ctx: RequestContext): Promise<{ cancelAtPeriodEnd: boolean }> {
    const sub = await this.prisma.subscription.findFirst({ where: { organizationId: user.organizationId, deletedAt: null } });
    if (!sub) throw new NotFoundException('This organization has no subscription.');
    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: { cancelAtPeriodEnd: false, updatedBy: user.userId },
    });
    this.entitlements.invalidate(user.organizationId);
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: 'billing.subscription.reactivated',
      entityType: 'subscription',
      entityId: sub.id,
      newValue: { cancelAtPeriodEnd: false },
      ...ctx,
    });
    return { cancelAtPeriodEnd: false };
  }

  /* ----------------------------------------------------------- reading */

  async invoices(organizationId: string): Promise<InvoiceView[]> {
    const rows = await this.prisma.invoice.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: { issuedAt: 'desc' },
      take: 100,
    });
    return rows.map((r) => this.toInvoiceView(r));
  }

  async invoice(organizationId: string, id: string): Promise<InvoiceView> {
    // Scoped by organisation as well as id: an invoice id is a uuid, but relying on
    // that alone is how cross-tenant reads happen.
    const row = await this.prisma.invoice.findFirst({ where: { id, organizationId, deletedAt: null } });
    if (!row) throw new NotFoundException('Invoice not found.');
    return this.toInvoiceView(row);
  }

  async payments(organizationId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.payment.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: { paidAt: 'desc' },
      take: 100,
      include: { invoice: { select: { number: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      invoiceNumber: r.invoice?.number ?? null,
      provider: r.provider,
      method: r.method,
      status: r.status,
      currency: r.currency,
      amount: Number(r.amountMinor),
      amountFormatted: formatMoney(r.amountMinor, r.currency),
      reference: r.reference,
      failureReason: r.failureReason,
      paidAt: r.paidAt,
      createdAt: r.createdAt,
    }));
  }

  /** Everything the subscription screen needs, in one call. */
  async summary(user: AuthUser): Promise<Record<string, unknown>> {
    const orgId = user.organizationId;
    const [state, usage, sub, invoices, payments, prices] = await Promise.all([
      this.entitlements.get(orgId),
      this.entitlements.usage(orgId),
      this.prisma.subscription.findFirst({ where: { organizationId: orgId, deletedAt: null } }),
      this.invoices(orgId),
      this.payments(orgId),
      this.prices(),
    ]);

    return {
      plan: state.planCode,
      planLabel: state.planLabel,
      source: state.source,
      status: state.status,
      subscriptionStatus: state.subscriptionStatus,
      operational: state.operational,
      message: state.message,
      billingInterval: sub?.billingInterval ?? 'month',
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
      trialEndsAt: state.trialEndsAt,
      currentPeriodEnd: state.currentPeriodEnd,
      graceDays: sub?.graceDays ?? null,
      currency: billingCurrency(),
      taxPercent: billingTaxPercent(),
      usage,
      invoices,
      payments,
      catalogue: PLAN_CODES.map((code) => ({
        code,
        label: PLANS[code].label,
        blurb: PLANS[code].blurb,
        modules: PLANS[code].modules,
        limits: PLANS[code].limits,
        prices: (['month', 'year'] as BillingInterval[]).map((interval) => {
          const row = prices.find((p) => p.planCode === code && p.interval === interval);
          const amount = row ? row.amountMinor : BigInt(DEFAULT_PRICES[code]?.[interval] ?? 0);
          return { interval, amount: Number(amount), formatted: formatMoney(amount, billingCurrency()), free: isFreeAmount(amount) };
        }),
      })),
    };
  }

  /* ----------------------------------------------------------- helpers */

  private async requireOrg(id: string): Promise<{ id: string; name: string }> {
    const org = await this.prisma.organization.findFirst({ where: { id, deletedAt: null }, select: { id: true, name: true } });
    if (!org) throw new NotFoundException('Organization not found.');
    return org;
  }

  /** BigInt cannot be JSON-serialised, so it is converted here and never leaves. */
  private toInvoiceView(r: {
    id: string; number: string; planCode: string; interval: string; currency: string;
    subtotalMinor: bigint; taxMinor: bigint; totalMinor: bigint; status: string;
    periodStart: Date | null; periodEnd: Date | null; issuedAt: Date; dueAt: Date | null; paidAt: Date | null; notes: string | null;
  }): InvoiceView {
    return {
      id: r.id,
      number: r.number,
      planCode: r.planCode,
      interval: r.interval,
      currency: r.currency,
      subtotal: Number(r.subtotalMinor),
      tax: Number(r.taxMinor),
      total: Number(r.totalMinor),
      totalFormatted: formatMoney(r.totalMinor, r.currency),
      status: r.status,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      issuedAt: r.issuedAt,
      dueAt: r.dueAt,
      paidAt: r.paidAt,
      notes: r.notes,
    };
  }
}
