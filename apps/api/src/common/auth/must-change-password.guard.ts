import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

/**
 * Global guard that enforces a forced password change. When a user's access token
 * carries `mustChangePassword: true` (set by an admin reset or a temporary-password
 * onboarding), every request is rejected EXCEPT the small allow-list needed to
 * actually change the password or sign out. This is server-side enforcement, so it
 * holds regardless of the frontend.
 *
 * It decodes the bearer token itself (independent of guard ordering); requests with
 * no/invalid token, or without the flag, pass straight through to the route's own
 * guards.
 */
const PASSWORD_ALLOWED = [
  '/auth/password/set-initial',
  '/auth/password/change',
  '/auth/logout',
  '/auth/me',
  '/auth/mfa/status',
  '/auth/mfa/setup',
  '/auth/mfa/enable',
  '/auth/mfa/disable',
];
// A user who must enrol in MFA may only reach the enrolment + session endpoints (F8).
const MFA_ENROLL_ALLOWED = [
  '/auth/logout',
  '/auth/me',
  '/auth/mfa/status',
  '/auth/mfa/setup',
  '/auth/mfa/enable',
];

interface MinimalPayload {
  mustChangePassword?: boolean;
  mustEnrollMfa?: boolean;
}

@Injectable()
export class MustChangePasswordGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; originalUrl?: string; url?: string }>();
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) return true;

    let payload: MinimalPayload;
    try {
      payload = this.jwt.verify<MinimalPayload>(auth.slice(7));
    } catch {
      return true; // invalid/expired token — let the route's JwtAuthGuard produce the 401
    }
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    if (payload?.mustChangePassword) {
      if (PASSWORD_ALLOWED.some((s) => path.endsWith(s))) return true;
      throw new ForbiddenException('You must set a new password before continuing.');
    }
    if (payload?.mustEnrollMfa) {
      if (MFA_ENROLL_ALLOWED.some((s) => path.endsWith(s))) return true;
      throw new ForbiddenException('You must set up multi-factor authentication before continuing.');
    }
    return true;
  }
}
