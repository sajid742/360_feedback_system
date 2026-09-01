import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { paginate, resolveSort, type Paginated } from '../../common/dto/pagination.dto';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';
import type { CompetencyQueryDto, CreateCompetencyDto, UpdateCompetencyDto } from '../dto/competency.dto';
import { serializeCompetency } from '../mappers';
import { ProficiencyScaleService } from './proficiency-scale.service';

type Tx = Prisma.TransactionClient;

const SORTABLE = ['name', 'createdAt', 'updatedAt'] as const;

const FULL_INCLUDE = {
  category: true,
  mappings: { where: { deletedAt: null }, select: { isMandatory: true } },
  _count: { select: { versions: { where: { deletedAt: null } } } },
  versions: {
    where: { deletedAt: null },
    include: {
      proficiencyLevels: true,
      indicators: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } },
    },
  },
} satisfies Prisma.CompetencyInclude;

@Injectable()
export class CompetencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly scale: ProficiencyScaleService,
  ) {}

  async list(user: AuthUser, query: CompetencyQueryDto): Promise<Paginated<Record<string, unknown>>> {
    const where: Prisma.CompetencyWhereInput = {
      organizationId: user.organizationId,
      deletedAt: null,
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
    };
    const sortBy = resolveSort(query.sortBy, SORTABLE, 'name');
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.competency.findMany({
        where,
        include: FULL_INCLUDE,
        orderBy: { [sortBy]: query.sortOrder },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.competency.count({ where }),
    ]);
    return paginate(rows.map(serializeCompetency), total, query.page, query.pageSize);
  }

  async getById(user: AuthUser, id: string): Promise<Record<string, unknown>> {
    return serializeCompetency(await this.getOwned(user.organizationId, id));
  }

  async create(
    user: AuthUser,
    ctx: RequestContext,
    dto: CreateCompetencyDto,
  ): Promise<Record<string, unknown>> {
    await this.assertCategory(user.organizationId, dto.categoryId);
    await this.assertNameFree(user.organizationId, dto.name);
    const levels = await this.scale.resolveDefault(user.organizationId);

    const created = await this.prisma.$transaction(async (tx) => {
      const competency = await tx.competency.create({
        data: {
          organizationId: user.organizationId,
          categoryId: dto.categoryId,
          name: dto.name,
          description: dto.description ?? null,
          createdBy: user.userId,
          updatedBy: user.userId,
        },
      });
      await tx.competencyVersion.create({
        data: {
          organizationId: user.organizationId,
          competencyId: competency.id,
          versionLabel: 'v1',
          status: 'draft',
          createdBy: user.userId,
          updatedBy: user.userId,
          proficiencyLevels: {
            create: levels.map((level) => ({
              organizationId: user.organizationId,
              level: level.level,
              name: level.name,
              description: level.description,
            })),
          },
        },
      });
      return this.getOwnedTx(tx, user.organizationId, competency.id);
    });

    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: 'competency.create',
      entityType: 'competency',
      entityId: created.id,
      newValue: dto,
      ip: ctx.ip,
      device: ctx.device,
    });
    return serializeCompetency(created);
  }

  async update(
    user: AuthUser,
    ctx: RequestContext,
    id: string,
    dto: UpdateCompetencyDto,
  ): Promise<Record<string, unknown>> {
    const existing = await this.getOwned(user.organizationId, id);
    if (dto.categoryId) await this.assertCategory(user.organizationId, dto.categoryId);
    if (dto.name && dto.name.toLowerCase() !== existing.name.toLowerCase()) {
      await this.assertNameFree(user.organizationId, dto.name);
    }
    await this.prisma.competency.update({
      where: { id },
      data: {
        categoryId: dto.categoryId ?? existing.categoryId,
        name: dto.name ?? existing.name,
        description: dto.description ?? existing.description,
        updatedBy: user.userId,
      },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: 'competency.update',
      entityType: 'competency',
      entityId: id,
      previousValue: { name: existing.name, categoryId: existing.categoryId },
      newValue: dto,
      ip: ctx.ip,
      device: ctx.device,
    });
    return serializeCompetency(await this.getOwned(user.organizationId, id));
  }

  async archive(user: AuthUser, ctx: RequestContext, id: string): Promise<void> {
    await this.getOwned(user.organizationId, id);
    await this.prisma.competency.update({
      where: { id },
      data: { isArchived: true, deletedAt: new Date(), updatedBy: user.userId },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: 'competency.archive',
      entityType: 'competency',
      entityId: id,
      ip: ctx.ip,
      device: ctx.device,
    });
  }

  async getOwned(organizationId: string, id: string) {
    return this.getOwnedTx(this.prisma, organizationId, id);
  }

  private async getOwnedTx(client: PrismaClient | Tx, organizationId: string, id: string) {
    const row = await client.competency.findFirst({
      where: { id, organizationId, deletedAt: null },
      include: FULL_INCLUDE,
    });
    if (!row) throw new NotFoundException('Competency not found.');
    return row;
  }

  private async assertCategory(organizationId: string, categoryId: string): Promise<void> {
    const category = await this.prisma.competencyCategory.findFirst({
      where: { id: categoryId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!category) throw new NotFoundException('Category not found.');
  }

  private async assertNameFree(organizationId: string, name: string): Promise<void> {
    const clash = await this.prisma.competency.findFirst({
      where: { organizationId, deletedAt: null, name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (clash) throw new ConflictException('A competency with this name already exists.');
  }
}
