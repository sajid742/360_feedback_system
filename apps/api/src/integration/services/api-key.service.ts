import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';
import type { CreateApiKeyDto } from '../dto/integration.dto';
import { EntitlementService } from '../../license/entitlement.service';

export interface ValidatedApiKey {
  id: string;
  organizationId: string;
  scopes: string[];
}

/** Programmatic API keys. The secret is shown ONCE at creation and only its
 *  SHA-256 hash is stored — validation re-hashes the presented key and matches. */
@Injectable()
export class ApiKeyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementService,
  ) {}

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  async list(user: AuthUser): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.apiKey.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scopes: r.scopes,
      lastUsedAt: r.lastUsedAt,
      expiresAt: r.expiresAt,
      revokedAt: r.revokedAt,
      status: r.revokedAt ? 'revoked' : r.expiresAt && r.expiresAt < new Date() ? 'expired' : 'active',
      createdAt: r.createdAt,
    }));
  }

  /** Create a key and return the one-time plaintext secret alongside metadata. */
  async create(user: AuthUser, ctx: RequestContext, dto: CreateApiKeyDto): Promise<Record<string, unknown>> {
    await this.entitlements.assertWithinLimit(user.organizationId, 'maxApiKeys', 1);
    const prefix = `e360_${randomBytes(4).toString('hex')}`; // e.g. e360_1a2b3c4d
    const secret = randomBytes(24).toString('base64url');
    const plaintext = `${prefix}.${secret}`;

    const row = await this.prisma.apiKey.create({
      data: {
        organizationId: user.organizationId,
        name: dto.name,
        prefix,
        keyHash: this.hash(plaintext),
        scopes: dto.scopes ?? [],
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        createdBy: user.userId,
      },
    });

    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: 'integration.api_key.create',
      entityType: 'api_key',
      entityId: row.id,
      newValue: { name: dto.name, scopes: dto.scopes ?? [] },
      ip: ctx.ip,
      device: ctx.device,
    });

    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      scopes: row.scopes,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      key: plaintext, // shown once — never returned again
    };
  }

  async revoke(user: AuthUser, ctx: RequestContext, id: string): Promise<void> {
    const existing = await this.prisma.apiKey.findFirst({
      where: { id, organizationId: user.organizationId },
      select: { id: true, revokedAt: true },
    });
    if (!existing) throw new NotFoundException('API key not found.');
    if (!existing.revokedAt) {
      await this.prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
      await this.audit.record({
        organizationId: user.organizationId,
        userId: user.userId,
        action: 'integration.api_key.revoke',
        entityType: 'api_key',
        entityId: id,
        ip: ctx.ip,
        device: ctx.device,
      });
    }
  }

  /** Validate a presented key: active, unexpired, unrevoked. Bumps lastUsedAt. */
  async validate(plaintext: string): Promise<ValidatedApiKey | null> {
    if (!plaintext) return null;
    const row = await this.prisma.apiKey.findUnique({ where: { keyHash: this.hash(plaintext) } });
    if (!row || row.revokedAt) return null;
    if (row.expiresAt && row.expiresAt < new Date()) return null;
    await this.prisma.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } });
    return { id: row.id, organizationId: row.organizationId, scopes: row.scopes };
  }
}
