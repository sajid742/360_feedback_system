import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';
import { wouldCreateCycle } from '../cycle-guard';
import type { CreateDepartmentDto, UpdateDepartmentDto } from '../dto/organization.dto';
import { EntitlementService } from '../../license/entitlement.service';

interface DeptNode {
  id: string;
  name: string;
  unitType: string;
  parentId: string | null;
  campusName: string | null;
  hodName: string | null;
  hodDesignation: string | null;
  employeeCount: number;      // direct members of this unit
  totalEmployeeCount: number; // members of this unit + all descendant units
  children: DeptNode[];
}

@Injectable()
export class DepartmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementService,
  ) {}

  /**
   * Department hierarchy, enriched (read-only, no schema change) with the derived
   * fields the Org Chart explorer needs: the campus, the Head of Department, and
   * headcounts. The HOD is derived as the most senior active member of the unit
   * (highest designation level; ties broken by name) since there is no explicit
   * HOD column. Headcount is exposed both as direct members and as a rollup that
   * includes every descendant unit.
   */
  async tree(user: AuthUser): Promise<DeptNode[]> {
    const rows = await this.prisma.department.findMany({
      where: { organizationId: user.organizationId, deletedAt: null },
      orderBy: { name: 'asc' },
    });

    // Campuses live in the organizations table (campusId has no Prisma relation),
    // so resolve their names with one lookup keyed by id.
    const campusIds = [...new Set(rows.map((r) => r.campusId).filter((id): id is string => id != null))];
    const campusName = new Map<string, string>();
    if (campusIds.length > 0) {
      const campuses = await this.prisma.organization.findMany({
        where: { id: { in: campusIds } },
        select: { id: true, name: true },
      });
      campuses.forEach((c) => campusName.set(c.id, c.name));
    }

    // One pass over active employees: per-department direct count and the most
    // senior member (for the HOD). Designation level is nullable, so absent
    // levels sort lowest.
    const members = await this.prisma.employee.findMany({
      where: { organizationId: user.organizationId, deletedAt: null, status: 'active', departmentId: { not: null } },
      select: {
        departmentId: true,
        user: { select: { fullName: true, email: true } },
        designation: { select: { name: true, level: true } },
      },
    });
    const directCount = new Map<string, number>();
    const topMember = new Map<string, { level: number; name: string; designation: string | null }>();
    for (const m of members) {
      const dept = m.departmentId!;
      directCount.set(dept, (directCount.get(dept) ?? 0) + 1);
      const name = m.user.fullName ?? m.user.email;
      const level = m.designation?.level ?? -1;
      const current = topMember.get(dept);
      if (!current || level > current.level || (level === current.level && name.localeCompare(current.name) < 0)) {
        topMember.set(dept, { level, name, designation: m.designation?.name ?? null });
      }
    }

    const nodes = new Map<string, DeptNode>();
    rows.forEach((r) => {
      const head = topMember.get(r.id);
      nodes.set(r.id, {
        id: r.id,
        name: r.name,
        unitType: r.unitType,
        parentId: r.parentId,
        campusName: r.campusId ? campusName.get(r.campusId) ?? null : null,
        hodName: head?.name ?? null,
        hodDesignation: head?.designation ?? null,
        employeeCount: directCount.get(r.id) ?? 0,
        totalEmployeeCount: 0, // filled in after the tree is assembled
        children: [],
      });
    });

    const roots: DeptNode[] = [];
    for (const node of nodes.values()) {
      if (node.parentId && nodes.has(node.parentId)) nodes.get(node.parentId)!.children.push(node);
      else roots.push(node);
    }

    // Roll direct counts up through the tree (a unit's total = its own members
    // plus every descendant's members).
    const rollup = (node: DeptNode): number => {
      node.totalEmployeeCount = node.employeeCount + node.children.reduce((sum, c) => sum + rollup(c), 0);
      return node.totalEmployeeCount;
    };
    roots.forEach(rollup);

    return roots;
  }

  async create(user: AuthUser, ctx: RequestContext, dto: CreateDepartmentDto): Promise<{ id: string }> {
    await this.entitlements.assertWithinLimit(user.organizationId, 'maxDepartments', 1);
    if (dto.parentId) await this.getOwned(user.organizationId, dto.parentId);
    const row = await this.prisma.department.create({
      data: {
        organizationId: user.organizationId,
        name: dto.name,
        parentId: dto.parentId ?? null,
        campusId: dto.campusId ?? null,
        unitType: dto.unitType ?? 'department',
        createdBy: user.userId,
        updatedBy: user.userId,
      },
    });
    await this.record(user, ctx, 'organization.department.create', row.id, dto);
    return { id: row.id };
  }

  async update(user: AuthUser, ctx: RequestContext, id: string, dto: UpdateDepartmentDto): Promise<{ id: string }> {
    const existing = await this.getOwned(user.organizationId, id);
    if (dto.parentId) {
      if (dto.parentId === id) throw new BadRequestException('A department cannot be its own parent.');
      await this.getOwned(user.organizationId, dto.parentId);
      const cycle = await wouldCreateCycle((nid) => this.parentOf(nid), dto.parentId, id);
      if (cycle) throw new BadRequestException('This parent would create a cycle.');
    }
    await this.prisma.department.update({
      where: { id },
      data: {
        name: dto.name ?? existing.name,
        parentId: dto.parentId === undefined ? existing.parentId : dto.parentId,
        campusId: dto.campusId === undefined ? existing.campusId : dto.campusId,
        unitType: dto.unitType ?? existing.unitType,
        updatedBy: user.userId,
      },
    });
    await this.record(user, ctx, 'organization.department.update', id, dto);
    return { id };
  }

  async remove(user: AuthUser, ctx: RequestContext, id: string): Promise<void> {
    await this.getOwned(user.organizationId, id);
    const children = await this.prisma.department.count({ where: { parentId: id, deletedAt: null } });
    if (children > 0) throw new ConflictException('Reassign or remove child departments first.');
    await this.prisma.department.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: user.userId } });
    await this.record(user, ctx, 'organization.department.delete', id, null);
  }

  private async parentOf(id: string): Promise<string | null> {
    const row = await this.prisma.department.findUnique({ where: { id }, select: { parentId: true } });
    return row?.parentId ?? null;
  }

  private async getOwned(organizationId: string, id: string) {
    const row = await this.prisma.department.findFirst({ where: { id, organizationId, deletedAt: null } });
    if (!row) throw new NotFoundException('Department not found.');
    return row;
  }

  private async record(user: AuthUser, ctx: RequestContext, action: string, entityId: string, newValue: unknown): Promise<void> {
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action,
      entityType: 'department',
      entityId,
      newValue: newValue ?? undefined,
      ip: ctx.ip,
      device: ctx.device,
    });
  }
}
