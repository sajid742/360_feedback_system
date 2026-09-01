import { BadRequestException, Injectable } from '@nestjs/common';
import { CommunicationSettingsService, type EmailConfig, type SmsConfig, type WhatsAppConfig } from '../communication.settings';
import type { Channel, ChannelProvider, MessagePayload, SendResult } from './types';

/**
 * Resolves the right transport for a channel from per-org config. Every provider
 * implements the same `ChannelProvider` interface, so the business logic (which
 * only ever calls NotificationService → this factory) never touches SMTP, Twilio,
 * WAHA, or any vendor SDK directly. Swapping providers is pure configuration.
 */
@Injectable()
export class ProviderFactory {
  constructor(private readonly settings: CommunicationSettingsService) {}

  async forChannel(orgId: string, channel: Channel): Promise<ChannelProvider> {
    if (channel === 'email') return new EmailTransport(await this.require(await this.settings.email(orgId), 'email'));
    if (channel === 'sms') {
      const cfg = await this.require(await this.settings.sms(orgId), 'sms');
      return cfg.provider === 'twilio' ? new TwilioSmsTransport(cfg) : new GenericSmsTransport(cfg);
    }
    const wa = await this.require(await this.settings.whatsapp(orgId), 'whatsapp');
    switch (wa.provider) {
      case 'twilio': return new TwilioWhatsAppTransport(wa);
      case 'waha': return new WahaTransport(wa);
      case 'mock': return new MockWhatsAppTransport();
      case 'meta':
      default: return new MetaWhatsAppTransport(wa);
    }
  }

  private async require<T>(config: T | null, channel: string): Promise<T> {
    if (!config) throw new BadRequestException(`No ${channel} provider configured for this organization.`);
    return config;
  }
}

/* ------------------------------------------------------------------ *
 * Email — SMTP via nodemailer
 * ------------------------------------------------------------------ */

class EmailTransport implements ChannelProvider {
  constructor(private readonly config: EmailConfig) {}

  async send(payload: MessagePayload): Promise<SendResult> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodemailer = require('nodemailer') as typeof import('nodemailer');
    const transport = nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      connectionTimeout: this.config.connectionTimeout || 10000,
      // Only attach credentials when SMTP AUTH is enabled.
      ...(this.config.auth ? { auth: { user: this.config.user, pass: this.config.pass } } : {}),
      // Opt-in escape hatch, off unless an administrator ticks it. It exists for two
      // real situations: an internal mail server with its own self-signed certificate,
      // and a machine where antivirus or a proxy re-signs TLS. It weakens transport
      // security, so the UI labels it as such and NODE_EXTRA_CA_CERTS is the better fix.
      ...(this.config.allowUntrustedCertificate ? { tls: { rejectUnauthorized: false } } : {}),
    });
    const from = this.config.senderName ? `"${this.config.senderName}" <${this.config.from}>` : this.config.from;
    try {
      const info = await transport.sendMail({
        from,
        to: payload.recipient,
        subject: payload.subject ?? '',
        // Both parts, always. The text part stays authoritative; the HTML alternative
        // exists so a link is clickable by MARKUP rather than by the client's guess at
        // where a URL starts and ends. Quoted-printable soft-wraps long URLs, and while
        // a compliant client rejoins them, an explicit <a href> removes the question.
        text: payload.body,
        html: textToHtml(payload.body),
      });
      return { provider: 'smtp', providerMessageId: info.messageId ?? null };
    } catch (e) {
      // Turn the two SMTP failures that are almost always a configuration mistake into
      // something an administrator can act on. Nodemailer reports the first as a raw
      // OpenSSL "wrong version number", which says nothing about the actual cause: the
      // server was spoken to in TLS when it was expecting plaintext-then-STARTTLS.
      const msg = (e as Error).message ?? '';
      // Certificate TRUST first. Nodemailer reports these under the same ESOCKET code as
      // the plaintext/TLS mismatch below, so testing that branch first would hand the
      // administrator confidently wrong advice ("switch to STARTTLS") for a problem that
      // has nothing to do with the port.
      if (TLS_TRUST_ERROR.test(msg)) {
        throw new Error(
          `SMTP refused the certificate from ${this.config.host}:${this.config.port} — "${msg}". The server's ` +
          'certificate is not signed by an authority Node trusts. On a machine with antivirus or a corporate ' +
          'proxy that inspects HTTPS this is expected: it re-signs the connection with its own authority, and ' +
          'Node does not read the Windows certificate store the way your browser does. Fix it in one of two ways ' +
          '— export that authority\'s root certificate and start the API with ' +
          'NODE_EXTRA_CA_CERTS=C:\\path\\to\\rootCA.pem (preferred, keeps verification on), or tick ' +
          '"Accept untrusted certificate" in Communication → Providers → Email if this is a test or internal ' +
          'server. Credentials are never sent before the TLS check, so nothing has been exposed.',
        );
      }
      if (this.config.secure && /wrong version number|SSL routines|ESOCKET/i.test(msg)) {
        throw new Error(
          `SMTP failed on ${this.config.host}:${this.config.port} — the server answered in plain text but ` +
          `Security is set to SSL/TLS (implicit). Set Security to "STARTTLS" for port 587 or 25; ` +
          `use SSL/TLS only for port 465. Original error: ${msg}`,
        );
      }
      if (/ETIMEDOUT|ECONNREFUSED|EDNS|ENOTFOUND|getaddrinfo/i.test(msg)) {
        throw new Error(
          `SMTP could not reach ${this.config.host}:${this.config.port} from the application ` +
          `(${msg}). Check the host and port, and — if the API runs in a container — that outbound ` +
          `SMTP is permitted from inside it.`,
        );
      }
      throw e;
    }
  }
}

/* ------------------------------------------------------------------ *
 * SMS — Twilio + a fully configurable generic HTTP gateway
 * ------------------------------------------------------------------ */

class TwilioSmsTransport implements ChannelProvider {
  constructor(private readonly config: SmsConfig) {}

  async send(payload: MessagePayload): Promise<SendResult> {
    const sid = this.config.accountSid ?? '';
    const auth = Buffer.from(`${sid}:${this.config.authToken ?? ''}`).toString('base64');
    const attempts = Math.max(1, this.config.retryMaxAttempts ?? 1);
    return withRetry(attempts, this.config.retryBackoffMs ?? 0, async () => {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ From: this.config.senderId, To: payload.recipient, Body: payload.body }),
      });
      if (!res.ok) throw new Error(`Twilio SMS failed (${res.status}): ${await safeText(res)}`);
      const data = (await res.json()) as { sid?: string };
      return { provider: 'twilio', providerMessageId: data.sid ?? null };
    });
  }
}

/**
 * Generic HTTP SMS gateway. Any REST SMS provider can be driven purely by config:
 * endpoint, HTTP method, JSON/form body, configurable field names, and one of
 * several auth schemes (API key header, HTTP Basic, Bearer token, OAuth2
 * client-credentials). Honours a configurable retry policy.
 */
class GenericSmsTransport implements ChannelProvider {
  constructor(private readonly config: SmsConfig) {}

  async send(payload: MessagePayload): Promise<SendResult> {
    if (!this.config.endpoint) throw new Error('SMS provider endpoint is not configured.');
    const attempts = Math.max(1, this.config.retryMaxAttempts ?? 1);
    return withRetry(attempts, this.config.retryBackoffMs ?? 0, async () => {
      const headers = await this.authHeaders();
      const fields: Record<string, string> = {
        [this.config.toParam ?? 'to']: payload.recipient,
        [this.config.messageParam ?? 'message']: payload.body,
        [this.config.fromParam ?? 'from']: this.config.senderId,
      };
      const method = this.config.httpMethod ?? 'POST';
      let url = this.config.endpoint!;
      const init: RequestInit = { method, headers };
      if (method === 'GET') {
        const qs = new URLSearchParams(fields).toString();
        url += (url.includes('?') ? '&' : '?') + qs;
      } else if ((this.config.bodyFormat ?? 'json') === 'form') {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        init.body = new URLSearchParams(fields).toString();
      } else {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(fields);
      }
      const res = await fetch(url, init);
      if (!res.ok) throw new Error(`SMS gateway failed (${res.status}): ${await safeText(res)}`);
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const id = (data.messageId ?? data['message-id'] ?? data.id ?? data.sid) as string | undefined;
      return { provider: 'sms-http', providerMessageId: id ?? null };
    });
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const c = this.config;
    switch (c.authType ?? 'none') {
      case 'apikey':
        return { [c.apiKeyHeader && c.apiKeyHeader.length > 0 ? c.apiKeyHeader : 'Authorization']: c.apiKey ?? '' };
      case 'basic':
        return { Authorization: `Basic ${Buffer.from(`${c.username ?? ''}:${c.password ?? ''}`).toString('base64')}` };
      case 'bearer':
        return { Authorization: `Bearer ${c.apiKey ?? ''}` };
      case 'oauth2': {
        const token = await this.fetchOauthToken();
        return { Authorization: `Bearer ${token}` };
      }
      case 'none':
      default:
        return {};
    }
  }

  private async fetchOauthToken(): Promise<string> {
    const res = await fetch(this.config.oauthTokenUrl ?? '', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.config.oauthClientId ?? '',
        client_secret: this.config.oauthClientSecret ?? '',
      }),
    });
    if (!res.ok) throw new Error(`OAuth2 token request failed (${res.status}).`);
    const data = (await res.json()) as { access_token?: string };
    if (!data.access_token) throw new Error('OAuth2 token response missing access_token.');
    return data.access_token;
  }
}

/* ------------------------------------------------------------------ *
 * WhatsApp — Meta Cloud API, Twilio, WAHA, and a mock recorder
 * ------------------------------------------------------------------ */

class MetaWhatsAppTransport implements ChannelProvider {
  constructor(private readonly config: WhatsAppConfig) {}

  async send(payload: MessagePayload): Promise<SendResult> {
    const base = (this.config.baseUrl && this.config.baseUrl.length > 0 ? this.config.baseUrl : 'https://graph.facebook.com/v18.0').replace(/\/$/, '');
    const res = await fetch(`${base}/${this.config.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: payload.recipient, type: 'text', text: { body: payload.body } }),
    });
    if (!res.ok) throw new Error(`Meta WhatsApp failed (${res.status}): ${await safeText(res)}`);
    const data = (await res.json().catch(() => ({}))) as { messages?: { id: string }[] };
    return { provider: 'whatsapp-meta', providerMessageId: data.messages?.[0]?.id ?? null };
  }
}

class TwilioWhatsAppTransport implements ChannelProvider {
  constructor(private readonly config: WhatsAppConfig) {}

  async send(payload: MessagePayload): Promise<SendResult> {
    const sid = this.config.accountSid ?? '';
    const auth = Buffer.from(`${sid}:${this.config.authToken ?? ''}`).toString('base64');
    const from = this.config.businessNumber ?? '';
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: prefixWa(from), To: prefixWa(payload.recipient), Body: payload.body }),
    });
    if (!res.ok) throw new Error(`Twilio WhatsApp failed (${res.status}): ${await safeText(res)}`);
    const data = (await res.json()) as { sid?: string };
    return { provider: 'whatsapp-twilio', providerMessageId: data.sid ?? null };
  }
}

/** WAHA — WhatsApp HTTP API (self-hosted). POST {session, chatId, text} to /api/sendText. */
class WahaTransport implements ChannelProvider {
  constructor(private readonly config: WhatsAppConfig) {}

  async send(payload: MessagePayload): Promise<SendResult> {
    const base = (this.config.baseUrl ?? '').replace(/\/$/, '');
    if (!base) throw new Error('WAHA base URL is not configured.');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) headers['X-Api-Key'] = this.config.apiKey;
    const url = `${base}/api/sendText`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session: this.config.session && this.config.session.length > 0 ? this.config.session : 'default',
          chatId: toChatId(payload.recipient),
          text: payload.body,
        }),
      });
    } catch (e) {
      // Without this the operator sees undici's bare "fetch failed" and has nothing to go on.
      throw describeFetchFailure(e, 'WAHA', url);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `WAHA rejected the API key (${res.status}). The key in Communication → WhatsApp must equal WAHA_API_KEY ` +
        'in .env — it is not the WAHA dashboard password, which is a separate credential.',
      );
    }
    if (res.status === 404) {
      throw new Error(
        `WAHA returned 404 for ${url}. The Base URL should be the server root (e.g. http://waha:3000), without ` +
        '/api on the end — the application appends the path itself.',
      );
    }
    if (!res.ok) throw new Error(`WAHA send failed (${res.status}): ${await safeText(res)}`);
    const data = (await res.json().catch(() => ({}))) as { id?: string | { _serialized?: string } };
    const id = typeof data.id === 'string' ? data.id : data.id?._serialized ?? null;
    return { provider: 'whatsapp-waha', providerMessageId: id };
  }
}

/**
 * Mock WhatsApp transport for integration testing (SIS Phase 2). Records the send
 * as a delivered notification without calling any external API.
 */
class MockWhatsAppTransport implements ChannelProvider {
  async send(_payload: MessagePayload): Promise<SendResult> {
    const id = `mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return { provider: 'whatsapp-mock', providerMessageId: id };
  }
}

/* ------------------------------- helpers ------------------------------- */

/**
 * Render a plain-text message as a minimal HTML alternative.
 *
 * Escaping happens FIRST and covers the whole body, so nothing a name, subject or
 * organisation title contains can become markup. Only after that are bare URLs turned
 * into anchors, and the pattern deliberately stops at whitespace and refuses trailing
 * punctuation so a sentence-ending full stop is not swallowed into the href.
 */
export function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const linked = escaped.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g,
    (url) => `<a href="${url}" style="color:#4f46e5">${url}</a>`);
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#111">${
    linked.replace(/\r?\n/g, '<br>')
  }</div>`;
}

/**
 * Turn a failed `fetch()` into something an administrator can act on.
 *
 * WHY THIS EXISTS. Node's `fetch` (undici) reports EVERY transport-level failure as
 * the same three words — "fetch failed". Wrong host, nothing listening, DNS miss,
 * untrusted TLS and timeout are indistinguishable. The real reason sits on
 * `error.cause` and was being discarded, so the Outbox could only ever tell the
 * operator "fetch failed", which says nothing about what to change.
 *
 * The five codes below cover essentially every WhatsApp/WAHA setup failure, and each
 * branch names both the cause and the specific setting to correct.
 */
function describeFetchFailure(error: unknown, what: string, url: string): Error {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code ?? (error as { code?: string }).code ?? '';
  const detail = cause?.message ?? (error as Error).message ?? '';
  let host = url;
  try { host = new URL(url).host; } catch { /* not a parseable URL — keep it as given */ }

  const say = (text: string): Error =>
    new Error(`${what} could not reach ${host} — ${text}. (${code || detail})`);

  switch (code) {
    case 'ECONNREFUSED':
      return say(
        'the address is reachable but nothing is listening on that port. Check the service is actually up ' +
        '(`docker compose ps`) and that the port in the Base URL is the one it listens on',
      );
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return say(
        'that host name does not resolve from inside the application. If the API runs in Docker the Base URL must ' +
        'use the service name — http://waha:3000 — because "localhost" inside a container means the container itself',
      );
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return say('the connection timed out, which usually means a firewall is dropping the traffic');
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
      return say(
        'its TLS certificate is not trusted. This is normally antivirus or a corporate proxy inspecting HTTPS: it ' +
        're-signs the connection with its own authority, and Node does not trust that authority (unlike your ' +
        'browser, Node does not read the Windows certificate store). Either point the Base URL at plain http:// ' +
        'for a service on your own machine, or start the API with NODE_EXTRA_CA_CERTS set to that authority\'s ' +
        'root certificate',
      );
    case 'CERT_HAS_EXPIRED':
      return say('its TLS certificate has expired');
    default:
      return say(detail || 'the connection failed');
  }
}

/**
 * TLS *trust* failures, which need a completely different answer from every other SMTP
 * error — and which nodemailer reports under the same `ESOCKET` code it uses for the
 * unrelated "you spoke TLS to a plaintext port" mistake. Matching on the message rather
 * than the code is therefore deliberate.
 */
const TLS_TRUST_ERROR =
  /self-signed certificate|self signed certificate|unable to verify the first certificate|unable to get local issuer|SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT/i;

async function withRetry<T>(attempts: number, backoffMs: number, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < attempts - 1 && backoffMs > 0) await sleep(backoffMs);
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}

function prefixWa(n: string): string {
  return n.startsWith('whatsapp:') ? n : `whatsapp:${n}`;
}

/** WAHA chat ids look like "<digits>@c.us". */
function toChatId(n: string): string {
  if (n.includes('@')) return n;
  return `${n.replace(/[^\d]/g, '')}@c.us`;
}
