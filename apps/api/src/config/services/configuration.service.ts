import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';
import type { SetConfigurationDto } from '../dto/config.dto';

/** Generic per-tenant configuration store (module/key/JSON value). */
/**
 * Configuration modules a tenant may never write through this endpoint.
 *
 * `POST /configuration` takes a free-form module and key, so before this list a user
 * holding `configuration.manage` could write `module='license', key='current'` — that
 * is, install or un-suspend their own licence — and read the raw licence key straight
 * back out of `GET /configuration?module=license`. Commercial state must have no
 * tenant-facing write path at all. The licence and subscription services own these
 * rows and reach them through their own code paths, not through here.
 */
// `ai` is reserved for the same reason the others are, and it was the omission that
// mattered most in practice: the AI provider row holds a live API key, and this generic
// endpoint returns stored values verbatim to anyone with `configuration.read` — which
// HR/Admin holds by default. The key is now written and read only through
// `/ai/provider`, which never returns it.
const RESERVED_MODULES = new Set(['license', 'subscription', 'billing', 'platform', 'ai']);

@Injectable()
export class ConfigurationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private assertNotReserved(module: string): void {
    if (!RESERVED_MODULES.has(module.trim().toLowerCase())) return;
    throw new BadRequestException(
      `"${module}" is managed by the application and cannot be set here.`,
    );
  }

  async list(user: AuthUser, module?: string): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.configuration.findMany({
      where: { organizationId: user.organizationId, deletedAt: null, ...(module ? { module } : {}) },
      orderBy: [{ module: 'asc' }, { key: 'asc' }],
    });
    // Reserved rows are filtered out rather than masked: the licence key is a secret,
    // and the Licence screen reads it through the licence API, which is the surface
    // that decides what an administrator may see.
    return rows
      .filter((row) => !RESERVED_MODULES.has(row.module))
      .map((row) => ({ id: row.id, module: row.module, key: row.key, value: row.value }));
  }

  async set(
    user: AuthUser,
    ctx: RequestContext,
    dto: SetConfigurationDto,
  ): Promise<Record<string, unknown>> {
    this.assertNotReserved(dto.module);
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
    // Not found, not forbidden: a reserved row is invisible through this endpoint, so
    // its absence here should read the same way as any other missing row.
    if (!existing || RESERVED_MODULES.has(existing.module)) throw new NotFoundException('Configuration not found.');
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
