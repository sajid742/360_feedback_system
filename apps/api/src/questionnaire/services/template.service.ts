import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { FeedbackAuditService } from '../../feedback-audit/feedback-audit.service';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';
import type { AddSectionDto, AddSectionQuestionDto, CreateTemplateDto } from '../questionnaire.dto';

const FULL = {
  sections: {
    orderBy: { sortOrder: 'asc' },
    include: {
      questions: {
        orderBy: { sortOrder: 'asc' },
        include: { question: { select: { id: true, text: true, type: true } } },
      },
    },
  },
} satisfies Prisma.QuestionnaireTemplateInclude;

type TemplateRow = Prisma.QuestionnaireTemplateGetPayload<{ include: typeof FULL }>;

function serialize(row: TemplateRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    version: row.version,
    sections: row.sections.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      sortOrder: s.sortOrder,
      questions: s.questions.map((sq) => ({
        id: sq.id,
        questionId: sq.questionId,
        text: sq.question.text,
        type: sq.question.type,
        sortOrder: sq.sortOrder,
        weightOverride: sq.weightOverride ? Number(sq.weightOverride) : null,
        isMandatoryOverride: sq.isMandatoryOverride,
      })),
    })),
  };
}

@Injectable()
export class TemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly feedbackAudit: FeedbackAuditService,
  ) {}

  async list(user: AuthUser): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.questionnaireTemplate.findMany({
      where: { organizationId: user.organizationId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { sections: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      version: r.version,
      sections: r._count.sections,
      updatedAt: r.updatedAt,
    }));
  }

  async get(user: AuthUser, id: string): Promise<Record<string, unknown>> {
    return serialize(await this.getOwned(user.organizationId, id));
  }

  async create(user: AuthUser, ctx: RequestContext, dto: CreateTemplateDto): Promise<Record<string, unknown>> {
    const row = await this.prisma.questionnaireTemplate.create({
      data: {
        organizationId: user.organizationId,
        name: dto.name,
        description: dto.description ?? null,
        createdBy: user.userId,
        updatedBy: user.userId,
      },
      include: FULL,
    });
    await this.record(user, ctx, 'questionnaire.template.create', row.id, dto);
    return serialize(row);
  }

  async addSection(user: AuthUser, id: string, dto: AddSectionDto): Promise<Record<string, unknown>> {
    const template = await this.getOwned(user.organizationId, id);
    this.assertDraft(template.status);
    await this.prisma.templateSection.create({
      data: {
        templateId: id,
        title: dto.title,
        description: dto.description ?? null,
        sortOrder: dto.sortOrder ?? template.sections.length,
      },
    });
    return this.get(user, id);
  }

  async removeSection(user: AuthUser, id: string, sectionId: string): Promise<Record<string, unknown>> {
    const template = await this.getOwned(user.organizationId, id);
    this.assertDraft(template.status);
    await this.prisma.templateSection.deleteMany({ where: { id: sectionId, templateId: id } });
    return this.get(user, id);
  }

  async addQuestion(user: AuthUser, id: string, sectionId: string, dto: AddSectionQuestionDto): Promise<Record<string, unknown>> {
    const template = await this.getOwned(user.organizationId, id);
    this.assertDraft(template.status);
    const section = template.sections.find((s) => s.id === sectionId);
    if (!section) throw new NotFoundException('Section not found.');
    const question = await this.prisma.question.findFirst({
      where: { id: dto.questionId, organizationId: user.organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!question) throw new NotFoundException('Question not found.');
    await this.prisma.sectionQuestion.create({
      data: {
        sectionId,
        questionId: dto.questionId,
        sortOrder: dto.sortOrder ?? section.questions.length,
        weightOverride: dto.weightOverride ?? null,
        isMandatoryOverride: dto.isMandatoryOverride ?? null,
        condition: dto.condition ? (dto.condition as Prisma.InputJsonValue) : Prisma.JsonNull,
      },
    });
    return this.get(user, id);
  }

  async removeQuestion(user: AuthUser, id: string, sectionQuestionId: string): Promise<Record<string, unknown>> {
    const template = await this.getOwned(user.organizationId, id);
    this.assertDraft(template.status);
    const sectionIds = template.sections.map((s) => s.id);
    await this.prisma.sectionQuestion.deleteMany({ where: { id: sectionQuestionId, sectionId: { in: sectionIds } } });
    return this.get(user, id);
  }

  async publish(user: AuthUser, ctx: RequestContext, id: string): Promise<Record<string, unknown>> {
    const template = await this.getOwned(user.organizationId, id);
    if (template.sections.length === 0) throw new BadRequestException('Add at least one section before publishing.');
    await this.prisma.questionnaireTemplate.update({ where: { id }, data: { status: 'published', updatedBy: user.userId } });
    await this.record(user, ctx, 'questionnaire.template.publish', id, null);
    // Feedback trail: questionnaire change that affects the cycles using this template.
    await this.feedbackAudit.record({
      organizationId: user.organizationId,
      action: 'questionnaire.published',
      actorUserId: user.userId,
      actorName: user.email,
      sourceType: null,
      entityType: 'questionnaire_template',
      entityId: id,
      newValue: { name: template.name, version: template.version },
      ctx,
    });
    return this.get(user, id);
  }

  async clone(user: AuthUser, ctx: RequestContext, id: string): Promise<Record<string, unknown>> {
    const source = await this.getOwned(user.organizationId, id);
    const clone = await this.prisma.$transaction(async (tx) => {
      const created = await tx.questionnaireTemplate.create({
        data: {
          organizationId: user.organizationId,
          name: `${source.name} (copy)`,
          description: source.description,
          status: 'draft',
          version: source.version + 1,
          createdBy: user.userId,
          updatedBy: user.userId,
        },
      });
      for (const section of source.sections) {
        const newSection = await tx.templateSection.create({
          data: { templateId: created.id, title: section.title, description: section.description, sortOrder: section.sortOrder },
        });
        if (section.questions.length > 0) {
          await tx.sectionQuestion.createMany({
            data: section.questions.map((q) => ({
              sectionId: newSection.id,
              questionId: q.questionId,
              sortOrder: q.sortOrder,
              weightOverride: q.weightOverride,
              isMandatoryOverride: q.isMandatoryOverride,
            })),
          });
        }
      }
      return created;
    });
    await this.record(user, ctx, 'questionnaire.template.clone', clone.id, { from: id });
    return this.get(user, clone.id);
  }

  private assertDraft(status: string): void {
    if (status !== 'draft') throw new BadRequestException('Only draft templates can be edited. Clone to make changes.');
  }

  private async getOwned(organizationId: string, id: string): Promise<TemplateRow> {
    const row = await this.prisma.questionnaireTemplate.findFirst({
      where: { id, organizationId, deletedAt: null },
      include: FULL,
    });
    if (!row) throw new NotFoundException('Template not found.');
    return row;
  }

  private async record(user: AuthUser, ctx: RequestContext, action: string, entityId: string, newValue: unknown): Promise<void> {
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action,
      entityType: 'questionnaire_template',
      entityId,
      newValue: newValue ?? undefined,
      ip: ctx.ip,
      device: ctx.device,
    });
  }
}
