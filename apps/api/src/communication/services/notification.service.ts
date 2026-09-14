import { Injectable, Logger, UnauthorizedException, type OnModuleInit } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/auth/current-user';
import { ProviderFactory } from '../providers/provider.factory';
import { CommunicationSettingsService } from '../communication.settings';
import { DeliveryQueue } from './delivery-queue.service';
import type { Channel } from '../providers/types';
import { EntitlementService } from '../../license/entitlement.service';

export interface SendNotificationInput {
  channel: Channel;
  recipient: string;
  subject?: string;
  body: string;
  templateKey?: string;
  campaignId?: string;
}

/** Persists notifications and delivers them through the queue (retryable). */
@Injectable()
export class NotificationService implements OnModuleInit {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderFactory,
    private readonly settings: CommunicationSettingsService,
    private readonly queue: DeliveryQueue,
    private readonly entitlements: EntitlementService,
  ) {}

  onModuleInit(): void {
    this.queue.registerHandler((id) => this.deliver(id));
  }

  async send(orgId: string, createdBy: string | null, input: SendNotificationInput): Promise<{ id: string; status: string; error: string | null }> {
    /*
     * Two gates, then the per-channel enable switch.
     *
     * BLOCKED, NOT THROWN. This method is the single funnel for every outbound message,
     * including bulk runs that send hundreds in a loop. Throwing here would abort the
     * whole run on the message that crossed the line; recording a 'blocked' row keeps
     * the audit trail honest, lets the caller report exactly how many were sent, and
     * matches what a disabled channel already does. Nothing is ever sent silently —
     * the reason is on the row and visible in Communication.
     */
    const blocked = await this.planBlock(orgId, input.channel);
    const enabled = blocked === null && (await this.settings.isChannelEnabled(orgId, input.channel));
    const row = await this.prisma.notification.create({
      data: {
        organizationId: orgId,
        campaignId: input.campaignId ?? null,
        channel: input.channel,
        recipient: input.recipient,
        subject: input.subject ?? null,
        body: input.body,
        templateKey: input.templateKey ?? null,
        status: enabled ? 'queued' : blocked ? 'blocked' : 'skipped',
        error: enabled ? null : (blocked ?? 'Channel is disabled in Communication settings.'),
        createdBy,
      },
    });
    /*
     * Enqueue, but never let a provider failure escape as an unhandled exception.
     *
     * With Redis absent the queue delivers INLINE, so a provider error (a WAHA
     * session that is not linked, a refused SMTP connection) propagated straight out
     * of this method and the caller received a bare HTTP 500 "Internal server error".
     * The reason was recorded on the notification row all along — deliver() writes it
     * — but the response threw it away, which is exactly the case where an operator
     * most needs to see it. The outcome is now read back and returned, matching what
     * `test()` has always done.
     */
    if (enabled) {
      await this.queue.enqueue(row.id).catch(() => {
        /* the failure reason is already recorded on the row by deliver() */
      });
    }
    const done = await this.prisma.notification.findUnique({
      where: { id: row.id },
      select: { status: true, error: true },
    });
    return { id: row.id, status: done?.status ?? row.status, error: done?.error ?? row.error ?? null };
  }

  /**
   * Does the organisation's plan allow this message? Returns the reason to record, or
   * null when it is permitted.
   *
   * Checked here rather than at each caller because there are a dozen callers and one
   * funnel — a gate at the funnel cannot be forgotten.
   */
  private async planBlock(orgId: string, channel: Channel): Promise<string | null> {
    const limits = await this.entitlements.limits(orgId);
    if (!limits.channels.includes(channel)) {
      return `Your plan does not include ${channel === 'sms' ? 'SMS' : channel === 'whatsapp' ? 'WhatsApp' : 'email'} delivery.`;
    }
    const key = channel === 'email' ? 'maxEmailsPerMonth' : channel === 'sms' ? 'maxSmsPerMonth' : 'maxWhatsAppPerMonth';
    const cap = limits[key];
    if (cap === null) return null;
    const used = await this.entitlements.count(orgId, key);
    if (used < cap) return null;
    return `Your plan's monthly limit of ${cap} ${channel} messages has been reached.`;
  }

  /**
   * Create + deliver a message immediately (for transactional messages such as
   * password-reset emails), respecting the per-channel enable switch. Delivers inline
   * via deliver() so it works whether or not Redis is configured; the outcome is
   * recorded on the notification row.
   */
  async sendDirect(orgId: string, createdBy: string | null, input: SendNotificationInput): Promise<{ id: string; status: string }> {
    const enabled = await this.settings.isChannelEnabled(orgId, input.channel);
    const row = await this.prisma.notification.create({
      data: {
        organizationId: orgId,
        channel: input.channel,
        recipient: input.recipient,
        subject: input.subject ?? null,
        body: input.body,
        templateKey: input.templateKey ?? null,
        status: enabled ? 'queued' : 'skipped',
        error: enabled ? null : 'Channel is disabled in Communication settings.',
        createdBy,
      },
    });
    if (enabled) {
      try {
        await this.deliver(row.id);
      } catch {
        /* status/error already recorded on the row by deliver() */
      }
    }
    const done = await this.prisma.notification.findUnique({ where: { id: row.id }, select: { status: true } });
    return { id: row.id, status: done?.status ?? row.status };
  }

  /**
   * Send a message immediately, bypassing the enable/disable switch — used by the
   * admin "Send test message" action to validate provider credentials.
   */
  async test(orgId: string, createdBy: string | null, input: SendNotificationInput): Promise<{ id: string; status: string; error: string | null }> {
    const row = await this.prisma.notification.create({
      data: {
        organizationId: orgId,
        channel: input.channel,
        recipient: input.recipient,
        subject: input.subject ?? null,
        body: input.body,
        templateKey: input.templateKey ?? 'settings.test',
        status: 'queued',
        createdBy,
      },
    });
    try {
      await this.deliver(row.id);
    } catch {
      /* status/error already recorded on the row by deliver() */
    }
    const done = await this.prisma.notification.findUnique({ where: { id: row.id }, select: { status: true, error: true } });
    return { id: row.id, status: done?.status ?? 'failed', error: done?.error ?? null };
  }

  /** Queue processor: resolve provider, send, record delivery outcome. */
  async deliver(notificationId: string): Promise<void> {
    const notification = await this.prisma.notification.findUnique({ where: { id: notificationId } });
    if (!notification || notification.status === 'sent') return;
    try {
      const provider = await this.providers.forChannel(notification.organizationId, notification.channel);
      const result = await provider.send({
        recipient: notification.recipient,
        subject: notification.subject,
        body: notification.body,
      });
      await this.prisma.notification.update({
        where: { id: notificationId },
        data: {
          status: 'sent',
          provider: result.provider,
          providerMessageId: result.providerMessageId,
          sentAt: new Date(),
          error: null,
        },
      });
    } catch (error) {
      await this.prisma.notification.update({
        where: { id: notificationId },
        data: { status: 'failed', error: (error as Error).message },
      });
      throw error;
    }
  }

  async list(user: AuthUser): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.notification.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      recipient: r.recipient,
      subject: r.subject,
      status: r.status,
      provider: r.provider,
      error: r.error,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Provider delivery-status webhook (F5).
   *
   * This endpoint is public — it has to be, because the provider calls it — and
   * it mutates delivery state, so the caller must prove it holds the tenant's
   * webhook secret. The flow is:
   *
   *  1. No signature header at all → rejected immediately, before any lookup.
   *  2. Resolve the notification by `providerMessageId`; that row is what tells
   *     us which organisation (and therefore which secret) this callback belongs
   *     to. Nothing is written before the signature checks out.
   *  3. Read that org's webhook secret — the channel-specific one if the channel
   *     defines it (WhatsApp), otherwise the general communication secret.
   *  4. Verify `sha256=<hex>` over the RAW request bytes using a timing-safe
   *     comparison, matching the scheme this product already uses for OUTBOUND
   *     webhooks (`integration/services/webhook.service.ts`).
   *
   * Fail-closed by design: an org with no webhook secret configured cannot
   * accept callbacks. Allowing unsigned updates "when no secret is set" would
   * leave exactly the hole this closes — an attacker would simply target the
   * tenants that never set one.
   *
   * Every rejection returns the SAME 401 regardless of cause, so an unauthenticated
   * caller cannot use the response to discover which provider message ids exist or
   * which tenants have a secret configured. The specific reason is written to the
   * log instead, where an operator diagnosing a misconfigured provider can see it.
   */
  async applyWebhook(
    providerMessageId: string,
    status: string,
    signatureHeader: string | undefined,
    rawBody: Buffer | undefined,
  ): Promise<void> {
    const reject = (reason: string): never => {
      this.logger.warn(`Webhook rejected (${reason}) for providerMessageId=${providerMessageId}`);
      throw new UnauthorizedException('Invalid or missing webhook signature.');
    };

    if (!signatureHeader) reject('no signature header');

    const row = await this.prisma.notification.findFirst({
      where: { providerMessageId },
      select: { organizationId: true, channel: true },
    });
    if (!row) reject('unknown provider message id');

    const secret = await this.webhookSecret(row!.organizationId, row!.channel as Channel);
    if (!secret) reject('no webhook secret configured for this organization');
    if (!this.signatureMatches(secret!, signatureHeader, rawBody)) reject('signature mismatch');

    await this.prisma.notification.updateMany({ where: { providerMessageId }, data: { status } });
  }

  /** Channel-specific webhook secret if the channel defines one, else the general secret. */
  private async webhookSecret(orgId: string, channel: Channel): Promise<string | undefined> {
    if (channel === 'whatsapp') {
      const wa = await this.settings.whatsapp(orgId);
      if (wa?.webhookSecret) return wa.webhookSecret;
    }
    const general = await this.settings.general(orgId);
    return general.webhookSecret || undefined;
  }

  /** Timing-safe `sha256=<hex>` check over the raw request bytes. */
  private signatureMatches(secret: string, header: string | undefined, rawBody: Buffer | undefined): boolean {
    if (!header || !rawBody) return false;
    const provided = header.startsWith('sha256=') ? header.slice(7) : header;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    // timingSafeEqual throws on length mismatch, which is itself a mismatch.
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
