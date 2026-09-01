import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

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

@Injectable()
export class AiProviderService {
  private readonly logger = new Logger(AiProviderService.name);

  constructor(private readonly prisma: PrismaService) {}

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
    const model = typeof v.model === 'string' && v.model.trim() ? v.model.trim() : 'gpt-4o-mini';
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
}
