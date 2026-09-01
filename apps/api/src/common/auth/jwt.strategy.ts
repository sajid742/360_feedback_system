import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AuthUser, DataScope } from './current-user';

interface JwtPayload {
  sub: string;
  organizationId: string;
  email: string;
  permissions: string[];
  scope?: DataScope;
  employeeId?: string | null;
  mustChangePassword?: boolean;
  mustEnrollMfa?: boolean;
}

/**
 * Validates the access token and populates request.user with AuthUser. Permissions
 * are embedded in the token, so PermissionsGuard needs no DB hit. The full
 * Authentication module extends token issuance (refresh rotation, MFA, SSO); this
 * strategy only verifies the access token.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_ACCESS_SECRET ?? 'change-me',
    });
  }

  validate(payload: JwtPayload): AuthUser {
    return {
      userId: payload.sub,
      organizationId: payload.organizationId,
      email: payload.email,
      permissions: payload.permissions ?? [],
      // Older tokens (pre-RBAC) default to organization scope so nothing breaks mid-rollout.
      scope: payload.scope ?? 'organization',
      employeeId: payload.employeeId ?? null,
      mustChangePassword: payload.mustChangePassword ?? false,
      mustEnrollMfa: payload.mustEnrollMfa ?? false,
    };
  }
}
