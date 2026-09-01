import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthSettingsService, type PasswordPolicy } from '../auth.settings';
import type { AuthUser } from '../../common/auth/current-user';
import { sha256 } from '../crypto/secret-crypto';
import { CommunicationSettingsService } from '../../communication/communication.settings';
import { NotificationService } from '../../communication/services/notification.service';

/** Minutes a self-service password-reset link stays valid. */
const RESET_TTL_MIN = Number(process.env.PASSWORD_RESET_TTL_MIN ?? 30);
/** Invitations are handed out during onboarding, so they live longer than a reset. */
const INVITE_TTL_HOURS = Number(process.env.INVITE_TTL_HOURS ?? 72);

@Injectable()
export class PasswordService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AuthSettingsService,
    private readonly notifications: NotificationService,
    private readonly commSettings: CommunicationSettingsService,
  ) {}

  validate(password: string, policy: PasswordPolicy): void {
    const failures: string[] = [];
    if (password.length < policy.minLength) failures.push(`at least ${policy.minLength} characters`);
    if (policy.requireUpper && !/[A-Z]/.test(password)) failures.push('an uppercase letter');
    if (policy.requireLower && !/[a-z]/.test(password)) failures.push('a lowercase letter');
    if (policy.requireNumber && !/[0-9]/.test(password)) failures.push('a number');
    if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password)) failures.push('a symbol');
    if (failures.length > 0) {
      throw new BadRequestException(`Password must contain ${failures.join(', ')}.`);
    }
  }

  async changePassword(
    user: AuthUser,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const record = await this.prisma.user.findFirstOrThrow({
      where: { id: user.userId },
      select: { passwordHash: true },
    });
    if (!record.passwordHash || !(await bcrypt.compare(currentPassword, record.passwordHash))) {
      throw new UnauthorizedException('Current password is incorrect.');
    }
    const policy = await this.settings.passwordPolicy(user.organizationId);
    this.validate(newPassword, policy);
    await this.assertNotReused(user.userId, newPassword, policy.historyCount);
    await this.setPassword(user.userId, newPassword);
    await this.clearMustChange(user.userId);
  }

  /**
   * Set a new password for the *currently authenticated* user without requiring the
   * current one — used only on the forced "set a new password" screen after login
   * with a temporary password. The user is already authenticated (JWT), and the
   * must-change guard restricts them to this action, so re-entering the temp
   * password would be redundant.
   */
  async setInitialPassword(user: AuthUser, newPassword: string): Promise<void> {
    const policy = await this.settings.passwordPolicy(user.organizationId);
    this.validate(newPassword, policy);
    await this.assertNotReused(user.userId, newPassword, policy.historyCount);
    await this.setPassword(user.userId, newPassword);
    await this.clearMustChange(user.userId);
  }

  /**
   * Admin-initiated reset: set a (temporary) password for another user, optionally
   * forcing a change at next login, and revoke that user's active sessions. The
   * caller (RBAC) has already verified same-organisation access and records the audit.
   */
  async adminSetPassword(orgId: string, targetUserId: string, newPassword: string, requireChange: boolean): Promise<void> {
    const policy = await this.settings.passwordPolicy(orgId);
    this.validate(newPassword, policy);
    await this.setPassword(targetUserId, newPassword);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: targetUserId }, data: { mustChangePassword: requireChange } }),
      this.prisma.refreshToken.updateMany({ where: { userId: targetUserId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
  }

  /**
   * Self-service forgot-password. Anti-enumeration: this ALWAYS resolves without
   * revealing whether the account exists. If a matching active user is found, a
   * single-use, time-limited token is created (only its SHA-256 hash is stored) and
   * a reset link is emailed via the organisation's configured email provider.
   */
  async requestReset(orgSlug: string, email: string, appBaseUrl: string): Promise<void> {
    const org = await this.prisma.organization.findFirst({ where: { slug: orgSlug, deletedAt: null }, select: { id: true } });
    if (!org) return;
    const user = await this.prisma.user.findFirst({
      where: { organizationId: org.id, email: email.toLowerCase(), deletedAt: null, status: 'active' },
      select: { id: true, email: true, fullName: true },
    });
    if (!user) return;
    const raw = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + RESET_TTL_MIN * 60_000);
    await this.prisma.passwordResetToken.create({
      data: { organizationId: org.id, userId: user.id, tokenHash: sha256(raw), expiresAt },
    });
    // Same authority as every other outbound link: the tenant's configured public URL,
    // then PUBLIC_APP_URL. `appBaseUrl` (the request's own origin) is only a last resort,
    // because on a server it is whatever host the admin happened to browse from.
    const resolved = (await this.commSettings.general(org.id)).publicBaseUrl;
    const base = (resolved || appBaseUrl || 'http://localhost:5173').replace(/\/+$/, '');
    const link = `${base}/reset-password?token=${raw}&org=${encodeURIComponent(orgSlug)}`;
    const body =
      `Hello ${user.fullName ?? ''},\n\n` +
      `We received a request to reset your password. Use the link below to choose a new one. ` +
      `It is valid for ${RESET_TTL_MIN} minutes and can be used once.\n\n${link}\n\n` +
      `If you did not request this, you can safely ignore this email — your password will not change.`;
    // Fire-and-forget: never block the request on email delivery, and keep the
    // response time constant regardless of whether the account exists (anti-enumeration).
    // sendDirect delivers inline so it works with or without Redis.
    void this.notifications
      .sendDirect(org.id, null, {
        channel: 'email',
        recipient: user.email,
        subject: 'Reset your password',
        body,
        templateKey: 'password.reset',
      })
      .catch(() => {
        /* never surface delivery errors to the caller */
      });
  }

  /**
   * Email a new user a link to set their own password (F28).
   *
   * Onboarding previously produced a temporary password that the administrator had
   * to relay out-of-band — over chat, on paper, or in a second email — which is both
   * awkward at scale and a poor way to hand out a credential. This reuses the
   * password-reset token that already exists (single-use, hashed at rest, expiring),
   * so the person sets their own password and the administrator never handles one.
   *
   * Returns whether the message was actually delivered, so the caller can fall back
   * to showing the temporary password when email is not configured or fails —
   * onboarding must never dead-end because of a mail problem.
   */
  async sendInvitation(
    orgId: string,
    userId: string,
    appBaseUrl?: string,
  ): Promise<{ sent: boolean; reason?: string }> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, organizationId: orgId, deletedAt: null },
      select: { id: true, email: true, fullName: true },
    });
    if (!user) return { sent: false, reason: 'User not found.' };
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { slug: true, name: true } });
    if (!org) return { sent: false, reason: 'Organisation not found.' };

    const raw = randomBytes(32).toString('base64url');
    await this.prisma.passwordResetToken.create({
      data: {
        organizationId: orgId,
        userId: user.id,
        tokenHash: sha256(raw),
        expiresAt: new Date(Date.now() + INVITE_TTL_HOURS * 3_600_000),
      },
    });
    // Prefer the tenant's configured public URL (Communication → Providers) so the
    // link works from wherever their users actually reach the app.
    // `configured` is already resolved (tenant override -> PUBLIC_APP_URL -> dev default),
    // so it leads. It used to sit BEHIND appBaseUrl, which meant the caller's origin —
    // often localhost — silently won on a server.
    const configured = (await this.commSettings.general(orgId)).publicBaseUrl;
    const base = (configured || appBaseUrl || 'http://localhost:5173').replace(/\/+$/, '');
    const link = `${base}/reset-password?token=${raw}&org=${encodeURIComponent(org.slug)}`;
    const body =
      `Hello ${user.fullName ?? ''},\n\n` +
      `You have been given access to the 360° Feedback system for ${org.name}.\n\n` +
      `Choose your password using the link below. It is valid for ${INVITE_TTL_HOURS} hours and can be used once:\n\n${link}\n\n` +
      `When you sign in, use the organisation code "${org.slug}" and this email address.\n\n` +
      `If the link has expired, use "Forgot password?" on the sign-in page to get a new one.`;

    try {
      const result = await this.notifications.sendDirect(orgId, null, {
        channel: 'email',
        recipient: user.email,
        subject: `Set up your 360° Feedback account — ${org.name}`,
        body,
        templateKey: 'user.invitation',
      });
      if (result.status === 'sent') return { sent: true };
      return { sent: false, reason: result.status === 'skipped' ? 'Email is not enabled in Communication settings.' : 'Email delivery failed.' };
    } catch (error) {
      return { sent: false, reason: (error as Error).message };
    }
  }

  /** Complete a self-service reset with a token from the emailed link. */
  async resetWithToken(token: string, newPassword: string): Promise<void> {
    const rec = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!rec || rec.usedAt || rec.expiresAt < new Date()) {
      throw new BadRequestException('This reset link is invalid or has expired. Request a new one.');
    }
    const user = await this.prisma.user.findFirst({ where: { id: rec.userId, deletedAt: null }, select: { id: true, organizationId: true } });
    if (!user) throw new BadRequestException('This reset link is invalid or has expired. Request a new one.');
    const policy = await this.settings.passwordPolicy(user.organizationId);
    this.validate(newPassword, policy);
    await this.assertNotReused(user.id, newPassword, policy.historyCount);
    await this.setPassword(user.id, newPassword);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: user.id }, data: { mustChangePassword: false } }),
      this.prisma.passwordResetToken.update({ where: { id: rec.id }, data: { usedAt: new Date() } }),
      this.prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
  }

  private async clearMustChange(userId: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { mustChangePassword: false } });
  }

  /** Hashes, updates the user, and appends to password history. */
  async setPassword(userId: string, newPassword: string): Promise<void> {
    const hash = await bcrypt.hash(newPassword, 10);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash: hash } }),
      this.prisma.passwordHistory.create({ data: { userId, passwordHash: hash } }),
    ]);
  }

  private async assertNotReused(userId: string, password: string, historyCount: number): Promise<void> {
    if (historyCount <= 0) return;
    const history = await this.prisma.passwordHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: historyCount,
      select: { passwordHash: true },
    });
    for (const entry of history) {
      if (await bcrypt.compare(password, entry.passwordHash)) {
        throw new BadRequestException('Password was used recently. Choose a different one.');
      }
    }
  }
}
