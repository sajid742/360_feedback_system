import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';
import type { CreateFeatureFlagDto, UpdateFeatureFlagDto } from '../dto/config.dto';

@Injectable()
export class FeatureFlagService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Whether a feature flag is on for an organisation (F27).
   *
   * The flag was only honoured by the frontend menu, so turning "AI Insights" off
   * hid the nav item while the route and every AI endpoint kept working for anyone
   * who typed the URL. A flag that a user can walk around isn't a flag. Unset keeps
   * the supplied default, so existing organisations are unaffected.
   */
  async isEnabled(orgId: string, key: string, defaultEnabled: boolean): Promise<boolean> {
    const row = await this.prisma.featureFlag.findFirst({
      where: { organizationId: orgId, key },
      select: { isEnabled: true },
    });
    return row ? row.isEnabled : defaultEnabled;
  }

  async list(user: AuthUser): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.featureFlag.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { key: 'asc' },
    });
    return rows.map(this.serialize);
  }

  async create(
    user: AuthUser,
    ctx: RequestContext,
    dto: CreateFeatureFlagDto,
  ): Promise<Record<string, unknown>> {
    const clash = await this.prisma.featureFlag.findFirst({
      where: { organizationId: user.organizationId, key: dto.key },
      select: { id: true },
    });
    if (clash) throw new ConflictException('A feature flag with this key already exists.');
    const row = await this.prisma.featureFlag.create({
      data: {
        organizationId: user.organizationId,
        key: dto.key,
        isEnabled: dto.isEnabled ?? false,
        description: dto.description ?? null,
        createdBy: user.userId,
        updatedBy: user.userId,
      },
    });
    await this.record(user, ctx, 'configuration.feature_flag.create', row.id, dto);
    return this.serialize(row);
  }

  async update(
    user: AuthUser,
    ctx: RequestContext,
    id: string,
    dto: UpdateFeatureFlagDto,
  ): Promise<Record<string, unknown>> {
    const existing = await this.getOwned(user, id);
    const row = await this.prisma.featureFlag.update({
      where: { id },
      data: {
        isEnabled: dto.isEnabled ?? existing.isEnabled,
        description: dto.description ?? existing.description,
        updatedBy: user.userId,
      },
    });
    await this.record(user, ctx, 'configuration.feature_flag.update', id, dto);
    return this.serialize(row);
  }

  async remove(user: AuthUser, ctx: RequestContext, id: string): Promise<void> {
    await this.getOwned(user, id);
    await this.prisma.featureFlag.delete({ where: { id } });
    await this.record(user, ctx, 'configuration.feature_flag.delete', id, null);
  }

  private async getOwned(user: AuthUser, id: string) {
    const row = await this.prisma.featureFlag.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!row) throw new NotFoundException('Feature flag not found.');
    return row;
  }

  private serialize(row: {
    id: string;
    key: string;
    isEnabled: boolean;
    description: string | null;
  }): Record<string, unknown> {
    return { id: row.id, key: row.key, isEnabled: row.isEnabled, description: row.description };
  }

  private async record(
    user: AuthUser,
    ctx: RequestContext,
    action: string,
    entityId: string,
    newValue: unknown,
  ): Promise<void> {
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action,
      entityType: 'feature_flag',
      entityId,
      newValue: newValue ?? undefined,
      ip: ctx.ip,
      device: ctx.device,
    });
  }
}
