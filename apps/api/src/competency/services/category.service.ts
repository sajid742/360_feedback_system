import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { paginate, resolveSort, type Paginated } from '../../common/dto/pagination.dto';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';
import type { CategoryQueryDto, CreateCategoryDto, UpdateCategoryDto } from '../dto/category.dto';
import { serializeCategory } from '../mappers';

const SORTABLE = ['name', 'createdAt', 'updatedAt'] as const;

@Injectable()
export class CategoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser, query: CategoryQueryDto): Promise<Paginated<Record<string, unknown>>> {
    const where: Prisma.CompetencyCategoryWhereInput = {
      organizationId: user.organizationId,
      deletedAt: null,
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
    };
    const sortBy = resolveSort(query.sortBy, SORTABLE, 'name');
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.competencyCategory.findMany({
        where,
        include: { _count: { select: { competencies: { where: { deletedAt: null } } } } },
        orderBy: { [sortBy]: query.sortOrder },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.competencyCategory.count({ where }),
    ]);
    return paginate(rows.map(serializeCategory), total, query.page, query.pageSize);
  }

  async create(
    user: AuthUser,
    ctx: RequestContext,
    dto: CreateCategoryDto,
  ): Promise<Record<string, unknown>> {
    await this.assertNameFree(user.organizationId, dto.name);
    const row = await this.prisma.competencyCategory.create({
      data: {
        organizationId: user.organizationId,
        name: dto.name,
        description: dto.description ?? null,
        colorTone: dto.colorTone ?? null,
        createdBy: user.userId,
        updatedBy: user.userId,
      },
      include: { _count: { select: { competencies: true } } },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: 'competency.category.create',
      entityType: 'competency_category',
      entityId: row.id,
      newValue: dto,
      ip: ctx.ip,
      device: ctx.device,
    });
    return serializeCategory(row);
  }

  async update(
    user: AuthUser,
    ctx: RequestContext,
    id: string,
    dto: UpdateCategoryDto,
  ): Promise<Record<string, unknown>> {
    const existing = await this.getOwned(user.organizationId, id);
    if (dto.name && dto.name.toLowerCase() !== existing.name.toLowerCase()) {
      await this.assertNameFree(user.organizationId, dto.name);
    }
    const row = await this.prisma.competencyCategory.update({
      where: { id },
      data: {
        name: dto.name ?? existing.name,
        description: dto.description ?? existing.description,
        colorTone: dto.colorTone ?? existing.colorTone,
        isActive: dto.isActive ?? existing.isActive,
        updatedBy: user.userId,
      },
      include: { _count: { select: { competencies: { where: { deletedAt: null } } } } },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: 'competency.category.update',
      entityType: 'competency_category',
      entityId: id,
      previousValue: existing,
      newValue: dto,
      ip: ctx.ip,
      device: ctx.device,
    });
    return serializeCategory(row);
  }

  async remove(user: AuthUser, ctx: RequestContext, id: string): Promise<void> {
    await this.getOwned(user.organizationId, id);
    const inUse = await this.prisma.competency.count({
      where: { categoryId: id, deletedAt: null },
    });
    if (inUse > 0) {
      throw new ConflictException('Cannot delete a category that still has competencies.');
    }
    await this.prisma.competencyCategory.update({
      where: { id },
      data: { deletedAt: new Date(), updatedBy: user.userId },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: 'competency.category.delete',
      entityType: 'competency_category',
      entityId: id,
      ip: ctx.ip,
      device: ctx.device,
    });
  }

  private async getOwned(organizationId: string, id: string) {
    const row = await this.prisma.competencyCategory.findFirst({
      where: { id, organizationId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Category not found.');
    return row;
  }

  private async assertNameFree(organizationId: string, name: string): Promise<void> {
    const clash = await this.prisma.competencyCategory.findFirst({
      where: { organizationId, deletedAt: null, name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (clash) throw new ConflictException('A category with this name already exists.');
  }
}
