import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../common/auth/permissions.guard';
import { RequirePermissions } from '../common/auth/require-permissions.decorator';
import { CurrentUser, ReqContext, type AuthUser, type RequestContext } from '../common/auth/current-user';
import { CONFIG_PERMISSIONS } from '../config/config.permissions';
import { BillingService } from './billing.service';
import { CancelDto, CheckoutDto } from './billing.dto';

/**
 * The tenant's own billing surface.
 *
 * Gated on `configuration.read` to look and `configuration.manage` to act — the same
 * permissions that already gate the Licence and Settings screens, so no new permission
 * enters the catalogue and no role has to be re-cut.
 *
 * An organisation administrator can SELECT a plan and CANCEL. They cannot mark
 * anything paid: that is a platform act, deliberately on the other side of the
 * boundary, because a tenant that could record its own payment could grant itself any
 * plan it liked.
 *
 * Every route is scoped by the organisation on the token. No route takes an
 * organisation id.
 */
@Controller('billing')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** Everything the subscription screen renders, in one call. */
  @Get('summary')
  @RequirePermissions(CONFIG_PERMISSIONS.read)
  summary(@CurrentUser() user: AuthUser) {
    return this.billing.summary(user);
  }

  @Get('invoices')
  @RequirePermissions(CONFIG_PERMISSIONS.read)
  invoices(@CurrentUser() user: AuthUser) {
    return this.billing.invoices(user.organizationId);
  }

  @Get('invoices/:id')
  @RequirePermissions(CONFIG_PERMISSIONS.read)
  invoice(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.billing.invoice(user.organizationId, id);
  }

  @Get('payments')
  @RequirePermissions(CONFIG_PERMISSIONS.read)
  payments(@CurrentUser() user: AuthUser) {
    return this.billing.payments(user.organizationId);
  }

  /**
   * Choose a plan. Free plans apply at once; a paid plan issues an invoice and returns
   * how to pay it. The plan itself changes when the payment is recorded.
   */
  @Post('checkout')
  @HttpCode(200)
  @RequirePermissions(CONFIG_PERMISSIONS.manage)
  async checkout(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Body() dto: CheckoutDto) {
    const r = await this.billing.checkout(user, ctx, dto);
    // BigInt cannot be serialised to JSON; the amount crosses as a number of minor units.
    return { ...r, amountMinor: Number(r.amountMinor) };
  }

  @Post('cancel')
  @HttpCode(200)
  @RequirePermissions(CONFIG_PERMISSIONS.manage)
  cancel(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Body() dto: CancelDto) {
    return this.billing.cancel(user, ctx, dto.reason);
  }

  @Post('reactivate')
  @HttpCode(200)
  @RequirePermissions(CONFIG_PERMISSIONS.manage)
  reactivate(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.billing.reactivate(user, ctx);
  }
}
