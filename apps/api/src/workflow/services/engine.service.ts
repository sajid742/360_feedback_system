import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';

type Tx = Prisma.TransactionClient;

interface StepRow {
  id: string;
  stepOrder: number;
  assigneeType: string;
  assigneeValue: string | null;
}

/** Generic approval engine over a polymorphic (entityType, entityId). */
@Injectable()
export class EngineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Starts a workflow instance for an entity and materializes the first tasks. */
  async start(orgId: string, startedBy: string | null, definitionId: string, entityType: string, entityId: string): Promise<{ instanceId: string; status: string }> {
    const definition = await this.prisma.workflowDefinition.findFirst({
      where: { id: definitionId, organizationId: orgId, deletedAt: null, isActive: true },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });
    if (!definition) throw new NotFoundException('Active workflow definition not found.');
    if (definition.steps.length === 0) throw new BadRequestException('Definition has no steps.');

    return this.prisma.$transaction(async (tx) => {
      const instance = await tx.workflowInstance.create({
        data: {
          organizationId: orgId,
          definitionId,
          entityType,
          entityId,
          status: 'in_progress',
          currentOrder: definition.steps[0].stepOrder,
          startedBy,
        },
      });
      const status =
        definition.mode === 'parallel'
          ? await this.startParallel(tx, orgId, instance.id, definition.steps)
          : await this.startSequential(tx, orgId, instance.id, definition.steps);
      return { instanceId: instance.id, status };
    });
  }

  async act(user: AuthUser, ctx: RequestContext, taskId: string, decision: 'approve' | 'reject', comment?: string): Promise<{ instanceStatus: string }> {
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.workflowTask.findUnique({ where: { id: taskId }, include: { instance: true } });
      if (!task || task.instance.organizationId !== user.organizationId) throw new NotFoundException('Task not found.');
      if (task.assigneeUserId !== user.userId) throw new ForbiddenException('This task is not assigned to you.');
      if (task.status !== 'pending') throw new BadRequestException('Task already decided.');

      await tx.workflowTask.update({
        where: { id: taskId },
        data: { status: decision === 'approve' ? 'approved' : 'rejected', comment: comment ?? null, decidedAt: new Date() },
      });
      await this.audit.record({
        organizationId: user.organizationId,
        userId: user.userId,
        action: `workflow.task.${decision}`,
        entityType: 'workflow_task',
        entityId: taskId,
        newValue: { comment },
        ip: ctx.ip,
        device: ctx.device,
      });

      const status = decision === 'reject'
        ? await this.finish(tx, task.instanceId, 'rejected')
        : await this.evaluate(tx, task.instanceId);
      return { instanceStatus: status };
    });
  }

  async delegate(user: AuthUser, taskId: string, toUserId: string): Promise<void> {
    const task = await this.prisma.workflowTask.findUnique({ where: { id: taskId }, include: { instance: true } });
    if (!task || task.instance.organizationId !== user.organizationId) throw new NotFoundException('Task not found.');
    if (task.assigneeUserId !== user.userId) throw new ForbiddenException('This task is not assigned to you.');
    if (task.status !== 'pending') throw new BadRequestException('Task already decided.');
    const target = await this.prisma.user.findFirst({ where: { id: toUserId, organizationId: user.organizationId, deletedAt: null }, select: { id: true } });
    if (!target) throw new BadRequestException('Delegate target not found.');
    await this.prisma.workflowTask.update({ where: { id: taskId }, data: { assigneeUserId: toUserId, delegatedToUserId: toUserId } });
  }

  async myTasks(user: AuthUser): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.workflowTask.findMany({
      where: { assigneeUserId: user.userId, status: 'pending', instance: { organizationId: user.organizationId } },
      include: { instance: { include: { definition: { select: { name: true } } } }, step: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((t) => ({
      id: t.id,
      workflow: t.instance.definition.name,
      step: t.step.name,
      entityType: t.instance.entityType,
      entityId: t.instance.entityId,
      createdAt: t.createdAt,
    }));
  }

  async instance(user: AuthUser, id: string): Promise<Record<string, unknown>> {
    const row = await this.prisma.workflowInstance.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { tasks: { orderBy: [{ stepOrder: 'asc' }, { createdAt: 'asc' }] }, definition: { select: { name: true, mode: true } } },
    });
    if (!row) throw new NotFoundException('Instance not found.');
    return {
      id: row.id,
      workflow: row.definition.name,
      mode: row.definition.mode,
      status: row.status,
      currentOrder: row.currentOrder,
      tasks: row.tasks.map((t) => ({ id: t.id, stepOrder: t.stepOrder, assigneeUserId: t.assigneeUserId, status: t.status, comment: t.comment })),
    };
  }

  /* ---- internals ---- */

  private async startSequential(tx: Tx, orgId: string, instanceId: string, steps: StepRow[]): Promise<string> {
    for (const step of steps) {
      const created = await this.materialize(tx, orgId, instanceId, step);
      if (created > 0) {
        await tx.workflowInstance.update({ where: { id: instanceId }, data: { currentOrder: step.stepOrder } });
        return 'in_progress';
      }
    }
    return this.finish(tx, instanceId, 'approved');
  }

  private async startParallel(tx: Tx, orgId: string, instanceId: string, steps: StepRow[]): Promise<string> {
    let total = 0;
    for (const step of steps) total += await this.materialize(tx, orgId, instanceId, step);
    return total > 0 ? 'in_progress' : this.finish(tx, instanceId, 'approved');
  }

  private async evaluate(tx: Tx, instanceId: string): Promise<string> {
    const instance = await tx.workflowInstance.findUniqueOrThrow({
      where: { id: instanceId },
      include: { definition: { include: { steps: { orderBy: { stepOrder: 'asc' } } } } },
    });
    if (instance.definition.mode === 'parallel') {
      const pending = await tx.workflowTask.count({ where: { instanceId, status: 'pending' } });
      return pending > 0 ? 'in_progress' : this.finish(tx, instanceId, 'approved');
    }
    const pendingHere = await tx.workflowTask.count({ where: { instanceId, stepOrder: instance.currentOrder, status: 'pending' } });
    if (pendingHere > 0) return 'in_progress';
    const next = instance.definition.steps.filter((s) => s.stepOrder > instance.currentOrder);
    for (const step of next) {
      const created = await this.materialize(tx, instance.organizationId, instanceId, step);
      if (created > 0) {
        await tx.workflowInstance.update({ where: { id: instanceId }, data: { currentOrder: step.stepOrder } });
        return 'in_progress';
      }
    }
    return this.finish(tx, instanceId, 'approved');
  }

  private async materialize(tx: Tx, orgId: string, instanceId: string, step: StepRow): Promise<number> {
    const assignees = await this.resolveAssignees(tx, orgId, step);
    if (assignees.length === 0) return 0;
    await tx.workflowTask.createMany({
      data: assignees.map((assigneeUserId) => ({ instanceId, stepId: step.id, stepOrder: step.stepOrder, assigneeUserId })),
    });
    return assignees.length;
  }

  private async resolveAssignees(tx: Tx, orgId: string, step: StepRow): Promise<string[]> {
    if (!step.assigneeValue) return [];
    if (step.assigneeType === 'user') {
      const user = await tx.user.findFirst({ where: { id: step.assigneeValue, organizationId: orgId, deletedAt: null }, select: { id: true } });
      return user ? [user.id] : [];
    }
    const holders = await tx.userRole.findMany({
      where: { roleId: step.assigneeValue, user: { organizationId: orgId, deletedAt: null, status: 'active' } },
      select: { userId: true },
    });
    return [...new Set(holders.map((h) => h.userId))];
  }

  private async finish(tx: Tx, instanceId: string, status: 'approved' | 'rejected'): Promise<string> {
    await tx.workflowInstance.update({ where: { id: instanceId }, data: { status, completedAt: new Date() } });
    if (status === 'rejected') {
      await tx.workflowTask.updateMany({ where: { instanceId, status: 'pending' }, data: { status: 'skipped' } });
    }
    return status;
  }
}
