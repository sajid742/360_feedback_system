import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';
import type { CreateCampusDto, UpdateCampusDto } from '../dto/organization.dto';
import { EntitlementService } from '../../license/entitlement.service';

/**
 * Campuses are organization rows (org_type='campus') parented to the tenant root.
 * Tenant-owned data still keys off the root organization id; a campus is an
 * attribution link, not a separate tenant.
 */
@Injectable()
export class CampusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementService,
  ) {}

  async list(user: AuthUser): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.organization.findMany({
      where: { parentOrgId: user.organizationId, orgType: 'campus', deletedAt: null },
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, status: r.status }));
  }

  async create(user: AuthUser, ctx: RequestContext, dto: CreateCampusDto): Promise<{ id: string }> {
    await this.entitlements.assertWithinLimit(user.organizationId, 'maxCampuses', 1);
    const clash = await this.prisma.organization.findUnique({ where: { slug: dto.slug }, select: { id: true } });
    if (clash) throw new ConflictException('This slug is already taken.');
    const row = await this.prisma.organization.create({
      data: { name: dto.name, slug: dto.slug, orgType: 'campus', parentOrgId: user.organizationId },
    });
    await this.record(user, ctx, 'organization.campus.create', row.id, dto);
    return { id: row.id };
  }

  async update(user: AuthUser, ctx: RequestContext, id: string, dto: UpdateCampusDto): Promise<{ id: string }> {
    const existing = await this.getOwned(user.organizationId, id);
    await this.prisma.organization.update({
      where: { id },
      data: { name: dto.name ?? existing.name, status: dto.status ?? existing.status },
    });
    await this.record(user, ctx, 'organization.campus.update', id, dto);
    return { id };
  }

  async remove(user: AuthUser, ctx: RequestContext, id: string): Promise<void> {
    await this.getOwned(user.organizationId, id);
    await this.prisma.organization.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.record(user, ctx, 'organization.campus.delete', id, null);
  }

  private async getOwned(rootOrgId: string, id: string) {
    const row = await this.prisma.organization.findFirst({
      where: { id, parentOrgId: rootOrgId, orgType: 'campus', deletedAt: null },
    });
    if (!row) throw new NotFoundException('Campus not found.');
    return row;
  }

  private async record(user: AuthUser, ctx: RequestContext, action: string, entityId: string, newValue: unknown): Promise<void> {
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action,
      entityType: 'campus',
      entityId,
      newValue: newValue ?? undefined,
      ip: ctx.ip,
      device: ctx.device,
    });
  }
}
