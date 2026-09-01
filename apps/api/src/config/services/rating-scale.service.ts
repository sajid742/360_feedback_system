import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';
import type { CreateRatingScaleDto, RatingScaleLevelDto, UpdateRatingScaleDto } from '../dto/config.dto';

const WITH_LEVELS = { levels: { orderBy: { sortOrder: 'asc' } } } satisfies Prisma.RatingScaleInclude;

type ScaleRow = Prisma.RatingScaleGetPayload<{ include: typeof WITH_LEVELS }>;

/** Configurable rating scales (org-level) with ordered levels. Rating scales are
 *  DATA — the source for any scored/proficiency UI, never hardcoded. */
@Injectable()
export class RatingScaleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.ratingScale.findMany({
      where: { organizationId: user.organizationId, deletedAt: null },
      include: WITH_LEVELS,
      orderBy: { name: 'asc' },
    });
    return rows.map((row) => this.serialize(row));
  }

  async create(
    user: AuthUser,
    ctx: RequestContext,
    dto: CreateRatingScaleDto,
  ): Promise<Record<string, unknown>> {
    const row = await this.prisma.ratingScale.create({
      data: {
        organizationId: user.organizationId,
        name: dto.name,
        scaleType: dto.scaleType,
        minValue: dto.minValue,
        maxValue: dto.maxValue,
        createdBy: user.userId,
        updatedBy: user.userId,
        levels: { create: dto.levels.map(this.toLevelCreate) },
      },
      include: WITH_LEVELS,
    });
    await this.record(user, ctx, 'configuration.rating_scale.create', row.id, dto);
    return this.serialize(row);
  }

  async update(
    user: AuthUser,
    ctx: RequestContext,
    id: string,
    dto: UpdateRatingScaleDto,
  ): Promise<Record<string, unknown>> {
    const existing = await this.getOwned(user, id);
    const row = await this.prisma.$transaction(async (tx) => {
      if (dto.levels) {
        await tx.ratingScaleLevel.deleteMany({ where: { ratingScaleId: id } });
        await tx.ratingScaleLevel.createMany({
          data: dto.levels.map((level) => ({ ratingScaleId: id, ...this.toLevelCreate(level) })),
        });
      }
      await tx.ratingScale.update({
        where: { id },
        data: {
          name: dto.name ?? existing.name,
          status: dto.status ?? existing.status,
          updatedBy: user.userId,
        },
      });
      return tx.ratingScale.findUniqueOrThrow({ where: { id }, include: WITH_LEVELS });
    });
    await this.record(user, ctx, 'configuration.rating_scale.update', id, dto);
    return this.serialize(row);
  }

  async remove(user: AuthUser, ctx: RequestContext, id: string): Promise<void> {
    await this.getOwned(user, id);
    await this.prisma.ratingScale.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.record(user, ctx, 'configuration.rating_scale.delete', id, null);
  }

  private async getOwned(user: AuthUser, id: string) {
    const row = await this.prisma.ratingScale.findFirst({
      where: { id, organizationId: user.organizationId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Rating scale not found.');
    return row;
  }

  private toLevelCreate(level: RatingScaleLevelDto): Prisma.RatingScaleLevelCreateManyRatingScaleInput {
    return {
      value: level.value,
      label: level.label,
      color: level.color ?? null,
      icon: level.icon ?? null,
      sortOrder: level.sortOrder ?? 0,
    };
  }

  private serialize(row: ScaleRow): Record<string, unknown> {
    return {
      id: row.id,
      name: row.name,
      scaleType: row.scaleType,
      minValue: Number(row.minValue),
      maxValue: Number(row.maxValue),
      status: row.status,
      levels: row.levels.map((level) => ({
        id: level.id,
        value: Number(level.value),
        label: level.label,
        color: level.color,
        icon: level.icon,
        sortOrder: level.sortOrder,
      })),
    };
  }

  private async record(
    user: AuthUser,
    ctx: RequestContext,
    action: string,
    entityId: string,
    newValue: unknown,
  ): Promise<void> {
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action,
      entityType: 'rating_scale',
      entityId,
      newValue: newValue ?? undefined,
      ip: ctx.ip,
      device: ctx.device,
    });
  }
}
