import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import type { Channel } from './providers/types';

/* ------------------------------------------------------------------ *
 * Provider configuration models. Every field is stored in the tenant
 * `configurations` table (module='communication') and editable at runtime
 * via the admin UI — no code change is needed to point at a different
 * SMTP host, SMS gateway, or WhatsApp provider.
 * ------------------------------------------------------------------ */

export interface EmailConfig {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;            // TLS/SSL
  auth: boolean;              // whether to send SMTP AUTH credentials
  user: string;
  pass: string;
  senderName: string;         // display name on the From header
  from: string;               // sender email address
  connectionTimeout: number;  // ms
  /**
   * Send even when the server's TLS certificate cannot be verified. Off by default and
   * deliberately explicit. It exists for two real cases: an internal mail server with a
   * self-signed certificate, and a workstation where antivirus or a corporate proxy
   * inspects HTTPS and re-signs the connection with an authority Node does not trust.
   * NODE_EXTRA_CA_CERTS is the better fix — it keeps verification switched on.
   */
  allowUntrustedCertificate?: boolean;
}

export type SmsProvider = 'twilio' | 'generic';
export type SmsAuthType = 'none' | 'apikey' | 'basic' | 'bearer' | 'oauth2';

export interface SmsConfig {
  enabled: boolean;
  provider: SmsProvider;
  senderId: string;           // Sender ID / From
  // Twilio
  accountSid?: string;
  authToken?: string;
  // Generic HTTP gateway
  endpoint?: string;          // Provider URL / API endpoint
  httpMethod?: 'POST' | 'GET';
  bodyFormat?: 'json' | 'form';
  authType?: SmsAuthType;
  apiKey?: string;            // apikey / bearer token value
  apiKeyHeader?: string;      // header carrying the api key (default Authorization)
  username?: string;          // basic auth
  password?: string;          // basic auth
  oauthTokenUrl?: string;     // oauth2 client-credentials token endpoint
  oauthClientId?: string;
  oauthClientSecret?: string;
  toParam?: string;           // request field for the recipient (default "to")
  messageParam?: string;      // request field for the message (default "message")
  fromParam?: string;         // request field for the sender (default "from")
  // Retry policy
  retryMaxAttempts?: number;  // total attempts (>=1)
  retryBackoffMs?: number;    // delay between attempts
}

export type WhatsAppProvider = 'meta' | 'twilio' | 'waha' | 'mock';

export interface WhatsAppConfig {
  enabled: boolean;
  provider: WhatsAppProvider;
  baseUrl?: string;           // graph/twilio/WAHA base URL
  // Meta Cloud API
  phoneNumberId?: string;
  accessToken?: string;
  // Twilio
  accountSid?: string;
  authToken?: string;
  // WAHA
  session?: string;           // WAHA session name (default "default")
  apiKey?: string;            // WAHA X-Api-Key
  // common
  businessNumber?: string;    // business/sender number (from)
  webhookUrl?: string;
  webhookSecret?: string;
  /** Legacy/simple flag — equivalent to provider='mock' (kept for compatibility). */
  mock?: boolean;
}

export interface CommGeneral {
  /** The EFFECTIVE public base URL — what outbound links are actually built from. */
  publicBaseUrl: string;
  /**
   * What an administrator explicitly saved, which may be empty. Empty means "inherit
   * from PUBLIC_APP_URL". Keeping this separate from the effective value above is what
   * stops the default being frozen into the database — see `resolvePublicBaseUrl`.
   */
  publicBaseUrlConfigured?: string;
  webhookSecret?: string;
}

/** Where the effective public base URL came from — surfaced in the admin UI. */
export type PublicBaseUrlSource = 'database' | 'environment' | 'default';

export const DEV_FALLBACK_APP_URL = 'http://localhost:5173';

/**
 * Hosts that can never be opened by an external recipient: loopback, the wildcard
 * bind address, and the Docker service names this stack uses. A link built on any of
 * these resolves to the recipient's OWN machine (or to nothing), which is exactly the
 * "I received a localhost link" symptom.
 */
export function isUnreachablePublicHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true; // unparseable is certainly not a usable public URL
  }
  return (
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    // Docker Compose service names — internal to the container network only.
    host === 'api' || host === 'web' || host === 'waha' || host === 'mock-sis' || host === 'postgres'
  );
}

/** Trailing slashes are stripped once, here, so no caller has to think about it. */
function normaliseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * The single place the public base URL is decided.
 *
 * PRECEDENCE, and why:
 *   1. An explicitly saved value that is externally reachable — an administrator's
 *      deliberate per-tenant choice, which must win over any server-wide default.
 *   2. PUBLIC_APP_URL from the environment.
 *   3. localhost, for development only.
 *
 * The rule that matters is the one in the middle: a saved value pointing at localhost
 * (or a Docker service name) NEVER beats a real PUBLIC_APP_URL. That combination is
 * always the historical bug rather than a deliberate choice — the admin UI used to
 * pre-fill the field with the resolved default and post it straight back, freezing
 * "http://localhost:5173" into the `configurations` table. From that moment
 * PUBLIC_APP_URL was ignored for good, and every parent link went out pointing at the
 * recipient's own machine. Deferring to the environment in that one case repairs those
 * installations without anyone having to find and clear the stored value.
 */
export function resolvePublicBaseUrl(stored: string | undefined | null): { url: string; source: PublicBaseUrlSource } {
  const saved = normaliseUrl(stored ?? '');
  const fromEnv = normaliseUrl(process.env.PUBLIC_APP_URL ?? '');

  if (saved && !isUnreachablePublicHost(saved)) return { url: saved, source: 'database' };
  if (fromEnv && !isUnreachablePublicHost(fromEnv)) return { url: fromEnv, source: 'environment' };
  if (saved) return { url: saved, source: 'database' };
  if (fromEnv) return { url: fromEnv, source: 'environment' };
  return { url: DEV_FALLBACK_APP_URL, source: 'default' };
}

const DEFAULT_EMAIL: EmailConfig = {
  enabled: false, host: '', port: 587, secure: false, auth: true, user: '', pass: '', senderName: '', from: '', connectionTimeout: 10000, allowUntrustedCertificate: false,
};
const DEFAULT_SMS: SmsConfig = {
  enabled: false, provider: 'twilio', senderId: '', httpMethod: 'POST', bodyFormat: 'json', authType: 'bearer',
  toParam: 'to', messageParam: 'message', fromParam: 'from', retryMaxAttempts: 3, retryBackoffMs: 1000,
};
const DEFAULT_WHATSAPP: WhatsAppConfig = {
  enabled: false, provider: 'meta', baseUrl: '', phoneNumberId: '', session: 'default',
};

/** Reads/writes communication provider config (configurations, module='communication'). */
@Injectable()
export class CommunicationSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async email(orgId: string): Promise<EmailConfig | null> {
    const v = await this.read<Partial<EmailConfig>>(orgId, 'email');
    return v ? { ...DEFAULT_EMAIL, ...v } : null;
  }
  async sms(orgId: string): Promise<SmsConfig | null> {
    const v = await this.read<Partial<SmsConfig>>(orgId, 'sms');
    return v ? { ...DEFAULT_SMS, ...v } : null;
  }
  async whatsapp(orgId: string): Promise<WhatsAppConfig | null> {
    const v = await this.read<Partial<WhatsAppConfig>>(orgId, 'whatsapp');
    if (!v) return null;
    const merged = { ...DEFAULT_WHATSAPP, ...v };
    // Back-compat: an old `mock:true` config maps onto provider='mock'.
    if (merged.mock && merged.provider === 'meta') merged.provider = 'mock';
    return merged;
  }
  async general(orgId: string): Promise<CommGeneral> {
    const value = await this.read<CommGeneral>(orgId, 'general');
    // A row written before this field existed carries its explicit value in
    // `publicBaseUrl`; newer rows use `publicBaseUrlConfigured` and may leave it blank
    // to mean "inherit from PUBLIC_APP_URL".
    const configured = value?.publicBaseUrlConfigured ?? value?.publicBaseUrl ?? '';
    const { url } = resolvePublicBaseUrl(configured);
    return { ...(value ?? {}), publicBaseUrl: url, publicBaseUrlConfigured: configured };
  }

  /** The effective public base URL plus where it came from, for the settings screen. */
  async publicBaseUrlInfo(orgId: string): Promise<{ url: string; source: PublicBaseUrlSource; configured: string; usable: boolean }> {
    const value = await this.read<CommGeneral>(orgId, 'general');
    const configured = value?.publicBaseUrlConfigured ?? value?.publicBaseUrl ?? '';
    const { url, source } = resolvePublicBaseUrl(configured);
    return { url, source, configured, usable: !isUnreachablePublicHost(url) };
  }

  /**
   * The base URL for a link that leaves the building — a parent evaluation, a password
   * reset. Refuses rather than sending a link the recipient cannot possibly open.
   *
   * In development a loopback URL is correct and normal, so this only warns. Anywhere
   * else it throws: a WhatsApp message containing "http://localhost:5173/evaluate/…"
   * is worse than no message, because it looks delivered, consumes a one-time token,
   * and the parent simply cannot use it.
   */
  async requireExternalBaseUrl(orgId: string): Promise<string> {
    const { url, source } = await this.publicBaseUrlInfo(orgId);
    if (!isUnreachablePublicHost(url)) return url;

    const advice =
      `The application's public URL is "${url}" (from ${source === 'database' ? 'Communication → Providers' : source === 'environment' ? 'PUBLIC_APP_URL' : 'the built-in development default'}), ` +
      'which points at the recipient\'s own machine and cannot be opened by them. ' +
      'Set PUBLIC_APP_URL to the address people actually use to reach this application — ' +
      'for example PUBLIC_APP_URL=http://192.168.1.20:8080 on a LAN server, or ' +
      'https://360.example.com in production — then restart the API. It can also be set per ' +
      'organisation under Communication → Providers → Public application URL.';

    if (process.env.NODE_ENV === 'production') throw new BadRequestException(`Refusing to send an unreachable link. ${advice}`);
    if (!CommunicationSettingsService.warnedLoopback) {
      CommunicationSettingsService.warnedLoopback = true;
      new Logger(CommunicationSettingsService.name).warn(`Outbound links will use ${url}. ${advice}`);
    }
    return url;
  }

  /** One warning per process, not one per message. */
  private static warnedLoopback = false;

  /** Whether a channel is configured AND enabled. Missing config => disabled. */
  async isChannelEnabled(orgId: string, channel: Channel): Promise<boolean> {
    if (channel === 'email') return Boolean((await this.email(orgId))?.enabled);
    if (channel === 'sms') return Boolean((await this.sms(orgId))?.enabled);
    return Boolean((await this.whatsapp(orgId))?.enabled);
  }

  /** Admin snapshot with secrets masked (has* booleans) for the settings editor. */
  async snapshot(orgId: string): Promise<Record<string, unknown>> {
    const [email, sms, whatsapp, general] = await Promise.all([
      this.email(orgId), this.sms(orgId), this.whatsapp(orgId), this.general(orgId),
    ]);
    const e = email ?? DEFAULT_EMAIL;
    const s = sms ?? DEFAULT_SMS;
    const w = whatsapp ?? DEFAULT_WHATSAPP;
    return {
      email: {
        enabled: e.enabled, host: e.host, port: e.port, secure: e.secure, auth: e.auth,
        user: e.user, senderName: e.senderName, from: e.from, connectionTimeout: e.connectionTimeout,
        allowUntrustedCertificate: Boolean(e.allowUntrustedCertificate),
        hasPass: Boolean(e.pass),
      },
      sms: {
        enabled: s.enabled, provider: s.provider, senderId: s.senderId, accountSid: s.accountSid ?? '',
        endpoint: s.endpoint ?? '', httpMethod: s.httpMethod ?? 'POST', bodyFormat: s.bodyFormat ?? 'json',
        authType: s.authType ?? 'bearer', apiKeyHeader: s.apiKeyHeader ?? '', username: s.username ?? '',
        oauthTokenUrl: s.oauthTokenUrl ?? '', oauthClientId: s.oauthClientId ?? '',
        toParam: s.toParam ?? 'to', messageParam: s.messageParam ?? 'message', fromParam: s.fromParam ?? 'from',
        retryMaxAttempts: s.retryMaxAttempts ?? 3, retryBackoffMs: s.retryBackoffMs ?? 1000,
        hasAuthToken: Boolean(s.authToken), hasApiKey: Boolean(s.apiKey), hasPassword: Boolean(s.password),
        hasOauthClientSecret: Boolean(s.oauthClientSecret),
      },
      whatsapp: {
        enabled: w.enabled, provider: w.provider, baseUrl: w.baseUrl ?? '', phoneNumberId: w.phoneNumberId ?? '',
        accountSid: w.accountSid ?? '', session: w.session ?? 'default', businessNumber: w.businessNumber ?? '',
        webhookUrl: w.webhookUrl ?? '', hasAccessToken: Boolean(w.accessToken), hasAuthToken: Boolean(w.authToken),
        hasApiKey: Boolean(w.apiKey), mock: w.provider === 'mock' || Boolean(w.mock),
      },
      // The webhook secret is a credential — report only whether one is set (F5),
      // consistent with every other secret in this snapshot.
      general: {
        publicBaseUrl: general.publicBaseUrl,
        publicBaseUrlConfigured: general.publicBaseUrlConfigured ?? '',
        publicBaseUrlSource: resolvePublicBaseUrl(general.publicBaseUrlConfigured ?? '').source,
        publicBaseUrlUsable: !isUnreachablePublicHost(general.publicBaseUrl),
        hasWebhookSecret: Boolean(general.webhookSecret),
      },
    };
  }

  /** Merge input over stored config, preserving blank-left secrets. */
  async saveEmail(orgId: string, userId: string | null, input: Partial<EmailConfig>): Promise<void> {
    const cur = (await this.email(orgId)) ?? DEFAULT_EMAIL;
    const merged: EmailConfig = {
      ...cur, ...pickDefined(input),
      pass: keepSecret(input.pass, cur.pass) ?? '',
    };
    await this.write(orgId, userId, 'email', merged);
  }

  async saveSms(orgId: string, userId: string | null, input: Partial<SmsConfig>): Promise<void> {
    const cur = (await this.sms(orgId)) ?? DEFAULT_SMS;
    const merged: SmsConfig = {
      ...cur, ...pickDefined(input),
      authToken: keepSecret(input.authToken, cur.authToken),
      apiKey: keepSecret(input.apiKey, cur.apiKey),
      password: keepSecret(input.password, cur.password),
      oauthClientSecret: keepSecret(input.oauthClientSecret, cur.oauthClientSecret),
    };
    await this.write(orgId, userId, 'sms', merged);
  }

  async saveWhatsapp(orgId: string, userId: string | null, input: Partial<WhatsAppConfig>): Promise<void> {
    const cur = (await this.whatsapp(orgId)) ?? DEFAULT_WHATSAPP;
    const merged: WhatsAppConfig = {
      ...cur, ...pickDefined(input),
      accessToken: keepSecret(input.accessToken, cur.accessToken),
      authToken: keepSecret(input.authToken, cur.authToken),
      apiKey: keepSecret(input.apiKey, cur.apiKey),
    };
    // Keep the legacy `mock` flag consistent with provider selection.
    merged.mock = merged.provider === 'mock';
    await this.write(orgId, userId, 'whatsapp', merged);
  }

  async saveGeneral(orgId: string, userId: string | null, input: Partial<CommGeneral>): Promise<void> {
    const existing = await this.general(orgId);
    // Persist ONLY what an administrator explicitly typed. An empty string is a real
    // value here — it means "inherit from PUBLIC_APP_URL" — which is why the effective
    // URL is never written back. Storing the resolved default is precisely how
    // "http://localhost:5173" used to become permanent and shadow the environment.
    const configured = input.publicBaseUrlConfigured !== undefined
      ? input.publicBaseUrlConfigured.trim().replace(/\/+$/, '')
      : (existing.publicBaseUrlConfigured ?? '');
    const merged: CommGeneral = {
      publicBaseUrlConfigured: configured,
      // Kept for older readers of this row; it is recomputed on every read.
      publicBaseUrl: configured,
      webhookSecret: keepSecret(input.webhookSecret, existing.webhookSecret),
    };
    await this.write(orgId, userId, 'general', merged);
  }

  private async read<T>(orgId: string, key: string): Promise<T | null> {
    const row = await this.prisma.configuration.findFirst({
      where: { organizationId: orgId, module: 'communication', key, deletedAt: null },
      select: { value: true },
    });
    return (row?.value as T) ?? null;
  }

  private async write(orgId: string, userId: string | null, key: string, value: object): Promise<void> {
    // Partial unique index (WHERE deleted_at IS NULL) rules out ON CONFLICT upsert;
    // find-then-update/create instead.
    const existing = await this.prisma.configuration.findFirst({
      where: { organizationId: orgId, module: 'communication', key, deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      await this.prisma.configuration.update({
        where: { id: existing.id },
        data: { value: value as Prisma.InputJsonValue, updatedBy: userId },
      });
    } else {
      await this.prisma.configuration.create({
        data: { organizationId: orgId, module: 'communication', key, value: value as Prisma.InputJsonValue, createdBy: userId, updatedBy: userId },
      });
    }
  }
}

/** Only copy keys the caller actually provided (ignores undefined). */
function pickDefined<T extends object>(input: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Preserve the stored secret when the incoming value is blank/undefined. */
function keepSecret(incoming: string | undefined, current: string | undefined): string | undefined {
  return incoming && incoming.length > 0 ? incoming : current;
}
