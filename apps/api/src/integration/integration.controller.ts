import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { LicensedFeatureGuard, RequiresLicensedModule } from '../license/licensed-feature.guard';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../common/auth/permissions.guard';
import { RequirePermissions } from '../common/auth/require-permissions.decorator';
import { CurrentUser, ReqContext, type AuthUser, type RequestContext } from '../common/auth/current-user';
import { ApiKeyService } from './services/api-key.service';
import { WebhookService } from './services/webhook.service';
import { CreateApiKeyDto, CreateWebhookDto, UpdateWebhookDto } from './dto/integration.dto';
import { INTEGRATION_PERMISSIONS as P } from './integration.permissions';
import { reportsApiDoc } from './reports-api.scopes';

@RequiresLicensedModule('api_access')
@Controller('integration')
@UseGuards(JwtAuthGuard, PermissionsGuard, LicensedFeatureGuard)
export class IntegrationController {
  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly webhooks: WebhookService,
  ) {}

  // -------- External Reports API documentation (for the admin UI) --------

  /** The external Reports API contract: scopes, endpoints, params, auth — used by the
   *  key-creation scope picker and the admin API documentation page. Contains no secrets. */
  @Get('reports-api/catalog')
  @RequirePermissions(P.read)
  reportsApiCatalog() {
    return reportsApiDoc();
  }

  // -------- API keys --------

  @Get('api-keys')
  @RequirePermissions(P.read)
  listKeys(@CurrentUser() user: AuthUser) {
    return this.apiKeys.list(user);
  }

  @Post('api-keys')
  @RequirePermissions(P.manage)
  createKey(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Body() dto: CreateApiKeyDto) {
    return this.apiKeys.create(user, ctx, dto);
  }

  @Delete('api-keys/:id')
  @RequirePermissions(P.manage)
  async revokeKey(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.apiKeys.revoke(user, ctx, id);
    return { id, revoked: true };
  }

  // -------- Webhooks --------

  @Get('webhooks')
  @RequirePermissions(P.read)
  listWebhooks(@CurrentUser() user: AuthUser) {
    return this.webhooks.list(user);
  }

  @Post('webhooks')
  @RequirePermissions(P.manage)
  createWebhook(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Body() dto: CreateWebhookDto) {
    return this.webhooks.create(user, ctx, dto);
  }

  @Put('webhooks/:id')
  @RequirePermissions(P.manage)
  updateWebhook(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWebhookDto,
  ) {
    return this.webhooks.update(user, ctx, id, dto);
  }

  @Delete('webhooks/:id')
  @RequirePermissions(P.manage)
  async deleteWebhook(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.webhooks.remove(user, ctx, id);
    return { id, deleted: true };
  }

  @Get('webhooks/:id/deliveries')
  @RequirePermissions(P.read)
  webhookDeliveries(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.webhooks.deliveries(user, id);
  }

  @Post('webhooks/:id/test')
  @RequirePermissions(P.manage)
  testWebhook(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.webhooks.test(user, id);
  }
}
