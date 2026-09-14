import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { AuditModule } from '../common/audit/audit.module';
import { CommunicationModule } from '../communication/communication.module';
import { PlatformAdminGuard } from '../platform/platform-admin.guard';
import { BillingController } from './billing.controller';
import { BillingPlatformController } from './billing-platform.controller';
import { BillingWebhookController } from './billing-webhook.controller';
import { BillingService } from './billing.service';
import { BillingPlatformService } from './billing-platform.service';
import { BillingNotifyService } from './billing-notify.service';
import { BillingWebhookService } from './billing-webhook.service';
import { BillingLifecycleService } from './billing-lifecycle.service';
import { InvoiceBillingProvider } from './providers/invoice.provider';
import { OneBillProvider } from './providers/onebill.provider';
import { BillingProviderRegistry, billingProviderFactory } from './providers/provider.registry';
import { BillingReconcileService } from './billing-reconcile.service';

/**
 * Billing.
 *
 * Adapters are registered here and selected by `BILLING_PROVIDER` through the
 * `BILLING_PROVIDER` token. Two exist: invoice-and-bank-transfer, and 1BILL through a
 * billing partner. Adding a third is one class implementing `BillingProvider`, one line
 * in the registry and one in the factory; nothing outside this module changes.
 *
 * The registry is separate from the selected provider on purpose. What this installation
 * ISSUES with is one adapter; what an inbound callback must be VERIFIED with is whichever
 * adapter sent it, which during a provider migration is not the same thing.
 *
 * `EntitlementService` arrives through the global LicenseModule, so a payment can
 * invalidate the entitlement cache the moment it lands.
 */
@Module({
  imports: [PrismaModule, AuditModule, CommunicationModule],
  controllers: [BillingController, BillingPlatformController, BillingWebhookController],
  providers: [
    BillingService,
    BillingPlatformService,
    BillingNotifyService,
    BillingWebhookService,
    BillingLifecycleService,
    InvoiceBillingProvider,
    OneBillProvider,
    billingProviderFactory,
    BillingProviderRegistry,
    BillingReconcileService,
    PlatformAdminGuard,
  ],
  exports: [BillingService, BillingProviderRegistry],
})
export class BillingModule {}
