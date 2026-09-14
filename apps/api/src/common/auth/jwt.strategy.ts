import { Injectable, UnauthorizedException } from '@nestjs/common';
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
    /*
     * SINGLE-PURPOSE TOKENS ARE NOT ACCESS TOKENS.
     *
     * The SSO state and the MFA challenge are signed by the same JwtService with the
     * same key, so before this check they verified here perfectly well — and an SSO
     * state carries the target tenant's `organizationId` with no `sub`, which any
     * route guarded only by JwtAuthGuard would then act on. Access tokens have never
     * carried a `purpose` claim, so refusing one is exact rather than heuristic.
     */
    if ((payload as { purpose?: unknown }).purpose !== undefined) {
      throw new UnauthorizedException('This token cannot be used to authenticate a request.');
    }
    // A token with no subject is not a user. Several services scope by `userId` alone,
    // and an undefined value is dropped by Prisma rather than matching nothing.
    if (!payload.sub) throw new UnauthorizedException('Malformed token.');
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
