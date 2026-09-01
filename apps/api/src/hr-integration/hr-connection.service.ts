import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { decryptSecret, encryptSecret } from '../auth/crypto/secret-crypto';
import { ALLOWED_KEYS, CONFIGURABLE_PROVIDERS, PROVIDER_FIELDS, SECRET_KEYS, type ConnectionFieldSpec } from './provider-connection';

const MODULE = 'hr_integration';
const KEY = 'connection';

export interface RedactedConnection {
  provider: string;
  fields: ConnectionFieldSpec[];
  /** Non-secret values as stored; secret values are blanked. */
  settings: Record<string, unknown>;
  /** Which secret fields currently have a value stored (so the UI can show "set"). */
  secretSet: Record<string, boolean>;
}

/**
 * Per-organization, per-provider HR connection settings, stored in the EXISTING
 * `configurations` table (module='hr_integration', key='connection') as a
 * provider-keyed map. Secret fields (API keys, client secrets, tokens, passwords)
 * are encrypted at rest with AES-256-GCM (reusing the app's secret-crypto helper)
 * and are NEVER returned to the client. Unknown providers/fields are rejected/dropped.
 *
 * No new table: the whole real-provider framework rides on the same config store
 * used by the mode/provider settings, so nothing else in the app changes.
 */
@Injectable()
export class HrConnectionService {
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

  /** Decrypted connection for a provider — for provider code only (never sent to the client). */
  async get(organizationId: string, provider: string): Promise<Record<string, unknown>> {
    const stored = (await this.all(organizationId))[provider] ?? {};
    const secrets = SECRET_KEYS[provider] ?? new Set<string>();
    const out: Record<string, unknown> = { ...stored };
    for (const k of secrets) {
      if (typeof out[k] === 'string' && out[k]) out[k] = this.tryDecrypt(out[k]);
    }
    return out;
  }

  /** Redacted view for the admin UI: secret values blanked, with a "is set" flag. */
  async redacted(organizationId: string, provider: string): Promise<RedactedConnection> {
    if (!CONFIGURABLE_PROVIDERS.has(provider)) {
      return { provider, fields: [], settings: {}, secretSet: {} };
    }
    const stored = (await this.all(organizationId))[provider] ?? {};
    const secrets = SECRET_KEYS[provider] ?? new Set<string>();
    const settings: Record<string, unknown> = {};
    const secretSet: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(stored)) {
      if (secrets.has(k)) { secretSet[k] = !!v; continue; } // never leak the secret value
      settings[k] = v;
    }
    for (const k of secrets) if (!(k in secretSet)) secretSet[k] = false;
    return { provider, fields: PROVIDER_FIELDS[provider], settings, secretSet };
  }

  /** Save (merge-patch) a provider's connection. Secret fields are encrypted; an
   *  empty secret is treated as "leave the existing value unchanged". */
  async save(organizationId: string, provider: string, settings: Record<string, unknown>): Promise<RedactedConnection> {
    if (!CONFIGURABLE_PROVIDERS.has(provider)) throw new BadRequestException('This provider has no connection settings.');
    const allowed = ALLOWED_KEYS[provider];
    const secrets = SECRET_KEYS[provider];
    const all = await this.all(organizationId);
    const current = { ...(all[provider] ?? {}) };

    for (const [k, v] of Object.entries(settings ?? {})) {
      if (!allowed.has(k)) continue; // drop unknown keys
      if (secrets.has(k)) {
        if (v === '' || v == null) continue; // keep the existing encrypted secret
        current[k] = encryptSecret(String(v));
      } else if (k === 'mapping') {
        current[k] = v && typeof v === 'object' ? v : {};
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
