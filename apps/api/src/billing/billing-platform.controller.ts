import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { CurrentUser, ReqContext, type AuthUser, type RequestContext } from '../common/auth/current-user';
import { PlatformAdminGuard } from '../platform/platform-admin.guard';
import { BillingPlatformService } from './billing-platform.service';
import { BillingWebhookService } from './billing-webhook.service';
import { BillingProviderRegistry } from './providers/provider.registry';
import { BillingLifecycleService } from './billing-lifecycle.service';
import { BillingReconcileService } from './billing-reconcile.service';
import { ComplimentaryDto, ExtendDto, IssueInvoiceDto, RecordPaymentDto, SetPriceDto, VoidInvoiceDto } from './billing.dto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(v: string | undefined): string | undefined {
  if (v === undefined || v === '') return undefined;
  if (!UUID.test(v)) throw new BadRequestException('organizationId must be a UUID.');
  return v;
}

/**
 * Billing for the vendor. `/api/v1/platform/billing/...`
 *
 * Behind `PlatformAdminGuard` and nothing else — no tenant permission grants access to
 * any route here, however a customer configures their roles. These are the routes that
 * recognise money, and a tenant that could reach them could buy itself a plan.
 */
@Controller('platform/billing')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class BillingPlatformController {
  constructor(
    private readonly billing: BillingPlatformService,
    private readonly webhooks: BillingWebhookService,
    private readonly lifecycle: BillingLifecycleService,
    private readonly reconcile: BillingReconcileService,
    private readonly registry: BillingProviderRegistry,
  ) {}

  @Get('stats')
  stats(): Promise<Record<string, unknown>> {
    return this.billing.stats();
  }

  // The filter is validated rather than passed through: an id that is not a UUID reaches
  // a `uuid` column and becomes a 500 that looks like a server fault instead of a typo.
  @Get('invoices')
  invoices(@Query('organizationId') organizationId?: string): Promise<Record<string, unknown>[]> {
    return this.billing.invoices(requireUuid(organizationId));
  }

  @Get('payments')
  payments(@Query('organizationId') organizationId?: string): Promise<Record<string, unknown>[]> {
    return this.billing.payments(requireUuid(organizationId));
  }

  /** The webhook log, forged deliveries included. */
  @Get('events')
  events(@Query('limit') limit?: string): Promise<Record<string, unknown>[]> {
    const n = Number(limit);
    return this.webhooks.events(Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 100);
  }

  @Get('prices')
  prices(): Promise<Record<string, unknown>[]> {
    return this.billing.prices();
  }

  @Put('prices')
  setPrice(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Body() dto: SetPriceDto) {
    return this.billing.setPrice(user, ctx, dto);
  }

  /* ---------------------------------------------------- per organisation */

  @Post('organizations/:id/invoices')
  issueInvoice(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IssueInvoiceDto,
  ) {
    return this.billing.issueInvoice(user, ctx, id, dto);
  }

  @Post('organizations/:id/complimentary')
  @HttpCode(200)
  complimentary(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ComplimentaryDto,
  ) {
    return this.billing.complimentary(user, ctx, id, dto);
  }

  @Post('organizations/:id/extend')
  @HttpCode(200)
  extend(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExtendDto,
  ) {
    return this.billing.extend(user, ctx, id, dto);
  }

  /* ---------------------------------------------------------- invoices */

  /** Mark an invoice paid. This is what actually activates a paid plan today. */
  @Post('invoices/:id/payments')
  @HttpCode(200)
  recordPayment(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordPaymentDto,
  ) {
    return this.billing.recordPayment(user, ctx, id, dto);
  }

  @Post('invoices/:id/void')
  @HttpCode(200)
  voidInvoice(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidInvoiceDto,
  ) {
    return this.billing.voidInvoice(user, ctx, id, dto.reason);
  }

  /**
   * Run the lifecycle sweep now.
   *
   * The same code the 02:00 cron runs, exposed so an operator can see what it would do
   * without waiting a day — and so the tests can drive dated transitions deterministically
   * instead of sleeping.
   *
   * It applies status changes, which are idempotent, but it does NOT send expiry
   * warnings, which are not: pressing this three times would otherwise e-mail every
   * customer near a boundary three times. The count of warnings it WOULD have sent is
   * still reported.
   */
  @Post('lifecycle/run')
  @HttpCode(200)
  runLifecycle(): Promise<{ changed: number; warned: number; details: string[] }> {
    return this.lifecycle.run();
  }

  /**
   * Ask the payment provider about every invoice still open.
   *
   * Safe to press: it records only what the provider reports as paid, through the same
   * idempotent path a callback uses, so a bill already settled records nothing. This is
   * the first thing to try when a customer says they have paid and the application
   * disagrees.
   */
  @Post('reconcile/run')
  @HttpCode(200)
  runReconcile(): Promise<{ checked: number; settled: number; unreachable: number; details: string[] }> {
    return this.reconcile.run();
  }

  /** Which adapters this build has, and which one is issuing bills. */
  @Get('providers')
  providers(): { active: string; known: string[]; sendsWebhooks: boolean } {
    const active = this.registry.active();
    return { active: active.key, known: this.registry.known(), sendsWebhooks: active.sendsWebhooks };
  }
}
