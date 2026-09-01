import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { FeedbackAuditService } from '../../feedback-audit/feedback-audit.service';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';
import type { CreateRubricDto } from '../questionnaire.dto';

@Injectable()
export class RubricService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly feedbackAudit: FeedbackAuditService,
  ) {}

  async list(user: AuthUser): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.rubric.findMany({
      where: { organizationId: user.organizationId, deletedAt: null },
      orderBy: { title: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      competencyId: r.competencyId,
      ratingScaleId: r.ratingScaleId,
      descriptors: r.descriptors,
    }));
  }

  async create(user: AuthUser, ctx: RequestContext, dto: CreateRubricDto): Promise<{ id: string }> {
    const row = await this.prisma.rubric.create({
      data: {
        organizationId: user.organizationId,
        title: dto.title,
        competencyId: dto.competencyId ?? null,
        ratingScaleId: dto.ratingScaleId ?? null,
        descriptors: dto.descriptors as Prisma.InputJsonValue,
        createdBy: user.userId,
        updatedBy: user.userId,
      },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: 'questionnaire.rubric.create',
      entityType: 'rubric',
      entityId: row.id,
      newValue: { title: dto.title },
      ip: ctx.ip,
      device: ctx.device,
    });
    await this.feedbackAudit.record({
      organizationId: user.organizationId,
      action: 'rubric.created',
      actorUserId: user.userId,
      actorName: user.email,
      entityType: 'rubric',
      entityId: row.id,
      newValue: { title: dto.title },
      ctx,
    });
    return { id: row.id };
  }

  async remove(user: AuthUser, ctx: RequestContext, id: string): Promise<void> {
    const existing = await this.prisma.rubric.findFirst({
      where: { id, organizationId: user.organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Rubric not found.');
    await this.prisma.rubric.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: 'questionnaire.rubric.delete',
      entityType: 'rubric',
      entityId: id,
      ip: ctx.ip,
      device: ctx.device,
    });
    await this.feedbackAudit.record({
      organizationId: user.organizationId,
      action: 'rubric.removed',
      actorUserId: user.userId,
      actorName: user.email,
      entityType: 'rubric',
      entityId: id,
      ctx,
    });
  }
}
