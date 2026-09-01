import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth/current-user';
import type { CreateActionDto, UpdateActionDto } from './dto/development.dto';

/** Development action plans (HV-3): trackable actions derived from feedback. */
@Injectable()
export class DevelopmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser, employeeId?: string): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.developmentAction.findMany({
      where: { organizationId: user.organizationId, ...(employeeId ? { employeeId } : {}) },
      include: { employee: { include: { user: { select: { fullName: true, email: true } } } } },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    return rows.map((r) => this.serialize(r));
  }

  async create(user: AuthUser, ctx: RequestContext, dto: CreateActionDto): Promise<Record<string, unknown>> {
    const employee = await this.prisma.employee.findFirst({
      where: { id: dto.employeeId, organizationId: user.organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!employee) throw new NotFoundException('Employee not found.');
    const row = await this.prisma.developmentAction.create({
      data: {
        organizationId: user.organizationId,
        employeeId: dto.employeeId,
        title: dto.title,
        competency: dto.competency ?? null,
        description: dto.description ?? null,
        priority: dto.priority ?? 'medium',
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        createdBy: user.userId,
      },
      include: { employee: { include: { user: { select: { fullName: true, email: true } } } } },
    });
    await this.record(user, ctx, 'development.action.create', row.id, { title: dto.title });
    return this.serialize(row);
  }

  async update(user: AuthUser, ctx: RequestContext, id: string, dto: UpdateActionDto): Promise<Record<string, unknown>> {
    const existing = await this.getOwned(user.organizationId, id);
    const row = await this.prisma.developmentAction.update({
      where: { id },
      data: {
        title: dto.title ?? existing.title,
        competency: dto.competency ?? existing.competency,
        description: dto.description ?? existing.description,
        status: dto.status ?? existing.status,
        priority: dto.priority ?? existing.priority,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : existing.dueDate,
      },
      include: { employee: { include: { user: { select: { fullName: true, email: true } } } } },
    });
    await this.record(user, ctx, 'development.action.update', id, dto);
    return this.serialize(row);
  }

  async remove(user: AuthUser, ctx: RequestContext, id: string): Promise<void> {
    await this.getOwned(user.organizationId, id);
    await this.prisma.developmentAction.delete({ where: { id } });
    await this.record(user, ctx, 'development.action.delete', id, null);
  }

  private async getOwned(organizationId: string, id: string) {
    const row = await this.prisma.developmentAction.findFirst({ where: { id, organizationId } });
    if (!row) throw new NotFoundException('Development action not found.');
    return row;
  }

  private serialize(row: {
    id: string;
    employeeId: string;
    title: string;
    competency: string | null;
    description: string | null;
    status: string;
    priority: string;
    dueDate: Date | null;
    createdAt: Date;
    employee?: { user: { fullName: string | null; email: string } };
  }): Record<string, unknown> {
    return {
      id: row.id,
      employeeId: row.employeeId,
      employeeName: row.employee ? row.employee.user.fullName ?? row.employee.user.email : undefined,
      title: row.title,
      competency: row.competency,
      description: row.description,
      status: row.status,
      priority: row.priority,
      dueDate: row.dueDate,
      createdAt: row.createdAt,
    };
  }

  private async record(user: AuthUser, ctx: RequestContext, action: string, entityId: string, newValue: unknown): Promise<void> {
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action,
      entityType: 'development_action',
      entityId,
      newValue: newValue ?? undefined,
      ip: ctx.ip,
      device: ctx.device,
    });
  }
}
