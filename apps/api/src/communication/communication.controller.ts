import { Body, Controller, Get, HttpCode, Post, Query, Req, UseGuards, type RawBodyRequest } from '@nestjs/common';
import { LicensedFeatureGuard, RequiresLicensedModule } from '../license/licensed-feature.guard';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../common/auth/permissions.guard';
import { RequirePermissions } from '../common/auth/require-permissions.decorator';
import { CurrentUser, ReqContext, type AuthUser, type RequestContext } from '../common/auth/current-user';
import { NotificationService } from './services/notification.service';
import { OtpService } from './services/otp.service';
import { CampaignService } from './services/campaign.service';
import { ShortLinkService } from './services/short-link.service';
import { QrService } from './services/qr.service';
import { TemplateService } from './services/template.service';
import { CommunicationSettingsService } from './communication.settings';
import { COMM_EVENT_LIST, COMM_PLACEHOLDERS, ALL_CHANNELS } from './comm.events';
import { COMM_PERMISSIONS } from './communication.permissions';
import { EntitlementService } from '../license/entitlement.service';
import {
  BrandingDto,
  CreateCampaignDto,
  CreateShortLinkDto,
  DefaultsDto,
  OtpRequestDto,
  OtpVerifyDto,
  ProviderSettingsDto,
  ResetTemplateDto,
  SendMessageDto,
  TestSendDto,
  UpsertTemplateDto,
  WebhookDto,
} from './communication.dto';

@RequiresLicensedModule('communication')
// Class-level: this controller guards per method, so the licence guard is attached
// here once. It is a no-op for the unauthenticated webhook route, which has no user.
@UseGuards(LicensedFeatureGuard)
@Controller('communication')
export class CommunicationController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly otp: OtpService,
    private readonly campaigns: CampaignService,
    private readonly shortLinks: ShortLinkService,
    private readonly qr: QrService,
    private readonly templates: TemplateService,
    private readonly settings: CommunicationSettingsService,
    private readonly entitlements: EntitlementService,
  ) {}

  @Post('send')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(COMM_PERMISSIONS.send)
  send(@CurrentUser() user: AuthUser, @Body() dto: SendMessageDto) {
    return this.notifications.send(user.organizationId, user.userId, dto);
  }

  @Get('notifications')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(COMM_PERMISSIONS.read)
  list(@CurrentUser() user: AuthUser) {
    return this.notifications.list(user);
  }

  @Post('otp/request')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(COMM_PERMISSIONS.send)
  requestOtp(@CurrentUser() user: AuthUser, @Body() dto: OtpRequestDto) {
    return this.otp.request(user.organizationId, dto.identifier, dto.channel, dto.purpose);
  }

  @Post('otp/verify')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(COMM_PERMISSIONS.send)
  verifyOtp(@CurrentUser() user: AuthUser, @Body() dto: OtpVerifyDto) {
    return this.otp.verify(user.organizationId, dto.identifier, dto.purpose, dto.code);
  }

  @Get('campaigns')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(COMM_PERMISSIONS.read)
  listCampaigns(@CurrentUser() user: AuthUser) {
    return this.campaigns.list(user);
  }

  @Post('campaigns')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(COMM_PERMISSIONS.campaignManage)
  createCampaign(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Body() dto: CreateCampaignDto) {
    return this.campaigns.create(user, ctx, dto);
  }

  @Get('short-links')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(COMM_PERMISSIONS.read)
  listLinks(@CurrentUser() user: AuthUser) {
    return this.shortLinks.list(user);
  }

  @Post('short-links')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(COMM_PERMISSIONS.send)
  createLink(@CurrentUser() user: AuthUser, @Body() dto: CreateShortLinkDto) {
    return this.shortLinks.create(user, dto.targetUrl);
  }

  @Get('qr')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(COMM_PERMISSIONS.read)
  async qrCode(@Query('text') text: string) {
    return { dataUrl: await this.qr.dataUrl(text) };
  }

  /* ----------------------------- Templates (v2) ---------------------------- */

  /** Catalogue for the admin editor: events, placeholders and channels. */
  @Get('meta')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(COMM_PERMISSIONS.manage)
  meta() {
    return { events: COMM_EVENT_LIST, placeholders: COMM_PLACEHOLDERS, channels: ALL_CHANNELS };
  }

  @Get('templates')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(COMM_PERMISSIONS.manage)
  listTemplates(@CurrentUser() user: AuthUser) {
    return this.templates.list(user.organizationId);
  }

  @Post('templates')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(COMM_PERMISSIONS.manage)
  upsertTemplate(@CurrentUser() user: AuthUser, @Body() dto: UpsertTemplateDto) {
    return this.templates.upsert(user.organizationId, user.userId, dto.event, dto.channel, {
      subject: dto.subject,
      body: dto.body,
      isActive: dto.isActive,
    });
  }

  @Post('templates/reset')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(COMM_PERMISSIONS.manage)
  resetTemplate(@CurrentUser() user: AuthUser, @Body() dto: ResetTemplateDto) {
    return this.templates.reset(user.organizationId, dto.event, dto.channel);
  }

  /* --------------------------- Settings (v2) ------------------------------- */

  @Get('settings')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(COMM_PERMISSIONS.manage)
  async getSettings(@CurrentUser() user: AuthUser) {
    const [providers, branding, defaults] = await Promise.all([
      this.settings.snapshot(user.organizationId),
      this.templates.branding(user.organizationId),
      this.templates.defaults(user.organizationId),
    ]);
    return { providers, branding, defaults };
  }

  @Post('settings/providers')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(COMM_PERMISSIONS.manage)
  async saveProviders(@CurrentUser() user: AuthUser, @Body() dto: ProviderSettingsDto) {
    if (dto.email) await this.settings.saveEmail(user.organizationId, user.userId, dto.email);
    if (dto.sms) await this.settings.saveSms(user.organizationId, user.userId, dto.sms);
    if (dto.whatsapp) await this.settings.saveWhatsapp(user.organizationId, user.userId, dto.whatsapp);
    if (dto.general) await this.settings.saveGeneral(user.organizationId, user.userId, dto.general);
    return this.settings.snapshot(user.organizationId);
  }

  @Post('settings/branding')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(COMM_PERMISSIONS.manage)
  async saveBranding(@CurrentUser() user: AuthUser, @Body() dto: BrandingDto) {
    /*
     * White-labelling in three steps, because the middle one is a real commercial
     * position: `none` is our product unchanged, `logo` is the customer's mark and
     * colours on our product name, and `full` renames the product itself.
     *
     * The product-identity fields are therefore checked separately from the visual
     * ones — a plan that allows a logo must not quietly allow a rename.
     */
    await this.entitlements.assertBrandingLevel(user.organizationId, 'logo');
    const renames = dto.appName || dto.shortName || dto.legalName || dto.tagline;
    if (renames) await this.entitlements.assertBrandingLevel(user.organizationId, 'full');
    return this.templates.setBranding(user.organizationId, user.userId, dto);
  }

  @Post('settings/defaults')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(COMM_PERMISSIONS.manage)
  saveDefaults(@CurrentUser() user: AuthUser, @Body() dto: DefaultsDto) {
    return this.templates.setDefaults(user.organizationId, user.userId, dto.value);
  }

  /** Send a fixed test message on a channel to confirm provider credentials. */
  @Post('settings/test')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(COMM_PERMISSIONS.manage)
  testSend(@CurrentUser() user: AuthUser, @Body() dto: TestSendDto) {
    // Bypasses the enable/disable switch so credentials can be validated first.
    return this.notifications.test(user.organizationId, user.userId, {
      channel: dto.channel,
      recipient: dto.recipient,
      subject: dto.channel === 'sms' ? undefined : 'Test message',
      body: 'This is a test message from your 360° Feedback System communication settings.',
    });
  }

  /**
   * Provider delivery-status webhook (F5).
   *
   * Public by necessity, so the caller must present `X-Webhook-Signature:
   * sha256=<hex>` — an HMAC-SHA256 of the raw request body keyed with the
   * organisation's webhook secret. Unsigned or mis-signed callbacks are
   * rejected with 401 and nothing is written. `X-Hub-Signature-256` (Meta) and
   * `X-Twilio-Signature` are accepted as aliases so the common providers work
   * without a translation layer.
   */
  @Post('webhooks/:provider')
  @HttpCode(200)
  async webhook(@Req() req: RawBodyRequest<{ headers: Record<string, string | undefined> }>, @Body() dto: WebhookDto) {
    const headers = req.headers;
    const signature =
      headers['x-webhook-signature'] ?? headers['x-hub-signature-256'] ?? headers['x-twilio-signature'];
    await this.notifications.applyWebhook(dto.providerMessageId, dto.status, signature, req.rawBody);
    return { received: true };
  }
}
