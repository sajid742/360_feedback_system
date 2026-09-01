import { CanActivate, type ExecutionContext, Injectable, NotFoundException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from '../common/auth/current-user';
import { LicenseService } from './license.service';
import type { LicensedModule } from './license.types';

export const LICENSED_MODULE_KEY = 'licensedModule';

/**
 * Marks a controller (or one route) as belonging to a licensed module.
 *
 *   @RequiresLicensedModule('sis_integration')
 *
 * LICENSING vs RBAC — the distinction this enforces. RBAC answers "may THIS USER do
 * it?"; the licence answers "did this ORGANISATION buy it?". Both must say yes. A user
 * with every SIS permission still gets nothing if the licence does not include SIS.
 */
export const RequiresLicensedModule = (module: LicensedModule): MethodDecorator & ClassDecorator =>
  SetMetadata(LICENSED_MODULE_KEY, module);

/**
 * Responds 404, not 403 — the same shape as a route that does not exist.
 *
 * This mirrors the existing AiEnabledGuard deliberately: a module the customer has not
 * licensed should look absent rather than withheld, and 403 would confirm it is there.
 */
@Injectable()
export class LicensedFeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly license: LicenseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const module = this.reflector.getAllAndOverride<LicensedModule | undefined>(LICENSED_MODULE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!module) return true;
    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    // Unauthenticated callers are the auth guards' problem, not this one's.
    if (!user?.organizationId) return true;
    if (await this.license.hasModule(user.organizationId, module)) return true;
    throw new NotFoundException('This module is not included in your licence.');
  }
}
