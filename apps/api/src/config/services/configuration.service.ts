import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';
import type { SetConfigurationDto } from '../dto/config.dto';

/** Generic per-tenant configuration store (module/key/JSON value). */
@Injectable()
export class ConfigurationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser, module?: string): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.configuration.findMany({
      where: { organizationId: user.organizationId, deletedAt: null, ...(module ? { module } : {}) },
      orderBy: [{ module: 'asc' }, { key: 'asc' }],
    });
    return rows.map((row) => ({ id: row.id, module: row.module, key: row.key, value: row.value }));
  }

  async set(
    user: AuthUser,
    ctx: RequestContext,
    dto: SetConfigurationDto,
  ): Promise<Record<string, unknown>> {
    // The configurations table uses a *partial* unique index (WHERE deleted_at IS
    // NULL); Postgres rejects ON CONFLICT against a partial index (42P10), so a
    // plain prisma.upsert() on the composite key fails at runtime. Do a manual
    // find-then-update/create instead.
    const found = await this.prisma.configuration.findFirst({
      where: { organizationId: user.organizationId, module: dto.module, key: dto.key, deletedAt: null },
      select: { id: true },
    });
    const row = found
      ? await this.prisma.configuration.update({
          where: { id: found.id },
          data: { value: dto.value as Prisma.InputJsonValue, updatedBy: user.userId },
        })
      : await this.prisma.configuration.create({
          data: {
            organizationId: user.organizationId,
            module: dto.module,
            key: dto.key,
            value: dto.value as Prisma.InputJsonValue,
            createdBy: user.userId,
            updatedBy: user.userId,
          },
        });
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: 'configuration.set',
      entityType: 'configuration',
      entityId: row.id,
      newValue: { module: dto.module, key: dto.key },
      ip: ctx.ip,
      device: ctx.device,
    });
    return { id: row.id, module: row.module, key: row.key, value: row.value };
  }

  async remove(user: AuthUser, ctx: RequestContext, id: string): Promise<void> {
    const existing = await this.prisma.configuration.findFirst({
      where: { id, organizationId: user.organizationId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Configuration not found.');
    await this.prisma.configuration.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: 'configuration.delete',
      entityType: 'configuration',
      entityId: id,
      ip: ctx.ip,
      device: ctx.device,
    });
  }
}
