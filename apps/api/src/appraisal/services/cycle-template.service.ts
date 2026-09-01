import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { FeedbackAuditService } from '../../feedback-audit/feedback-audit.service';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';

/**
 * Reusable cycle templates (F31). A template is a named, saved cycle configuration —
 * questionnaire template + rating scale + feedback sources (code/label/weight/…) —
 * decoupled from any one cycle's dates/participants, so admins can spin up a new
 * cycle from a library entry instead of re-configuring from scratch or cloning a
 * specific past cycle.
 *
 * Minimal-change design: templates are stored as JSON in the EXISTING
 * `configurations` table (module='appraisal', key='cycle_templates'), exactly like
 * the auth/dashboards/HR settings do — no new table, no schema migration. "Apply"
 * mirrors CycleService.clone (draft cycle + copied sources in one transaction).
 */
export interface CycleTemplateSource {
  code: string;
  label: string;
  weight: number;
  requiredCount: number;
  isAnonymous: boolean;
  /** Quadrant-specific questionnaire, if the saved cycle had one. */
  templateId?: string | null;
}

export interface CycleTemplate {
  id: string;
  name: string;
  description: string | null;
  templateId: string | null;
  ratingScaleId: string | null;
  sources: CycleTemplateSource[];
  createdAt: string;
  createdBy: string;
}

const MODULE = 'appraisal';
const KEY = 'cycle_templates';

@Injectable()
export class CycleTemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly feedbackAudit: FeedbackAuditService,
  ) {}

  async list(user: AuthUser): Promise<CycleTemplate[]> {
    return this.readAll(user.organizationId);
  }

  /** Persist the current configuration of an existing cycle as a reusable template. */
  async saveFromCycle(
    user: AuthUser,
    ctx: RequestContext,
    cycleId: string,
    name: string,
    description?: string,
  ): Promise<CycleTemplate> {
    const cycle = await this.prisma.appraisalCycle.findFirst({
      where: { id: cycleId, organizationId: user.organizationId, deletedAt: null },
      select: { templateId: true, ratingScaleId: true },
    });
    if (!cycle) throw new NotFoundException('Appraisal cycle not found.');
    const sources = await this.prisma.feedbackSource.findMany({ where: { cycleId } });
    const template: CycleTemplate = {
      id: randomUUID(),
      name: name.trim(),
      description: description?.trim() || null,
      templateId: cycle.templateId,
      ratingScaleId: cycle.ratingScaleId,
      sources: sources.map((s) => ({
        code: s.code,
        label: s.label,
        weight: Number(s.weight),
        requiredCount: s.requiredCount,
        isAnonymous: s.isAnonymous,
        templateId: s.templateId ?? null,
      })),
      createdAt: new Date().toISOString(),
      createdBy: user.userId,
    };
    if (!template.name) throw new BadRequestException('Template name is required.');
    const all = await this.readAll(user.organizationId);
    all.push(template);
    await this.writeAll(user.organizationId, user.userId, all);
    await this.record(user, ctx, 'appraisal.cycle_template.create', template.id, { name: template.name, fromCycleId: cycleId });
    return template;
  }

  async remove(user: AuthUser, ctx: RequestContext, templateId: string): Promise<{ id: string; deleted: boolean }> {
    const all = await this.readAll(user.organizationId);
    const next = all.filter((t) => t.id !== templateId);
    if (next.length === all.length) throw new NotFoundException('Cycle template not found.');
    await this.writeAll(user.organizationId, user.userId, next);
    await this.record(user, ctx, 'appraisal.cycle_template.delete', templateId, null);
    return { id: templateId, deleted: true };
  }

  /** Instantiate a new draft cycle from a saved template. */
  async apply(
    user: AuthUser,
    ctx: RequestContext,
    templateId: string,
    dto: { name: string; startDate: string; endDate: string; submissionDeadline?: string },
  ): Promise<{ id: string }> {
    const all = await this.readAll(user.organizationId);
    const tpl = all.find((t) => t.id === templateId);
    if (!tpl) throw new NotFoundException('Cycle template not found.');
    if (new Date(dto.endDate) < new Date(dto.startDate)) {
      throw new BadRequestException('End date must be after start date.');
    }
    const created = await this.prisma.$transaction(async (tx) => {
      const cycle = await tx.appraisalCycle.create({
        data: {
          organizationId: user.organizationId,
          name: dto.name,
          startDate: new Date(dto.startDate),
          endDate: new Date(dto.endDate),
          submissionDeadline: dto.submissionDeadline ? new Date(dto.submissionDeadline) : null,
          status: 'draft',
          templateId: tpl.templateId,
          ratingScaleId: tpl.ratingScaleId,
          createdBy: user.userId,
          updatedBy: user.userId,
        },
      });
      if (tpl.sources.length > 0) {
        await tx.feedbackSource.createMany({
          data: tpl.sources.map((s) => ({
            cycleId: cycle.id,
            code: s.code,
            label: s.label,
            weight: s.weight,
            requiredCount: s.requiredCount,
            isAnonymous: s.isAnonymous,
            isActive: true,
            // Re-apply the quadrant questionnaire the saved cycle used. Templates saved
            // before this existed carry no value, so those quadrants inherit the cycle
            // questionnaire exactly as they did before.
            templateId: s.templateId ?? null,
          })),
        });
      }
      return cycle;
    });
    await this.record(user, ctx, 'appraisal.cycle.create_from_template', created.id, { templateId, templateName: tpl.name });
    await this.feedbackAudit.record({
      organizationId: user.organizationId,
      action: 'cycle.created',
      actorUserId: user.userId,
      actorName: user.email,
      cycleId: created.id,
      cycleName: dto.name,
      entityType: 'appraisal_cycle',
      entityId: created.id,
      newValue: { name: dto.name, fromTemplateId: templateId, fromTemplateName: tpl.name },
      ctx,
    });
    return { id: created.id };
  }

  private async readAll(orgId: string): Promise<CycleTemplate[]> {
    const row = await this.prisma.configuration.findFirst({
      where: { organizationId: orgId, module: MODULE, key: KEY, deletedAt: null },
      select: { value: true },
    });
    const value = row?.value as unknown as { templates?: CycleTemplate[] } | null;
    return Array.isArray(value?.templates) ? value!.templates : [];
  }

  private async writeAll(orgId: string, actorUserId: string, templates: CycleTemplate[]): Promise<void> {
    const value = { templates } as unknown as Prisma.InputJsonValue;
    const existing = await this.prisma.configuration.findFirst({
      where: { organizationId: orgId, module: MODULE, key: KEY, deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      await this.prisma.configuration.update({ where: { id: existing.id }, data: { value, updatedBy: actorUserId } });
    } else {
      await this.prisma.configuration.create({
        data: { organizationId: orgId, module: MODULE, key: KEY, value, createdBy: actorUserId, updatedBy: actorUserId },
      });
    }
  }

  private async record(user: AuthUser, ctx: RequestContext, action: string, entityId: string, newValue: unknown): Promise<void> {
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action,
      entityType: 'appraisal_cycle_template',
      entityId,
      newValue: newValue ?? undefined,
      ip: ctx.ip,
      device: ctx.device,
    });
  }
}
