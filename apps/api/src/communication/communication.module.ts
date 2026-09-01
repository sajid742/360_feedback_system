import { Module } from '@nestjs/common';
import { CommunicationController } from './communication.controller';
import { RedirectController } from './redirect.controller';
import { CommunicationSettingsService } from './communication.settings';
import { ProviderFactory } from './providers/provider.factory';
import { DeliveryQueue } from './services/delivery-queue.service';
import { NotificationService } from './services/notification.service';
import { OtpService } from './services/otp.service';
import { CampaignService } from './services/campaign.service';
import { ShortLinkService } from './services/short-link.service';
import { QrService } from './services/qr.service';
import { TemplateService } from './services/template.service';
import { DispatchService } from './services/dispatch.service';
import { UserNotificationModule } from '../user-notifications/user-notification.module';
import { PublicBrandingController } from './public-branding.controller';

/**
 * Communication Gateway: single layer for Email/SMS/WhatsApp with per-org
 * swappable providers, OTP, campaigns, short links, QR, and a Redis-backed
 * (BullMQ) delivery queue that degrades to inline delivery without Redis.
 */
@Module({
  imports: [UserNotificationModule],
  controllers: [CommunicationController, RedirectController, PublicBrandingController],
  providers: [
    CommunicationSettingsService,
    ProviderFactory,
    DeliveryQueue,
    NotificationService,
    OtpService,
    CampaignService,
    ShortLinkService,
    QrService,
    TemplateService,
    DispatchService,
  ],
  exports: [NotificationService, OtpService, TemplateService, DispatchService, CommunicationSettingsService],
})
export class CommunicationModule {}
