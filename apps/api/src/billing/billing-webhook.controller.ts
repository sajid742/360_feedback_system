import { Controller, Headers, HttpCode, Param, Post, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { BillingWebhookService, type WebhookOutcome } from './billing-webhook.service';

/**
 * The payment provider's endpoint. `POST /api/v1/billing/webhook/:provider`.
 *
 * UNAUTHENTICATED ON PURPOSE, AND NOT UNPROTECTED. A provider cannot hold a JWT, so
 * there is no guard here; authentication is the HMAC signature over the raw body, which
 * the service verifies before it will act on anything. An unsigned or wrongly signed
 * delivery is stored and refused.
 *
 * IT NEEDS THE RAW BYTES, and `main.ts` mounts a raw parser on this path so it gets
 * them untouched. That matters twice over: the signature covers what was SENT, so
 * re-serialising parsed JSON would reject every legitimate webhook as a forgery; and the
 * JSON parser answers 400 to a body that is not an object, which would refuse a forged
 * delivery before it could be recorded and make a retrying provider redeliver for ever.
 *
 * IT ALWAYS ANSWERS 200. Providers retry on anything else, so a single malformed event
 * returning 500 would be redelivered for ever. The body says what happened; the status
 * says "received, stop resending".
 */
@Controller('billing/webhook')
export class BillingWebhookController {
  constructor(private readonly webhooks: BillingWebhookService) {}

  @Post(':provider')
  @HttpCode(200)
  async receive(
    @Param('provider') provider: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<WebhookOutcome> {
    // `main.ts` mounts a raw body parser on this path, so `req.body` IS the buffer.
    // `req.rawBody` is the fallback for the application-wide `rawBody: true` capture.
    // Falling back to a re-serialised body would silently break every signature, so the
    // absence of both is treated as what it is: a misconfiguration, reported as an
    // invalid signature rather than papered over.
    const bytes = Buffer.isBuffer(req.body) ? req.body : req.rawBody ?? Buffer.alloc(0);
    return this.webhooks.handle(provider, bytes, headers);
  }
}
