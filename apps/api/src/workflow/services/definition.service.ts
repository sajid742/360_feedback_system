import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';
import type { CreateDefinitionDto } from '../workflow.dto';

@Injectable()
export class DefinitionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser, entityType?: string): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.workflowDefinition.findMany({
      where: { organizationId: user.organizationId, deletedAt: null, ...(entityType ? { entityType } : {}) },
      orderBy: { name: 'asc' },
      include: { _count: { select: { steps: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      entityType: r.entityType,
      mode: r.mode,
      isActive: r.isActive,
      steps: r._count.steps,
    }));
  }

  async get(user: AuthUser, id: string): Promise<Record<string, unknown>> {
    const row = await this.prisma.workflowDefinition.findFirst({
      where: { id, organizationId: user.organizationId, deletedAt: null },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });
    if (!row) throw new NotFoundException('Workflow definition not found.');
    return {
      id: row.id,
      name: row.name,
      entityType: row.entityType,
      mode: row.mode,
      steps: row.steps.map((s) => ({
        id: s.id,
        name: s.name,
        stepOrder: s.stepOrder,
        assigneeType: s.assigneeType,
        assigneeValue: s.assigneeValue,
        slaHours: s.slaHours,
      })),
    };
  }

  async create(user: AuthUser, ctx: RequestContext, dto: CreateDefinitionDto): Promise<{ id: string }> {
    const row = await this.prisma.workflowDefinition.create({
      data: {
        organizationId: user.organizationId,
        name: dto.name,
        entityType: dto.entityType,
        mode: dto.mode,
        createdBy: user.userId,
        updatedBy: user.userId,
        steps: {
          create: dto.steps.map((s) => ({
            name: s.name,
            stepOrder: s.stepOrder,
            assigneeType: s.assigneeType,
            assigneeValue: s.assigneeValue ?? null,
            slaHours: s.slaHours ?? null,
          })),
        },
      },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: 'workflow.definition.create',
      entityType: 'workflow_definition',
      entityId: row.id,
      newValue: { name: dto.name, entityType: dto.entityType },
      ip: ctx.ip,
      device: ctx.device,
    });
    return { id: row.id };
  }

  async remove(user: AuthUser, id: string): Promise<void> {
    const existing = await this.prisma.workflowDefinition.findFirst({
      where: { id, organizationId: user.organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Workflow definition not found.');
    await this.prisma.workflowDefinition.update({ where: { id }, data: { deletedAt: new Date() } });
  }
}
