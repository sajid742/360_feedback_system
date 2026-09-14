import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';

/**
 * Pluggable AI provider. Configuration is DATA, never hardcoded: it lives in the
 * per-tenant `configuration` store under module `ai`, key `provider`, as JSON:
 *
 *   { "enabled": true, "baseUrl": "https://api.openai.com/v1",
 *     "apiKey": "sk-…", "model": "gpt-4o-mini" }
 *
 * Any OpenAI-compatible `/chat/completions` endpoint works (OpenAI, Azure,
 * OpenRouter, a local Ollama/LM-Studio gateway, …). When no provider is
 * configured — or a call fails — callers fall back to the deterministic
 * heuristic engine, so the AI module is fully functional with no key.
 */
export interface AiProviderConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** What an administrator is allowed to see back. Never the key. */
export interface AiProviderView {
  configured: boolean;
  enabled: boolean;
  baseUrl: string | null;
  model: string | null;
  /** Enough to recognise WHICH key is stored, never enough to use it. */
  apiKeyHint: string | null;
}

const DEFAULT_MODEL = 'gpt-4o-mini';

@Injectable()
export class AiProviderService {
  private readonly logger = new Logger(AiProviderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Resolve the tenant's provider config, or null when unset/disabled/incomplete. */
  async getConfig(orgId: string): Promise<AiProviderConfig | null> {
    const row = await this.prisma.configuration.findFirst({
      where: { organizationId: orgId, module: 'ai', key: 'provider', deletedAt: null },
      select: { value: true },
    });
    const value = row?.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    const enabled = v.enabled !== false; // default on when a key is present
    const baseUrl = typeof v.baseUrl === 'string' ? v.baseUrl.trim().replace(/\/+$/, '') : '';
    const apiKey = typeof v.apiKey === 'string' ? v.apiKey.trim() : '';
    const model = typeof v.model === 'string' && v.model.trim() ? v.model.trim() : DEFAULT_MODEL;
    if (!enabled || !baseUrl || !apiKey) return null;
    return { enabled, baseUrl, apiKey, model };
  }

  async isConfigured(orgId: string): Promise<boolean> {
    return (await this.getConfig(orgId)) !== null;
  }

  /**
   * Ask the configured provider for a completion. Returns the assistant text, or
   * null if no provider is configured or the call fails (caller uses heuristics).
   */
  async complete(orgId: string, systemPrompt: string, userPrompt: string): Promise<string | null> {
    const config = await this.getConfig(orgId);
    if (!config) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          temperature: 0.4,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.logger.warn(`AI provider returned ${response.status}; falling back to heuristics.`);
        return null;
      }
      const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      const text = json.choices?.[0]?.message?.content?.trim();
      return text && text.length > 0 ? text : null;
    } catch (error) {
      this.logger.warn(`AI provider call failed (${(error as Error).message}); falling back to heuristics.`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /* ------------------------------------------------------- administration */

  /**
   * What the settings screen shows.
   *
   * THE KEY NEVER COMES BACK. Only the last four characters, so an administrator can
   * tell which key is stored — "is this the old one?" is a real question — without the
   * answer being usable. This is why the `ai` configuration module is reserved: the
   * generic configuration endpoint returns stored values verbatim, and that endpoint
   * needs only `configuration.read`, which HR/Admin holds.
   */
  async view(orgId: string): Promise<AiProviderView> {
    const row = await this.prisma.configuration.findFirst({
      where: { organizationId: orgId, module: 'ai', key: 'provider', deletedAt: null },
      select: { value: true },
    });
    const v = (row?.value ?? null) as Record<string, unknown> | null;
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      return { configured: false, enabled: false, baseUrl: null, model: null, apiKeyHint: null };
    }
    const apiKey = typeof v.apiKey === 'string' ? v.apiKey : '';
    const baseUrl = typeof v.baseUrl === 'string' ? v.baseUrl : '';
    return {
      configured: Boolean(baseUrl && apiKey) && v.enabled !== false,
      enabled: v.enabled !== false,
      baseUrl: baseUrl || null,
      model: typeof v.model === 'string' && v.model.trim() ? v.model.trim() : DEFAULT_MODEL,
      apiKeyHint: apiKey ? `…${apiKey.slice(-4)}` : null,
    };
  }

  /**
   * Save the provider.
   *
   * An OMITTED key keeps the stored one. Changing the model or turning the provider off
   * must not require re-typing a secret the screen cannot show you — an interface that
   * demands it teaches people to keep the key in a text file, which is worse than
   * anything it protects against.
   */
  async save(
    user: AuthUser,
    ctx: RequestContext,
    input: { enabled?: boolean; baseUrl: string; apiKey?: string; model?: string },
  ): Promise<AiProviderView> {
    const baseUrl = this.assertUsableBaseUrl(input.baseUrl);
    const existing = await this.prisma.configuration.findFirst({
      where: { organizationId: user.organizationId, module: 'ai', key: 'provider', deletedAt: null },
      select: { id: true, value: true },
    });
    const previous = (existing?.value ?? {}) as Record<string, unknown>;
    const apiKey = input.apiKey?.trim() ? input.apiKey.trim() : String(previous.apiKey ?? '');
    if (!apiKey) throw new BadRequestException('An API key is required the first time a provider is saved.');

    const value = {
      enabled: input.enabled !== false,
      baseUrl,
      apiKey,
      model: input.model?.trim() || String(previous.model ?? '') || DEFAULT_MODEL,
    };

    if (existing) {
      await this.prisma.configuration.update({
        where: { id: existing.id },
        data: { value, updatedBy: user.userId },
      });
    } else {
      await this.prisma.configuration.create({
        data: {
          organizationId: user.organizationId,
          module: 'ai',
          key: 'provider',
          value,
          createdBy: user.userId,
          updatedBy: user.userId,
        },
      });
    }

    // Audited WITHOUT the key, and with a flag for whether the key changed — which is
    // the fact an auditor actually needs.
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: existing ? 'ai.provider.updated' : 'ai.provider.configured',
      entityType: 'configuration',
      entityId: existing?.id ?? user.organizationId,
      newValue: {
        enabled: value.enabled,
        baseUrl: value.baseUrl,
        model: value.model,
        apiKeyChanged: Boolean(input.apiKey?.trim()),
      },
      ...ctx,
    });
    return this.view(user.organizationId);
  }

  /** Remove the provider entirely. Insights fall back to the built-in engine. */
  async remove(user: AuthUser, ctx: RequestContext): Promise<AiProviderView> {
    const existing = await this.prisma.configuration.findFirst({
      where: { organizationId: user.organizationId, module: 'ai', key: 'provider', deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      await this.prisma.configuration.update({
        where: { id: existing.id },
        data: { deletedAt: new Date(), updatedBy: user.userId },
      });
      await this.audit.record({
        organizationId: user.organizationId,
        userId: user.userId,
        action: 'ai.provider.removed',
        entityType: 'configuration',
        entityId: existing.id,
        ...ctx,
      });
    }
    return this.view(user.organizationId);
  }

  /**
   * Try the saved provider with a trivial prompt.
   *
   * Worth its own route because the alternative is discovering a wrong key when a
   * manager opens someone's insights and silently gets the heuristic paragraph — the
   * fallback is designed to be invisible, which is exactly what makes a misconfiguration
   * hard to notice.
   */
  async test(orgId: string): Promise<{ ok: boolean; model: string | null; detail: string }> {
    const config = await this.getConfig(orgId);
    if (!config) {
      return { ok: false, model: null, detail: 'No provider is configured, or it is turned off.' };
    }
    const answer = await this.complete(
      orgId,
      'You are a connection test. Reply with the single word OK.',
      'Reply with OK.',
    );
    return answer
      ? { ok: true, model: config.model, detail: 'The provider answered.' }
      : {
          ok: false,
          model: config.model,
          detail: 'The provider did not answer. Check the base URL, the key and the model name, then look at the application log.',
        };
  }

  /**
   * Refuse a base URL that would put the key on the wire in clear.
   *
   * `http://` to anything but a loopback address sends the Authorization header in plain
   * text on every call. Loopback is allowed because a self-hosted Ollama or LM Studio on
   * the same machine is a normal and sensible deployment.
   */
  private assertUsableBaseUrl(raw: string): string {
    const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
    if (!trimmed) throw new BadRequestException('A base URL is required.');
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new BadRequestException('That is not a valid URL. It should look like https://api.openai.com/v1');
    }

    if (url.protocol === 'https:') return trimmed;
    if (url.protocol !== 'http:') {
      throw new BadRequestException('The base URL must start with https:// or http://.');
    }

    // Plain http is allowed ONLY where the request cannot leave the private network.
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (isCloudMetadataHost(host)) {
      throw new BadRequestException(
        'That address is a cloud metadata endpoint, not a language model. It is refused deliberately.',
      );
    }
    if (isPrivateHost(host)) return trimmed;

    throw new BadRequestException(
      'Use https for an address on the public internet — plain http would send the API key across it in clear text. ' +
        'http is accepted only for a model on your own private network: localhost, a container or service name, ' +
        'host.docker.internal, or a 10.x / 172.16–31.x / 192.168.x address.',
    );
  }
}

/**
 * Is this host somewhere a request physically cannot leave the private network?
 *
 * WHY THIS IS WIDER THAN LOOPBACK. It used to accept only `localhost`, `127.0.0.1` and
 * `::1`, which sounds strict and is, in a container, useless: the API runs in its own
 * container, so `localhost` means the API container itself — not the host, and not a
 * model running beside it. The one deployment shape where sending nothing to a third
 * party is possible was the one shape the rule forbade, and an administrator following
 * the advice to self-host got a 400.
 *
 * Everything below is unroutable from the public internet, so plain http over it never
 * crosses a network a stranger can listen on. Anything else still needs TLS.
 */
export function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'host.docker.internal') return true;

  // A bare name with no dots is a container or Kubernetes service name — it resolves
  // only inside the network it belongs to.
  if (!host.includes('.') && !/^[0-9a-f:]+$/i.test(host)) return true;

  // Internal DNS suffixes.
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.svc.cluster.local')) return true;

  // IPv4 private and loopback ranges.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([a, b, Number(v4[3]), Number(v4[4])].some((n) => n > 255)) return false;
    if (a === 127) return true;                    // loopback
    if (a === 10) return true;                     // 10.0.0.0/8
    if (a === 192 && b === 168) return true;       // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    return false;                                  // 169.254.x.x lands here, refused
  }

  // IPv6 loopback and unique-local (fc00::/7).
  if (host === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;

  return false;
}

/**
 * Cloud metadata endpoints, refused even though they look private.
 *
 * `169.254.169.254` and `metadata.google.internal` hand out instance credentials to
 * anything that asks. No language model lives there, and an address that would otherwise
 * pass the `.internal` rule should not be the way someone points this application at the
 * server's own IAM role.
 */
export function isCloudMetadataHost(host: string): boolean {
  if (host === 'metadata.google.internal' || host === 'metadata') return true;
  // The whole link-local range, which is where every provider puts its metadata service.
  return /^169\.254\./.test(host) || /^fe80:/i.test(host);
}
