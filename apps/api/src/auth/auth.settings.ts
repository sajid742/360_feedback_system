import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';

export interface PasswordPolicy {
  minLength: number;
  requireUpper: boolean;
  requireLower: boolean;
  requireNumber: boolean;
  requireSymbol: boolean;
  historyCount: number;
}

export interface LockoutPolicy {
  maxAttempts: number;
  windowMinutes: number;
}

/** Organisation MFA enforcement (F8). 'optional' = per-user opt-in (default);
 *  'required_admins' = privileged users must enrol; 'required_all' = everyone must. */
export interface MfaPolicy {
  mode: 'optional' | 'required_admins' | 'required_all';
}

export interface CaptchaConfig {
  enabled: boolean;
  provider: 'recaptcha' | 'hcaptcha';
  secret: string;
}

export interface SsoProvider {
  id: string;
  type: 'oidc' | 'oauth2';
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string;
  redirectUri: string;
  emailClaim: string;
}

export interface LdapConfig {
  enabled: boolean;
  url: string;
  bindDn: string;
  bindPassword: string;
  searchBase: string;
  searchFilter: string;
  emailAttribute: string;
}

const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 8,
  requireUpper: true,
  requireLower: true,
  requireNumber: true,
  requireSymbol: false,
  historyCount: 5,
};

const DEFAULT_LOCKOUT: LockoutPolicy = { maxAttempts: 5, windowMinutes: 15 };

/** Keep an administrator-supplied number inside an enforceable range. */
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(Number(value) || min)));
const DEFAULT_MFA_POLICY: MfaPolicy = { mode: 'optional' };

/** Reads auth settings from the generic `configurations` store (module='auth'),
 *  falling back to safe defaults. Everything is configurable, never hardcoded. */
@Injectable()
export class AuthSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  passwordPolicy(orgId: string): Promise<PasswordPolicy> {
    return this.read(orgId, 'password_policy', DEFAULT_PASSWORD_POLICY);
  }

  lockout(orgId: string): Promise<LockoutPolicy> {
    return this.read(orgId, 'lockout', DEFAULT_LOCKOUT);
  }

  mfaPolicy(orgId: string): Promise<MfaPolicy> {
    return this.read(orgId, 'mfa_policy', DEFAULT_MFA_POLICY);
  }

  /** Upsert the org MFA policy in the generic config store (module='auth'). */
  async setMfaPolicy(orgId: string, actorUserId: string, mode: MfaPolicy['mode']): Promise<MfaPolicy> {
    await this.write(orgId, actorUserId, 'mfa_policy', { mode });
    return { mode };
  }

  /**
   * Set the org password policy (F2).
   *
   * These values were already read and enforced at runtime by `PasswordService`,
   * but the only way to change them was the raw key/value `POST /configuration`
   * endpoint — so in practice an administrator could not adjust their own
   * organisation's password rules without developer help. Values are clamped to a
   * sane, enforceable range: a policy that cannot be satisfied would lock every
   * user out of setting a password.
   */
  async setPasswordPolicy(orgId: string, actorUserId: string, input: Partial<PasswordPolicy>): Promise<PasswordPolicy> {
    const current = await this.passwordPolicy(orgId);
    const merged: PasswordPolicy = {
      minLength: clamp(input.minLength ?? current.minLength, 6, 64),
      requireUpper: input.requireUpper ?? current.requireUpper,
      requireLower: input.requireLower ?? current.requireLower,
      requireNumber: input.requireNumber ?? current.requireNumber,
      requireSymbol: input.requireSymbol ?? current.requireSymbol,
      historyCount: clamp(input.historyCount ?? current.historyCount, 0, 24),
    };
    await this.write(orgId, actorUserId, 'password_policy', merged);
    return merged;
  }

  /**
   * Set the org lockout policy (F2). `maxAttempts` has a floor of 3 so a
   * misconfiguration cannot lock users out on a single typo, and `windowMinutes`
   * is capped at a day so an operator cannot accidentally create an effectively
   * permanent lockout.
   */
  async setLockout(orgId: string, actorUserId: string, input: Partial<LockoutPolicy>): Promise<LockoutPolicy> {
    const current = await this.lockout(orgId);
    const merged: LockoutPolicy = {
      maxAttempts: clamp(input.maxAttempts ?? current.maxAttempts, 3, 20),
      windowMinutes: clamp(input.windowMinutes ?? current.windowMinutes, 1, 1440),
    };
    await this.write(orgId, actorUserId, 'lockout', merged);
    return merged;
  }

  /** Find-then-update/create — the configurations unique index is partial, so no upsert. */
  private async write(orgId: string, actorUserId: string, key: string, value: object): Promise<void> {
    const existing = await this.prisma.configuration.findFirst({
      where: { organizationId: orgId, module: 'auth', key, deletedAt: null },
      select: { id: true },
    });
    const json = value as unknown as Prisma.InputJsonValue;
    if (existing) {
      await this.prisma.configuration.update({ where: { id: existing.id }, data: { value: json, updatedBy: actorUserId } });
    } else {
      await this.prisma.configuration.create({
        data: { organizationId: orgId, module: 'auth', key, value: json, createdBy: actorUserId, updatedBy: actorUserId },
      });
    }
  }

  captcha(orgId: string): Promise<CaptchaConfig | null> {
    return this.read<CaptchaConfig | null>(orgId, 'captcha', null);
  }

  ldap(orgId: string): Promise<LdapConfig | null> {
    return this.read<LdapConfig | null>(orgId, 'ldap', null);
  }

  async ssoProvider(orgId: string, providerId: string): Promise<SsoProvider | null> {
    const config = await this.read<{ providers: SsoProvider[] } | null>(orgId, 'sso', null);
    return config?.providers.find((p) => p.id === providerId) ?? null;
  }

  private async read<T>(orgId: string, key: string, fallback: T): Promise<T> {
    const row = await this.prisma.configuration.findFirst({
      where: { organizationId: orgId, module: 'auth', key, deletedAt: null },
      select: { value: true },
    });
    if (!row) return fallback;
    const value = row.value as unknown;
    if (fallback && typeof fallback === 'object' && value && typeof value === 'object') {
      return { ...fallback, ...(value as object) } as T;
    }
    return (value as T) ?? fallback;
  }
}
