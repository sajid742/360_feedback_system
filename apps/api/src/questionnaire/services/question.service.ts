import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { paginate, type Paginated } from '../../common/dto/pagination.dto';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';
import type { CreateQuestionDto, QuestionQueryDto, UpdateQuestionDto } from '../questionnaire.dto';

function serialize(row: {
  id: string;
  text: string;
  type: string;
  category: string | null;
  competencyId: string | null;
  ratingScaleId: string | null;
  isMandatory: boolean;
  weight: Prisma.Decimal;
  options: Prisma.JsonValue;
  status: string;
}): Record<string, unknown> {
  return {
    id: row.id,
    text: row.text,
    type: row.type,
    category: row.category,
    competencyId: row.competencyId,
    ratingScaleId: row.ratingScaleId,
    isMandatory: row.isMandatory,
    weight: Number(row.weight),
    options: row.options,
    status: row.status,
  };
}

@Injectable()
export class QuestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser, query: QuestionQueryDto): Promise<Paginated<Record<string, unknown>>> {
    const where: Prisma.QuestionWhereInput = {
      organizationId: user.organizationId,
      deletedAt: null,
      ...(query.type ? { type: query.type } : {}),
      ...(query.competencyId ? { competencyId: query.competencyId } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.search ? { text: { contains: query.search, mode: 'insensitive' } } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.question.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.question.count({ where }),
    ]);
    return paginate(rows.map(serialize), total, query.page, query.pageSize);
  }

  async create(user: AuthUser, ctx: RequestContext, dto: CreateQuestionDto): Promise<Record<string, unknown>> {
    const row = await this.prisma.question.create({
      data: {
        organizationId: user.organizationId,
        text: dto.text,
        type: dto.type,
        competencyId: dto.competencyId ?? null,
        ratingScaleId: dto.ratingScaleId ?? null,
        category: dto.category ?? null,
        isMandatory: dto.isMandatory ?? true,
        weight: dto.weight ?? 1,
        options: dto.options ?? Prisma.JsonNull,
        createdBy: user.userId,
        updatedBy: user.userId,
      },
    });
    await this.record(user, ctx, 'questionnaire.question.create', row.id, dto);
    return serialize(row);
  }

  async update(user: AuthUser, ctx: RequestContext, id: string, dto: UpdateQuestionDto): Promise<Record<string, unknown>> {
    const existing = await this.getOwned(user.organizationId, id);
    const row = await this.prisma.question.update({
      where: { id },
      data: {
        text: dto.text ?? existing.text,
        type: dto.type ?? existing.type,
        competencyId: dto.competencyId === undefined ? existing.competencyId : dto.competencyId,
        ratingScaleId: dto.ratingScaleId === undefined ? existing.ratingScaleId : dto.ratingScaleId,
        category: dto.category ?? existing.category,
        isMandatory: dto.isMandatory ?? existing.isMandatory,
        weight: dto.weight ?? existing.weight,
        options: dto.options ?? existing.options ?? Prisma.JsonNull,
        status: dto.status ?? existing.status,
        updatedBy: user.userId,
      },
    });
    await this.record(user, ctx, 'questionnaire.question.update', id, dto);
    return serialize(row);
  }

  async remove(user: AuthUser, ctx: RequestContext, id: string): Promise<void> {
    await this.getOwned(user.organizationId, id);
    await this.prisma.question.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: user.userId } });
    await this.record(user, ctx, 'questionnaire.question.delete', id, null);
  }

  private async getOwned(organizationId: string, id: string) {
    const row = await this.prisma.question.findFirst({ where: { id, organizationId, deletedAt: null } });
    if (!row) throw new NotFoundException('Question not found.');
    return row;
  }

  private async record(user: AuthUser, ctx: RequestContext, action: string, entityId: string, newValue: unknown): Promise<void> {
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action,
      entityType: 'question',
      entityId,
      newValue: newValue ?? undefined,
      ip: ctx.ip,
      device: ctx.device,
    });
  }
}
