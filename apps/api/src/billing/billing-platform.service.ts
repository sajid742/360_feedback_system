import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { EntitlementService } from '../license/entitlement.service';
import { BillingService, type InvoiceView } from './billing.service';
import { BillingNotifyService } from './billing-notify.service';
import { BILLING_PROVIDER } from './providers/provider.registry';
import { billingCurrency, DEFAULT_PRICES } from './plan-pricing';
import { formatMoney, type BillingInterval, type BillingProvider } from './billing.types';
import { PLANS, type PlanCode } from '../license/plans';
import type { AuthUser, RequestContext } from '../common/auth/current-user';
import type { ComplimentaryDto, ExtendDto, IssueInvoiceDto, RecordPaymentDto, SetPriceDto } from './billing.dto';

const DAY = 86_400_000;

/**
 * Billing operations that belong to the vendor, not to a tenant.
 *
 * WHY THESE ARE NOT ON THE TENANT CONTROLLER. Issuing an invoice, marking one paid,
 * granting a free month and editing the price list are all acts that decide what an
 * organisation has bought. A tenant that could perform any of them could award itself
 * Enterprise. The split is the control: `BillingController` lets a customer CHOOSE and
 * CANCEL; everything that recognises money lives here, behind `PlatformAdminGuard`.
 *
 * Every method takes an explicit organisation id, because a platform administrator is
 * by definition acting on someone else's organisation — the opposite of every tenant
 * service in this application, where the organisation comes from the token and can
 * never be supplied by the caller.
 */
@Injectable()
export class BillingPlatformService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementService,
    private readonly billing: BillingService,
    private readonly notify: BillingNotifyService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
  ) {}

  /* ------------------------------------------------------------ reading */

  /** Every invoice on the platform, newest first, with the organisation's name. */
  async invoices(organizationId?: string, limit = 200): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.invoice.findMany({
      where: { deletedAt: null, ...(organizationId ? { organizationId } : {}) },
      orderBy: { issuedAt: 'desc' },
      take: limit,
      include: { organization: { select: { id: true, name: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      organizationId: r.organizationId,
      organizationName: r.organization?.name ?? null,
      planCode: r.planCode,
      interval: r.interval,
      currency: r.currency,
      total: Number(r.totalMinor),
      totalFormatted: formatMoney(r.totalMinor, r.currency),
      status: r.status,
      issuedAt: r.issuedAt,
      dueAt: r.dueAt,
      paidAt: r.paidAt,
      // An open invoice past its due date is the only number an operator chasing
      // payment actually wants, so it is computed here rather than in four screens.
      overdue: r.status === 'open' && r.dueAt !== null && r.dueAt.getTime() < Date.now(),
    }));
  }

  async payments(organizationId?: string, limit = 200): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.payment.findMany({
      where: { deletedAt: null, ...(organizationId ? { organizationId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { organization: { select: { name: true } }, invoice: { select: { number: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      organizationId: r.organizationId,
      organizationName: r.organization?.name ?? null,
      invoiceNumber: r.invoice?.number ?? null,
      provider: r.provider,
      method: r.method,
      status: r.status,
      amount: Number(r.amountMinor),
      amountFormatted: formatMoney(r.amountMinor, r.currency),
      reference: r.reference,
      failureReason: r.failureReason,
      paidAt: r.paidAt,
      createdAt: r.createdAt,
    }));
  }

  /** Revenue and collection at a glance — the numbers a billing screen leads with. */
  async stats(): Promise<Record<string, unknown>> {
    const [open, paid, overdue, failed] = await Promise.all([
      this.prisma.invoice.aggregate({ where: { deletedAt: null, status: 'open' }, _sum: { totalMinor: true }, _count: true }),
      this.prisma.invoice.aggregate({ where: { deletedAt: null, status: 'paid' }, _sum: { totalMinor: true }, _count: true }),
      this.prisma.invoice.count({ where: { deletedAt: null, status: 'open', dueAt: { lt: new Date() } } }),
      this.prisma.payment.count({ where: { deletedAt: null, status: 'failed' } }),
    ]);
    const currency = billingCurrency();
    const sum = (v: bigint | null | undefined): bigint => v ?? 0n;
    return {
      currency,
      provider: this.provider.key,
      openInvoices: open._count,
      openAmount: Number(sum(open._sum.totalMinor)),
      openAmountFormatted: formatMoney(sum(open._sum.totalMinor), currency),
      paidInvoices: paid._count,
      collected: Number(sum(paid._sum.totalMinor)),
      collectedFormatted: formatMoney(sum(paid._sum.totalMinor), currency),
      overdueInvoices: overdue,
      failedPayments: failed,
    };
  }

  /* ------------------------------------------------------------- acting */

  /** Issue an invoice on a tenant's behalf — the normal start of a paid subscription. */
  async issueInvoice(
    actor: AuthUser,
    ctx: RequestContext,
    organizationId: string,
    dto: IssueInvoiceDto,
  ): Promise<InvoiceView & { instructions: string | null; providerReference: string | null }> {
    const planCode = dto.planCode as PlanCode;
    const interval = dto.interval as BillingInterval;
    const amountMinor = await this.billing.priceFor(planCode, interval);
    const invoice = await this.billing.issueInvoice({
      organizationId,
      planCode,
      interval,
      amountMinor,
      currency: billingCurrency(),
      createdBy: actor.userId,
      notes: dto.notes,
    });

    // REGISTER IT WITH THE PROVIDER, exactly as a customer-initiated checkout does.
    // An operator raising a renewal is raising an invoice somebody has to pay; on 1BILL
    // an unregistered invoice has no consumer number, so no bank would recognise it and
    // the customer could not pay it at all. The registration failing does not fail the
    // issue — the invoice stands and reconciliation will catch up.
    const org = await this.prisma.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
      select: { name: true },
    });
    const started = await this.billing.registerBill({
      organizationId,
      organizationName: org?.name ?? 'Customer',
      planCode,
      interval,
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      amountMinor: invoice.totalMinor,
      currency: invoice.currency,
      dueAt: invoice.dueAt ?? undefined,
    });

    // TELL THE CUSTOMER. An operator raising a renewal used to register a bill and then
    // tell nobody — no notification, and the 1BILL ID nowhere in the response — so the
    // one thing the customer needs in order to pay went straight into the database and
    // stopped there. This is the same notification the customer's own checkout sends.
    await this.notify.invoiceIssued(
      organizationId,
      invoice.number,
      formatMoney(invoice.totalMinor, invoice.currency),
      started.instructions,
    );

    await this.audit.record({
      organizationId,
      userId: actor.userId,
      action: 'billing.invoice.issued_by_platform',
      entityType: 'invoice',
      entityId: invoice.id,
      newValue: { number: invoice.number, planCode, interval, total: Number(invoice.totalMinor) },
      ip: ctx.ip,
      device: ctx.device,
    });
    // The operator gets the payment instructions back as well as the invoice, so the
    // 1BILL ID is on screen for them to read out or forward.
    const view = await this.billing.invoice(organizationId, invoice.id);
    return { ...view, instructions: started.instructions ?? null, providerReference: started.providerInvoiceId ?? null };
  }

  /**
   * Record money received.
   *
   * This is the manual counterpart of a webhook, and it is the route that actually
   * collects revenue today: an operator sees the bank transfer, finds the invoice
   * number the customer quoted, and records it here. `BillingService.recordPayment`
   * does the rest — activating the plan, moving the period, notifying the customer —
   * so the manual path and the webhook path converge on exactly the same code.
   */
  async recordPayment(actor: AuthUser, ctx: RequestContext, invoiceId: string, dto: RecordPaymentDto): Promise<InvoiceView> {
    const paidAt = dto.paidAt ? new Date(dto.paidAt) : undefined;
    if (paidAt && Number.isNaN(paidAt.getTime())) throw new BadRequestException('paidAt is not a valid date.');
    return this.billing.recordPayment(
      { userId: actor.userId, email: actor.email },
      ctx,
      invoiceId,
      {
        amountMinor: dto.amountMinor === undefined ? undefined : BigInt(dto.amountMinor),
        method: dto.method ?? 'bank_transfer',
        reference: dto.reference,
        paidAt,
        notes: dto.notes,
      },
    );
  }

  /**
   * Void an invoice.
   *
   * Voiding is not deleting: the row stays, the number is never reused, and the reason
   * is recorded. An invoice raised in error has to remain visible, because the customer
   * has already seen it.
   */
  async voidInvoice(actor: AuthUser, ctx: RequestContext, invoiceId: string, reason?: string): Promise<InvoiceView> {
    const invoice = await this.prisma.invoice.findFirst({ where: { id: invoiceId, deletedAt: null } });
    if (!invoice) throw new NotFoundException('Invoice not found.');
    if (invoice.status === 'paid') throw new BadRequestException('A paid invoice cannot be voided — the money has been received against it.');
    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        status: 'void',
        notes: [invoice.notes, reason ? `Voided: ${reason}` : 'Voided.'].filter(Boolean).join('\n'),
        updatedBy: actor.userId,
      },
    });
    await this.audit.record({
      organizationId: invoice.organizationId,
      userId: actor.userId,
      action: 'billing.invoice.voided',
      entityType: 'invoice',
      entityId: invoice.id,
      previousValue: { status: invoice.status },
      newValue: { status: 'void', reason: reason ?? null },
      ip: ctx.ip,
      device: ctx.device,
    });
    return this.billing.invoice(invoice.organizationId, invoice.id);
  }

  /**
   * Grant a plan without payment — a pilot, a partner, a goodwill month.
   *
   * It writes a zero-amount `complimentary` payment row against no invoice, so the
   * reason a tenant is on Professional without having paid is answerable from the
   * billing history rather than from someone's memory.
   */
  async complimentary(actor: AuthUser, ctx: RequestContext, organizationId: string, dto: ComplimentaryDto): Promise<Record<string, unknown>> {
    const planCode = dto.planCode as PlanCode;
    const periodEnd = new Date(Date.now() + dto.days * DAY);
    await this.billing.applyPlan(organizationId, planCode, 'month', periodEnd, actor.userId);
    await this.prisma.payment.create({
      data: {
        organizationId,
        invoiceId: null,
        provider: 'manual',
        method: 'complimentary',
        currency: billingCurrency(),
        amountMinor: 0n,
        status: 'succeeded',
        reference: `complimentary/${dto.days}d`,
        paidAt: new Date(),
        recordedBy: actor.userId,
        notes: dto.reason,
      },
    });
    await this.audit.record({
      organizationId,
      userId: actor.userId,
      action: 'billing.plan.complimentary',
      entityType: 'subscription',
      entityId: organizationId,
      newValue: { planCode, days: dto.days, until: periodEnd, reason: dto.reason },
      ip: ctx.ip,
      device: ctx.device,
    });
    await this.notify.planChanged(organizationId, PLANS[planCode].label);
    return { planCode, until: periodEnd, reason: dto.reason };
  }

  /** Push the period end out — the humane answer to "the transfer is on its way". */
  async extend(actor: AuthUser, ctx: RequestContext, organizationId: string, dto: ExtendDto): Promise<Record<string, unknown>> {
    const sub = await this.prisma.subscription.findFirst({ where: { organizationId, deletedAt: null } });
    if (!sub) throw new NotFoundException('This organization has no subscription.');
    const from = sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() > Date.now() ? sub.currentPeriodEnd : new Date();
    const until = new Date(from.getTime() + dto.days * DAY);
    await this.prisma.subscription.update({
      where: { id: sub.id },
      // Extending a lapsed subscription has to put it back into service, or the dates
      // would say "active until October" while the status still said "expired".
      data: { currentPeriodEnd: until, status: 'active', updatedBy: actor.userId },
    });
    this.entitlements.invalidate(organizationId);
    await this.audit.record({
      organizationId,
      userId: actor.userId,
      action: 'billing.subscription.extended',
      entityType: 'subscription',
      entityId: sub.id,
      previousValue: { status: sub.status, currentPeriodEnd: sub.currentPeriodEnd },
      newValue: { status: 'active', currentPeriodEnd: until, days: dto.days, reason: dto.reason },
      ip: ctx.ip,
      device: ctx.device,
    });
    return { organizationId, currentPeriodEnd: until, status: 'active' };
  }

  /* ------------------------------------------------------------- prices */

  async prices(): Promise<Record<string, unknown>[]> {
    const rows = await this.billing.prices();
    return rows.map((r) => ({
      planCode: r.planCode,
      interval: r.interval,
      currency: r.currency,
      amountMinor: Number(r.amountMinor),
      formatted: formatMoney(r.amountMinor, r.currency),
      // What the code would use if this row were deleted — the operator can see how far
      // they have moved from the shipped list.
      defaultMinor: DEFAULT_PRICES[r.planCode as PlanCode]?.[r.interval as BillingInterval] ?? null,
    }));
  }

  /**
   * Change a price.
   *
   * Prices live in `plan_prices`, not in the code, so this needs no release. Existing
   * invoices are untouched by design: an invoice records what was charged at the time,
   * and a price change that silently rewrote history would be indefensible.
   */
  async setPrice(actor: AuthUser, ctx: RequestContext, dto: SetPriceDto): Promise<Record<string, unknown>> {
    const currency = billingCurrency();
    const existing = await this.prisma.planPrice.findFirst({
      where: { planCode: dto.planCode, interval: dto.interval, currency, provider: this.provider.key },
    });
    const data = {
      amountMinor: BigInt(dto.amountMinor),
      providerPriceId: dto.providerPriceId ?? null,
      isActive: true,
      updatedBy: actor.userId,
    };
    const row = existing
      ? await this.prisma.planPrice.update({ where: { id: existing.id }, data })
      : await this.prisma.planPrice.create({
          data: {
            planCode: dto.planCode,
            interval: dto.interval,
            currency,
            provider: this.provider.key,
            effectiveFrom: new Date(),
            ...data,
          },
        });
    await this.audit.record({
      // A price change belongs to no tenant, so it is recorded against the platform
      // administrator's OWN organisation — `audit_logs` is per-tenant by design and an
      // orphan row would have nowhere to live. The plan_prices row itself also carries
      // `updatedBy` and `updatedAt`, so the change is answerable from two places.
      organizationId: actor.organizationId,
      userId: actor.userId,
      action: 'billing.price.changed',
      entityType: 'plan_price',
      entityId: row.id,
      previousValue: existing ? { amountMinor: Number(existing.amountMinor) } : undefined,
      newValue: { planCode: dto.planCode, interval: dto.interval, currency, amountMinor: dto.amountMinor },
      ip: ctx.ip,
      device: ctx.device,
    });
    return { planCode: row.planCode, interval: row.interval, currency: row.currency, amountMinor: Number(row.amountMinor) };
  }
}
