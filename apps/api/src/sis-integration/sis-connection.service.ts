import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { decryptSecret, encryptSecret } from '../auth/crypto/secret-crypto';
import { SIS_ALLOWED_KEYS, SIS_CONFIGURABLE_PROVIDERS, SIS_PROVIDER_FIELDS, SIS_SECRET_KEYS, type SisConnectionFieldSpec } from './provider-connection';

const MODULE = 'sis_integration';
const KEY = 'connection';

export interface RedactedSisConnection {
  provider: string;
  fields: SisConnectionFieldSpec[];
  settings: Record<string, unknown>;
  secretSet: Record<string, boolean>;
}

/**
 * Per-organization, per-provider SIS connection settings, stored in the EXISTING
 * `configurations` table (module='sis_integration', key='connection'). Secret fields
 * are AES-256-GCM encrypted at rest (reusing the app's secret-crypto helper) and are
 * NEVER returned to the client. Same design as the HR integration connection store.
 */
@Injectable()
export class SisConnectionService {
  constructor(private readonly prisma: PrismaService) {}

  private async all(organizationId: string): Promise<Record<string, Record<string, unknown>>> {
    const row = await this.prisma.configuration.findFirst({
      where: { organizationId, module: MODULE, key: KEY, deletedAt: null },
      select: { value: true },
    });
    return ((row?.value as Record<string, Record<string, unknown>>) ?? {}) || {};
  }

  private tryDecrypt(v: unknown): string {
    if (typeof v !== 'string' || !v) return '';
    try { return decryptSecret(v); } catch { return ''; }
  }

  /** Decrypted connection for a provider — for provider code only. */
  async get(organizationId: string, provider: string): Promise<Record<string, unknown>> {
    const stored = (await this.all(organizationId))[provider] ?? {};
    const secrets = SIS_SECRET_KEYS[provider] ?? new Set<string>();
    const out: Record<string, unknown> = { ...stored };
    for (const k of secrets) if (typeof out[k] === 'string' && out[k]) out[k] = this.tryDecrypt(out[k]);
    return out;
  }

  /** Redacted view for the admin UI: secret values blanked, with an "is set" flag. */
  async redacted(organizationId: string, provider: string): Promise<RedactedSisConnection> {
    if (!SIS_CONFIGURABLE_PROVIDERS.has(provider)) return { provider, fields: [], settings: {}, secretSet: {} };
    const stored = (await this.all(organizationId))[provider] ?? {};
    const secrets = SIS_SECRET_KEYS[provider] ?? new Set<string>();
    const settings: Record<string, unknown> = {};
    const secretSet: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(stored)) {
      if (secrets.has(k)) { secretSet[k] = !!v; continue; }
      settings[k] = v;
    }
    for (const k of secrets) if (!(k in secretSet)) secretSet[k] = false;
    return { provider, fields: SIS_PROVIDER_FIELDS[provider], settings, secretSet };
  }

  async save(organizationId: string, provider: string, settings: Record<string, unknown>): Promise<RedactedSisConnection> {
    if (!SIS_CONFIGURABLE_PROVIDERS.has(provider)) throw new BadRequestException('This provider has no connection settings.');
    const allowed = SIS_ALLOWED_KEYS[provider];
    const secrets = SIS_SECRET_KEYS[provider];
    const all = await this.all(organizationId);
    const current = { ...(all[provider] ?? {}) };
    for (const [k, v] of Object.entries(settings ?? {})) {
      if (!allowed.has(k)) continue;
      if (secrets.has(k)) {
        if (v === '' || v == null) continue; // keep existing secret
        current[k] = encryptSecret(String(v));
      } else {
        current[k] = typeof v === 'string' ? v.slice(0, 2000) : v;
      }
    }
    all[provider] = current;
    const value = all as unknown as Prisma.InputJsonValue;
    const existing = await this.prisma.configuration.findFirst({
      where: { organizationId, module: MODULE, key: KEY, deletedAt: null },
      select: { id: true },
    });
    if (existing) await this.prisma.configuration.update({ where: { id: existing.id }, data: { value } });
    else await this.prisma.configuration.create({ data: { organizationId, module: MODULE, key: KEY, value } });
    return this.redacted(organizationId, provider);
  }
}
