import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';
import { wouldCreateCycle } from '../cycle-guard';
import type { CreateDesignationDto, UpdateDesignationDto } from '../dto/organization.dto';

@Injectable()
export class DesignationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.designation.findMany({
      where: { organizationId: user.organizationId, deletedAt: null },
      orderBy: [{ level: 'asc' }, { name: 'asc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      level: r.level,
      promotionToId: r.promotionToId,
    }));
  }

  async create(user: AuthUser, ctx: RequestContext, dto: CreateDesignationDto): Promise<{ id: string }> {
    if (dto.promotionToId) await this.getOwned(user.organizationId, dto.promotionToId);
    const row = await this.prisma.designation.create({
      data: {
        organizationId: user.organizationId,
        name: dto.name,
        level: dto.level ?? 0,
        promotionToId: dto.promotionToId ?? null,
        createdBy: user.userId,
        updatedBy: user.userId,
      },
    });
    await this.record(user, ctx, 'organization.designation.create', row.id, dto);
    return { id: row.id };
  }

  async update(user: AuthUser, ctx: RequestContext, id: string, dto: UpdateDesignationDto): Promise<{ id: string }> {
    const existing = await this.getOwned(user.organizationId, id);
    if (dto.promotionToId) {
      if (dto.promotionToId === id) throw new BadRequestException('A designation cannot promote to itself.');
      await this.getOwned(user.organizationId, dto.promotionToId);
      const cycle = await wouldCreateCycle((nid) => this.promotionOf(nid), dto.promotionToId, id);
      if (cycle) throw new BadRequestException('This promotion path would create a cycle.');
    }
    await this.prisma.designation.update({
      where: { id },
      data: {
        name: dto.name ?? existing.name,
        level: dto.level ?? existing.level,
        promotionToId: dto.promotionToId === undefined ? existing.promotionToId : dto.promotionToId,
        updatedBy: user.userId,
      },
    });
    await this.record(user, ctx, 'organization.designation.update', id, dto);
    return { id };
  }

  async remove(user: AuthUser, ctx: RequestContext, id: string): Promise<void> {
    await this.getOwned(user.organizationId, id);
    await this.prisma.designation.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: user.userId } });
    await this.record(user, ctx, 'organization.designation.delete', id, null);
  }

  private async promotionOf(id: string): Promise<string | null> {
    const row = await this.prisma.designation.findUnique({ where: { id }, select: { promotionToId: true } });
    return row?.promotionToId ?? null;
  }

  private async getOwned(organizationId: string, id: string) {
    const row = await this.prisma.designation.findFirst({ where: { id, organizationId, deletedAt: null } });
    if (!row) throw new NotFoundException('Designation not found.');
    return row;
  }

  private async record(user: AuthUser, ctx: RequestContext, action: string, entityId: string, newValue: unknown): Promise<void> {
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action,
      entityType: 'designation',
      entityId,
      newValue: newValue ?? undefined,
      ip: ctx.ip,
      device: ctx.device,
    });
  }
}
