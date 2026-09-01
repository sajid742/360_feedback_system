import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { ReportsModule } from '../reports/reports.module';
import { IntegrationController } from './integration.controller';
import { IntegrationApiController } from './integration-api.controller';
import { ReportsApiController } from './reports-api.controller';
import { ApiKeyService } from './services/api-key.service';
import { WebhookService } from './services/webhook.service';
import { ApiKeyGuard } from './api-key.guard';
import { EtagInterceptor } from './etag.interceptor';

// Per-API-key rate limit for the external Reports API. Configurable via env
// (defaults: 120 requests / 60s). The tracker is the authenticated API key id (set by
// ApiKeyGuard), so limits are per-key rather than per-IP. Scoped to THIS module only —
// internal dashboard APIs are never throttled.
const RATE_TTL_MS = Math.max(1000, Number(process.env.API_RATE_TTL_MS ?? 60_000) || 60_000);
const RATE_LIMIT = Math.max(1, Number(process.env.API_RATE_LIMIT ?? 120) || 120);

/** Integration (Phase 13) + external read-only Reports API (v1). Exports
 *  WebhookService so other modules can emit domain events (e.g. Appraisal cycle
 *  status changes). Imports ReportsModule to reuse ReportsService verbatim. */
@Module({
  imports: [
    ReportsModule,
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'api', ttl: RATE_TTL_MS, limit: RATE_LIMIT }],
      errorMessage: 'Rate limit exceeded for this API key. Try again shortly.',
      getTracker: (req: Record<string, unknown>) => {
        const user = req?.user as { userId?: string } | undefined;
        return user?.userId ?? (req?.ip as string) ?? 'anonymous';
      },
    }),
  ],
  controllers: [IntegrationController, IntegrationApiController, ReportsApiController],
  providers: [ApiKeyService, WebhookService, ApiKeyGuard, EtagInterceptor],
  exports: [WebhookService],
})
export class IntegrationModule {}
