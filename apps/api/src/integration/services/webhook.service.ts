import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHmac, randomBytes } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';
import type { CreateWebhookDto, UpdateWebhookDto } from '../dto/integration.dto';
import { EntitlementService } from '../../license/entitlement.service';

/** Outbound webhooks: tenant-registered HTTPS endpoints receive HMAC-SHA256
 *  signed JSON when a subscribed domain event fires. Delivery is best-effort
 *  and every attempt is recorded for observability. */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementService,
  ) {}

  private mask(secret: string): string {
    return `${secret.slice(0, 6)}…${secret.slice(-4)}`;
  }

  async list(user: AuthUser): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.webhookEndpoint.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      events: r.events,
      isActive: r.isActive,
      description: r.description,
      secretMasked: this.mask(r.secret),
      createdAt: r.createdAt,
    }));
  }

  async create(user: AuthUser, ctx: RequestContext, dto: CreateWebhookDto): Promise<Record<string, unknown>> {
    await this.entitlements.assertWithinLimit(user.organizationId, 'maxWebhooks', 1);
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const row = await this.prisma.webhookEndpoint.create({
      data: {
        organizationId: user.organizationId,
        url: dto.url,
        events: dto.events ?? [],
        secret,
        description: dto.description ?? null,
        createdBy: user.userId,
      },
    });
    await this.record(user, ctx, 'integration.webhook.create', row.id, { url: dto.url, events: dto.events ?? [] });
    return { id: row.id, url: row.url, events: row.events, isActive: row.isActive, description: row.description, secret };
  }

  async update(user: AuthUser, ctx: RequestContext, id: string, dto: UpdateWebhookDto): Promise<Record<string, unknown>> {
    const existing = await this.getOwned(user.organizationId, id);
    const row = await this.prisma.webhookEndpoint.update({
      where: { id },
      data: {
        url: dto.url ?? existing.url,
        events: dto.events ?? existing.events,
        isActive: dto.isActive ?? existing.isActive,
        description: dto.description ?? existing.description,
      },
    });
    await this.record(user, ctx, 'integration.webhook.update', id, dto);
    return { id: row.id, url: row.url, events: row.events, isActive: row.isActive, description: row.description };
  }

  async remove(user: AuthUser, ctx: RequestContext, id: string): Promise<void> {
    await this.getOwned(user.organizationId, id);
    await this.prisma.webhookEndpoint.delete({ where: { id } });
    await this.record(user, ctx, 'integration.webhook.delete', id, null);
  }

  async deliveries(user: AuthUser, id: string): Promise<Record<string, unknown>[]> {
    await this.getOwned(user.organizationId, id);
    const rows = await this.prisma.webhookDelivery.findMany({
      where: { endpointId: id },
      orderBy: { createdAt: 'desc' },
      take: 25,
    });
    return rows.map((r) => ({
      id: r.id,
      event: r.event,
      status: r.status,
      statusCode: r.statusCode,
      error: r.error,
      attempts: r.attempts,
      createdAt: r.createdAt,
    }));
  }

  /** Send a synthetic `ping` to one endpoint to validate its configuration. */
  async test(user: AuthUser, id: string): Promise<Record<string, unknown>> {
    const endpoint = await this.getOwned(user.organizationId, id);
    const result = await this.deliver(endpoint, 'ping', { message: 'Test delivery from Enterprise 360', endpointId: id });
    return result;
  }

  /**
   * Fire an event to every active endpoint of an org subscribed to it (an empty
   * `events` list means "all events"). Never throws — callers use it fire-and-forget.
   */
  async dispatch(organizationId: string, event: string, payload: Record<string, unknown>): Promise<number> {
    let endpoints: { id: string; url: string; secret: string; events: string[]; isActive: boolean }[] = [];
    try {
      endpoints = await this.prisma.webhookEndpoint.findMany({
        where: { organizationId, isActive: true },
        select: { id: true, url: true, secret: true, events: true, isActive: true },
      });
    } catch (error) {
      this.logger.warn(`Webhook dispatch lookup failed: ${(error as Error).message}`);
      return 0;
    }
    const targets = endpoints.filter((e) => e.events.length === 0 || e.events.includes(event));
    await Promise.all(targets.map((e) => this.deliver(e, event, payload)));
    return targets.length;
  }

  private async deliver(
    endpoint: { id: string; url: string; secret: string },
    event: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const body = JSON.stringify({ event, timestamp: new Date().toISOString(), data: payload });
    const signature = createHmac('sha256', endpoint.secret).update(body).digest('hex');
    const deliveryId = randomBytes(8).toString('hex');

    let status = 'failed';
    let statusCode: number | null = null;
    let error: string | null = null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-e360-event': event,
          'x-e360-delivery': deliveryId,
          'x-e360-signature': `sha256=${signature}`,
        },
        body,
        signal: controller.signal,
      });
      statusCode = response.status;
      status = response.ok ? 'success' : 'failed';
      if (!response.ok) error = `HTTP ${response.status}`;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      clearTimeout(timeout);
    }

    try {
      await this.prisma.webhookDelivery.create({
        data: { endpointId: endpoint.id, event, payload: payload as Prisma.InputJsonValue, status, statusCode, error, attempts: 1 },
      });
    } catch (e) {
      this.logger.warn(`Failed to record webhook delivery: ${(e as Error).message}`);
    }
    return { deliveryId, status, statusCode, error };
  }

  private async getOwned(organizationId: string, id: string) {
    const row = await this.prisma.webhookEndpoint.findFirst({ where: { id, organizationId } });
    if (!row) throw new NotFoundException('Webhook endpoint not found.');
    return row;
  }

  private async record(user: AuthUser, ctx: RequestContext, action: string, entityId: string, newValue: unknown): Promise<void> {
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action,
      entityType: 'webhook_endpoint',
      entityId,
      newValue: newValue ?? undefined,
      ip: ctx.ip,
      device: ctx.device,
    });
  }
}
