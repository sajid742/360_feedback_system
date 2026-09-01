import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { AuthUser } from '../common/auth/current-user';
import { resolveNotificationAction } from './notification-actions';

export interface CreateNotificationInput {
  userId: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
}

/** In-app notification center (NH-5). Per-user notifications, distinct from the
 *  Communication module's outbound channel deliveries. */
@Injectable()
export class UserNotificationService {
  constructor(private readonly prisma: PrismaService) {}

  /** Internal emit — called by other services when something noteworthy happens. */
  async create(orgId: string, input: CreateNotificationInput): Promise<void> {
    await this.prisma.userNotification.create({
      data: {
        organizationId: orgId,
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        link: input.link ?? null,
      },
    });
  }

  async list(user: AuthUser): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.userNotification.findMany({
      where: { userId: user.userId },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    // Actionability is decided HERE, once, against the user asking — not by the
    // emitting service, not by the stored link, and not by the React component.
    // See notification-actions.ts for why.
    return rows.map((r) => {
      const action = resolveNotificationAction(r.type, user.permissions);
      return {
        id: r.id,
        type: r.type,
        title: r.title,
        body: r.body,
        // Retained so nothing that already reads this field breaks. It is NOT a
        // navigation target: the client navigates by `action.route` or not at all.
        link: r.link,
        actionable: action !== null,
        action,
        read: r.readAt !== null,
        createdAt: r.createdAt,
      };
    });
  }

  async unreadCount(user: AuthUser): Promise<{ count: number }> {
    const count = await this.prisma.userNotification.count({ where: { userId: user.userId, readAt: null } });
    return { count };
  }

  async markRead(user: AuthUser, id: string): Promise<{ id: string }> {
    await this.prisma.userNotification.updateMany({ where: { id, userId: user.userId, readAt: null }, data: { readAt: new Date() } });
    return { id };
  }

  async markAllRead(user: AuthUser): Promise<{ updated: number }> {
    const res = await this.prisma.userNotification.updateMany({ where: { userId: user.userId, readAt: null }, data: { readAt: new Date() } });
    return { updated: res.count };
  }
}
