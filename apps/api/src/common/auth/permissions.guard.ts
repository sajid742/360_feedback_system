import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from './require-permissions.decorator';
import type { AuthUser } from './current-user';

/**
 * Enforces @RequirePermissions. Permissions are read from the token-embedded
 * AuthUser.permissions (no DB hit). A user needs ALL listed codes. Provided by
 * the Configuration foundation.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const granted = new Set(user?.permissions ?? []);
    const missing = required.filter((code) => !granted.has(code));

    if (missing.length > 0) {
      throw new ForbiddenException(`Missing permission(s): ${missing.join(', ')}`);
    }
    return true;
  }
}
