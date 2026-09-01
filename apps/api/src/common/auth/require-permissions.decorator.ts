import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'requiredPermissions';

/**
 * Attaches required permission codes to a route. Codes are DATA (rows in the
 * `permissions` table resolved via `role_permissions`) — never hardcoded role
 * names (PROMPTS.md / handoff §6). Provided by the Configuration foundation.
 */
export const RequirePermissions = (...permissions: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_KEY, permissions);
