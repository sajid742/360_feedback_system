import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { sha256 } from '../crypto/secret-crypto';
import { AuthSettingsService } from '../auth.settings';
import { MfaService } from './mfa.service';

export interface TokenUser {
  id: string;
  organizationId: string;
  email: string;
  fullName: string | null;
}

export type DataScope = 'organization' | 'reporting' | 'own';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  user: TokenUser & { permissions: string[]; scope: DataScope; employeeId: string | null; mustChangePassword: boolean; mustEnrollMfa: boolean };
}

export interface SessionContext {
  ip: string | null;
  userAgent: string | null;
  deviceHash: string | null;
}

const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TTL_DAYS ?? 7);

@Injectable()
export class TokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly settings: AuthSettingsService,
    private readonly mfa: MfaService,
  ) {}

  /**
   * Whether this user must enrol in MFA before using the app (F8), given the org
   * policy and their admin status. A pending password change takes precedence.
   */
  private async computeMustEnrollMfa(
    userId: string,
    orgId: string,
    permissions: string[],
    mustChangePassword: boolean,
  ): Promise<boolean> {
    if (mustChangePassword) return false;
    const [mfaEnabled, policy] = await Promise.all([this.mfa.isEnabled(userId), this.settings.mfaPolicy(orgId)]);
    const isAdmin = permissions.includes('security.rbac.manage');
    const required = policy.mode === 'required_all' || (policy.mode === 'required_admins' && isAdmin);
    return required && !mfaEnabled;
  }

  async resolvePermissions(userId: string): Promise<string[]> {
    const roles = await this.prisma.userRole.findMany({
      where: { userId },
      include: { role: { include: { rolePermissions: true } } },
    });
    return [...new Set(roles.flatMap((ur) => ur.role.rolePermissions.map((rp) => rp.permissionCode)))];
  }

  /**
   * The user's effective data scope (broadest across their roles) and their employee
   * anchor for reporting/own scoping. Embedded in the token so scope checks are cheap.
   */
  async resolveScopeAndEmployee(userId: string): Promise<{ scope: DataScope; employeeId: string | null }> {
    const [roles, employee] = await Promise.all([
      this.prisma.userRole.findMany({ where: { userId }, include: { role: { select: { scope: true } } } }),
      this.prisma.employee.findFirst({ where: { userId, deletedAt: null }, select: { id: true } }),
    ]);
    const rank: Record<string, number> = { organization: 3, reporting: 2, own: 1 };
    let scope: DataScope = 'own';
    for (const ur of roles) {
      const s = (ur.role.scope as DataScope) ?? 'own';
      if ((rank[s] ?? 1) > (rank[scope] ?? 1)) scope = s;
    }
    return { scope, employeeId: employee?.id ?? null };
  }

  async issueSession(user: TokenUser, ctx: SessionContext): Promise<IssuedTokens> {
    const [permissions, sc, flag] = await Promise.all([
      this.resolvePermissions(user.id),
      this.resolveScopeAndEmployee(user.id),
      this.prisma.user.findUnique({ where: { id: user.id }, select: { mustChangePassword: true } }),
    ]);
    const mustChangePassword = flag?.mustChangePassword ?? false;
    const mustEnrollMfa = await this.computeMustEnrollMfa(user.id, user.organizationId, permissions, mustChangePassword);
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      organizationId: user.organizationId,
      email: user.email,
      permissions,
      scope: sc.scope,
      employeeId: sc.employeeId,
      mustChangePassword,
      mustEnrollMfa,
    });
    const refreshToken = await this.createRefresh(user, ctx, null);
    return { accessToken, refreshToken, user: { ...user, permissions, scope: sc.scope, employeeId: sc.employeeId, mustChangePassword, mustEnrollMfa } };
  }

  async rotate(refreshToken: string, ctx: SessionContext): Promise<IssuedTokens> {
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) } });
    if (!record) throw new UnauthorizedException('Invalid session.');

    if (record.revokedAt || record.expiresAt < new Date()) {
      // Reuse of a rotated/expired token — revoke every active session for the user.
      await this.prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Session expired. Please sign in again.');
    }

    const user = await this.prisma.user.findFirstOrThrow({
      where: { id: record.userId, deletedAt: null },
      select: { id: true, organizationId: true, email: true, fullName: true, mustChangePassword: true },
    });
    await this.prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
    const [permissions, sc] = await Promise.all([this.resolvePermissions(user.id), this.resolveScopeAndEmployee(user.id)]);
    const mustEnrollMfa = await this.computeMustEnrollMfa(user.id, user.organizationId, permissions, user.mustChangePassword);
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      organizationId: user.organizationId,
      email: user.email,
      permissions,
      scope: sc.scope,
      employeeId: sc.employeeId,
      mustChangePassword: user.mustChangePassword,
      mustEnrollMfa,
    });
    const newRefresh = await this.createRefresh(user, ctx, record.id);
    return { accessToken, refreshToken: newRefresh, user: { ...user, permissions, scope: sc.scope, employeeId: sc.employeeId, mustEnrollMfa } };
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async createRefresh(
    user: TokenUser,
    ctx: SessionContext,
    replacedTokenId: string | null,
  ): Promise<string> {
    const raw = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000);
    await this.prisma.refreshToken.create({
      data: {
        organizationId: user.organizationId,
        userId: user.id,
        tokenHash: sha256(raw),
        replacedTokenId,
        expiresAt,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        deviceHash: ctx.deviceHash,
      },
    });
    return raw;
  }
}
