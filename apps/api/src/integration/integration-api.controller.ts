import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../common/auth/current-user';
import { ApiKeyGuard } from './api-key.guard';

/**
 * Public programmatic surface authenticated by `X-Api-Key` (not JWT). This
 * demonstrates key-based access; real integrations would expose read models
 * here. Guarded solely by ApiKeyGuard so external systems never need a login.
 */
@Controller('integration/v1')
@UseGuards(ApiKeyGuard)
export class IntegrationApiController {
  @Get('whoami')
  whoami(@CurrentUser() user: AuthUser) {
    return { organizationId: user.organizationId, scopes: user.permissions, authenticatedVia: 'api-key' };
  }
}
