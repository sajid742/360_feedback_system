import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { AuthUser } from '../common/auth/current-user';
import { ApiKeyService } from './services/api-key.service';

/**
 * Authenticates a request via the `X-Api-Key` header (programmatic access).
 * On success it packs a synthetic AuthUser onto the request so downstream
 * handlers and PermissionsGuard behave exactly as with a JWT — the key's
 * scopes become the principal's permissions.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly apiKeys: ApiKeyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined>; user?: AuthUser }>();
    const header = request.headers['x-api-key'];
    const presented = Array.isArray(header) ? header[0] : header;
    const validated = await this.apiKeys.validate(presented ?? '');
    if (!validated) throw new UnauthorizedException('Invalid or expired API key.');

    request.user = {
      userId: `api-key:${validated.id}`,
      organizationId: validated.organizationId,
      email: 'api-key',
      permissions: validated.scopes,
      scope: 'organization',
      employeeId: null,
      mustChangePassword: false,
      mustEnrollMfa: false,
    };
    return true;
  }
}
