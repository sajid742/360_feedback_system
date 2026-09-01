import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';
import { NotificationService } from './notification.service';
import type { CreateCampaignDto } from '../communication.dto';

interface Audience {
  type: 'explicit' | 'all_employees';
  recipients?: string[];
}

/** Campaigns: create, resolve the audience to recipients, and fan out
 *  per-recipient notifications through the delivery queue. */
@Injectable()
export class CampaignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  async list(user: AuthUser): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.communicationCampaign.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { notifications: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      channel: r.channel,
      status: r.status,
      recipients: r._count.notifications,
      createdAt: r.createdAt,
    }));
  }

  async create(user: AuthUser, ctx: RequestContext, dto: CreateCampaignDto): Promise<{ id: string; recipients: number }> {
    const recipients = await this.resolveAudience(user, dto.audience as unknown as Audience, dto.channel);
    if (recipients.length === 0) throw new BadRequestException('Audience resolved to zero recipients.');

    const campaign = await this.prisma.communicationCampaign.create({
      data: {
        organizationId: user.organizationId,
        name: dto.name,
        channel: dto.channel,
        subject: dto.subject ?? null,
        body: dto.body,
        templateKey: dto.templateKey ?? null,
        audience: dto.audience as Prisma.InputJsonValue,
        status: 'sending',
        createdBy: user.userId,
      },
    });

    for (const recipient of recipients) {
      await this.notifications.send(user.organizationId, user.userId, {
        channel: dto.channel,
        recipient,
        subject: dto.subject,
        body: dto.body,
        templateKey: dto.templateKey,
        campaignId: campaign.id,
      });
    }
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: 'communication.campaign.create',
      entityType: 'communication_campaign',
      entityId: campaign.id,
      newValue: { name: dto.name, recipients: recipients.length },
      ip: ctx.ip,
      device: ctx.device,
    });
    return { id: campaign.id, recipients: recipients.length };
  }

  private async resolveAudience(user: AuthUser, audience: Audience, channel: string): Promise<string[]> {
    if (audience.type === 'explicit') return [...new Set(audience.recipients ?? [])];
    if (channel !== 'email') {
      throw new BadRequestException('all_employees audience currently resolves to email addresses only.');
    }
    const employees = await this.prisma.employee.findMany({
      where: { organizationId: user.organizationId, deletedAt: null, status: 'active' },
      select: { user: { select: { email: true } } },
    });
    return [...new Set(employees.map((e) => e.user.email))];
  }
}
