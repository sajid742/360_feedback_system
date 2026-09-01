import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';
import type { CreateIndicatorDto, IndicatorType, UpdateIndicatorDto } from '../dto/indicator.dto';
import { serializeIndicator } from '../mappers';

/**
 * Behaviour indicators. Editable only while the parent version is a DRAFT —
 * active/retired versions are immutable (clone a new draft to change them).
 */
@Injectable()
export class IndicatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser, versionId: string): Promise<Record<string, unknown>[]> {
    await this.getVersion(user.organizationId, versionId);
    const rows = await this.prisma.behaviourIndicator.findMany({
      where: { versionId, organizationId: user.organizationId, deletedAt: null },
      orderBy: { sortOrder: 'asc' },
    });
    return rows.map(serializeIndicator);
  }

  async add(
    user: AuthUser,
    ctx: RequestContext,
    versionId: string,
    dto: CreateIndicatorDto,
  ): Promise<Record<string, unknown>> {
    await this.assertDraft(user.organizationId, versionId);
    await this.assertLevel(user.organizationId, versionId, dto.proficiencyLevelId ?? null);
    const sortOrder = dto.sortOrder ?? (await this.nextSortOrder(versionId, dto.type));
    const row = await this.prisma.behaviourIndicator.create({
      data: {
        organizationId: user.organizationId,
        versionId,
        type: dto.type,
        text: dto.text,
        proficiencyLevelId: dto.proficiencyLevelId ?? null,
        sortOrder,
        createdBy: user.userId,
        updatedBy: user.userId,
      },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: 'competency.indicator.add',
      entityType: 'behaviour_indicator',
      entityId: row.id,
      newValue: dto,
      ip: ctx.ip,
      device: ctx.device,
    });
    return serializeIndicator(row);
  }

  async update(
    user: AuthUser,
    ctx: RequestContext,
    indicatorId: string,
    dto: UpdateIndicatorDto,
  ): Promise<Record<string, unknown>> {
    const existing = await this.getOwnedIndicator(user.organizationId, indicatorId);
    await this.assertDraft(user.organizationId, existing.versionId);
    if (dto.proficiencyLevelId !== undefined) {
      await this.assertLevel(user.organizationId, existing.versionId, dto.proficiencyLevelId);
    }
    const row = await this.prisma.behaviourIndicator.update({
      where: { id: indicatorId },
      data: {
        type: dto.type ?? existing.type,
        text: dto.text ?? existing.text,
        proficiencyLevelId:
          dto.proficiencyLevelId === undefined ? existing.proficiencyLevelId : dto.proficiencyLevelId,
        sortOrder: dto.sortOrder ?? existing.sortOrder,
        updatedBy: user.userId,
      },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: 'competency.indicator.update',
      entityType: 'behaviour_indicator',
      entityId: indicatorId,
      previousValue: existing,
      newValue: dto,
      ip: ctx.ip,
      device: ctx.device,
    });
    return serializeIndicator(row);
  }

  async remove(user: AuthUser, ctx: RequestContext, indicatorId: string): Promise<void> {
    const existing = await this.getOwnedIndicator(user.organizationId, indicatorId);
    await this.assertDraft(user.organizationId, existing.versionId);
    await this.prisma.behaviourIndicator.update({
      where: { id: indicatorId },
      data: { deletedAt: new Date(), updatedBy: user.userId },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: 'competency.indicator.delete',
      entityType: 'behaviour_indicator',
      entityId: indicatorId,
      ip: ctx.ip,
      device: ctx.device,
    });
  }

  private async getVersion(organizationId: string, versionId: string) {
    const version = await this.prisma.competencyVersion.findFirst({
      where: { id: versionId, organizationId, deletedAt: null },
    });
    if (!version) throw new NotFoundException('Version not found.');
    return version;
  }

  private async assertDraft(organizationId: string, versionId: string): Promise<void> {
    const version = await this.getVersion(organizationId, versionId);
    if (version.status !== 'draft') {
      throw new ConflictException('Only draft versions can be edited.');
    }
  }

  private async getOwnedIndicator(organizationId: string, indicatorId: string) {
    const row = await this.prisma.behaviourIndicator.findFirst({
      where: { id: indicatorId, organizationId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Indicator not found.');
    return row;
  }

  private async assertLevel(
    organizationId: string,
    versionId: string,
    levelId: string | null,
  ): Promise<void> {
    if (!levelId) return;
    const level = await this.prisma.proficiencyLevel.findFirst({
      where: { id: levelId, versionId, organizationId },
      select: { id: true },
    });
    if (!level) throw new BadRequestException('Proficiency level does not belong to this version.');
  }

  private async nextSortOrder(versionId: string, type: IndicatorType): Promise<number> {
    const last = await this.prisma.behaviourIndicator.findFirst({
      where: { versionId, type, deletedAt: null },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    return (last?.sortOrder ?? -1) + 1;
  }
}
