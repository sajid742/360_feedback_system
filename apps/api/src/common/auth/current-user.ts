import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

/**
 * Authenticated principal packed onto the request by the JWT strategy.
 * `permissions` are embedded in the access token so PermissionsGuard needs no
 * DB hit per request (handoff §6). Provided by the Configuration foundation.
 */
export type DataScope = 'organization' | 'reporting' | 'own';

export interface AuthUser {
  userId: string;
  organizationId: string;
  email: string;
  permissions: string[];
  /** RBAC data scope for record-level restriction (defaults to 'organization' for older tokens). */
  scope: DataScope;
  /** The user's employee id, anchor for reporting/own scoping (null if the user has no employee). */
  employeeId: string | null;
  /** When true the user must set a new password before using the app (admin reset / temp password). */
  mustChangePassword: boolean;
  /** When true the user must enrol in MFA before using the app (org MFA policy). */
  mustEnrollMfa: boolean;
}

export interface RequestContext {
  ip: string | null;
  device: string | null;
}

/** @CurrentUser() — reads the validated principal off the request. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest<{ user: AuthUser }>();
    return request.user;
  },
);

/** @ReqContext() — IP + user-agent for audit records. */
export const ReqContext = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestContext => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ ip?: string; headers: Record<string, string | undefined> }>();
    return {
      ip: request.ip ?? null,
      device: request.headers['user-agent'] ?? null,
    };
  },
);
