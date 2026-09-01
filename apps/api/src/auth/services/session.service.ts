import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/auth/current-user';

/** Session (= refresh token) and trusted-device management. */
@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Active sessions, newest first (F25). Capped: every sign-in creates a refresh
   * token, so a long-lived account accumulates hundreds and the Security page became
   * an unreadable wall. "Sign out everywhere" still revokes all of them, not just
   * the ones shown here.
   */
  async listSessions(user: AuthUser): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.refreshToken.findMany({
      where: { userId: user.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((row) => ({
      id: row.id,
      ip: row.ip,
      userAgent: row.userAgent,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    }));
  }

  async revokeSession(user: AuthUser, id: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { id, userId: user.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async listDevices(user: AuthUser): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.trustedDevice.findMany({
      where: { userId: user.userId },
      orderBy: { lastSeenAt: 'desc' },
    });
    return rows.map((row) => ({ id: row.id, label: row.label, lastSeenAt: row.lastSeenAt }));
  }
}
