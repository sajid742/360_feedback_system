import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';
import { serializeVersion } from '../mappers';

const VERSION_INCLUDE = {
  proficiencyLevels: true,
  indicators: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.CompetencyVersionInclude;

/**
 * Version lifecycle: draft -> active -> retired. Only drafts are editable;
 * activating auto-retires the previously active version; retired versions can
 * never be reactivated — clone a new draft instead (handoff §5).
 */
@Injectable()
export class VersionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async cloneDraft(
    user: AuthUser,
    ctx: RequestContext,
    competencyId: string,
  ): Promise<Record<string, unknown>> {
    const competency = await this.prisma.competency.findFirst({
      where: { id: competencyId, organizationId: user.organizationId, deletedAt: null },
      include: { versions: { where: { deletedAt: null }, include: VERSION_INCLUDE } },
    });
    if (!competency) throw new NotFoundException('Competency not found.');
    if (competency.versions.some((v) => v.status === 'draft')) {
      throw new ConflictException('A draft version already exists. Edit or activate it first.');
    }
    const source = [...competency.versions].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    )[0];
    const label = `v${competency.versions.length + 1}`;

    const draft = await this.prisma.$transaction(async (tx) => {
      const version = await tx.competencyVersion.create({
        data: {
          organizationId: user.organizationId,
          competencyId,
          versionLabel: label,
          status: 'draft',
          createdBy: user.userId,
          updatedBy: user.userId,
        },
      });
      if (source) await this.copyContent(tx, user, source, version.id);
      return tx.competencyVersion.findUniqueOrThrow({
        where: { id: version.id },
        include: VERSION_INCLUDE,
      });
    });

    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: 'competency.version.clone',
      entityType: 'competency_version',
      entityId: draft.id,
      newValue: { competencyId, label, clonedFrom: source?.id ?? null },
      ip: ctx.ip,
      device: ctx.device,
    });
    return serializeVersion(draft);
  }

  async activate(
    user: AuthUser,
    ctx: RequestContext,
    versionId: string,
  ): Promise<Record<string, unknown>> {
    const version = await this.prisma.competencyVersion.findFirst({
      where: { id: versionId, organizationId: user.organizationId, deletedAt: null },
    });
    if (!version) throw new NotFoundException('Version not found.');
    if (version.status !== 'draft') {
      throw new ConflictException('Only draft versions can be activated.');
    }

    const activated = await this.prisma.$transaction(async (tx) => {
      await tx.competencyVersion.updateMany({
        where: { competencyId: version.competencyId, status: 'active', deletedAt: null },
        data: { status: 'retired', updatedBy: user.userId },
      });
      await tx.competencyVersion.update({
        where: { id: versionId },
        data: { status: 'active', updatedBy: user.userId },
      });
      return tx.competencyVersion.findUniqueOrThrow({
        where: { id: versionId },
        include: VERSION_INCLUDE,
      });
    });

    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: 'competency.version.activate',
      entityType: 'competency_version',
      entityId: versionId,
      previousValue: { status: 'draft' },
      newValue: { status: 'active' },
      ip: ctx.ip,
      device: ctx.device,
    });
    return serializeVersion(activated);
  }

  private async copyContent(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    source: Prisma.CompetencyVersionGetPayload<{ include: typeof VERSION_INCLUDE }>,
    targetVersionId: string,
  ): Promise<void> {
    const levelIdMap = new Map<string, string>();
    for (const level of source.proficiencyLevels) {
      const created = await tx.proficiencyLevel.create({
        data: {
          organizationId: user.organizationId,
          versionId: targetVersionId,
          level: level.level,
          name: level.name,
          description: level.description,
        },
      });
      levelIdMap.set(level.id, created.id);
    }
    if (source.indicators.length === 0) return;
    await tx.behaviourIndicator.createMany({
      data: source.indicators.map((indicator) => ({
        organizationId: user.organizationId,
        versionId: targetVersionId,
        proficiencyLevelId: indicator.proficiencyLevelId
          ? (levelIdMap.get(indicator.proficiencyLevelId) ?? null)
          : null,
        type: indicator.type,
        text: indicator.text,
        sortOrder: indicator.sortOrder,
        createdBy: user.userId,
        updatedBy: user.userId,
      })),
    });
  }
}
