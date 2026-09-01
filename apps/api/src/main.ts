import 'reflect-metadata';
import 'dotenv/config';
import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { HttpExceptionFilter, maxUploadMb } from './common/filters/http-exception.filter';
import { StructuredLogger } from './common/logging/structured-logger';
import { createRequestLogger } from './common/logging/request-logging';
import { DEV_FALLBACK_APP_URL, isUnreachablePublicHost } from './communication/communication.settings';

/**
 * API bootstrap. Global prefix `api/v1`, response-envelope interceptor + error
 * filter, and a strict ValidationPipe (whitelist + transform) so DTOs bind and
 * unknown fields are stripped project-wide.
 */
async function bootstrap(): Promise<void> {
  // Buffer early logs, then route everything (incl. Nest's own) through the
  // structured JSON logger (F19).
  // `rawBody` keeps the exact bytes of each request body on `req.rawBody`.
  // Provider delivery webhooks sign the raw payload, so the HMAC has to be
  // computed over those bytes, not over a re-serialised DTO (F5).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, rawBody: true });
  app.useLogger(new StructuredLogger());
  // Request-id + request-completion logging — first in the chain so every log
  // line and error is correlated by X-Request-Id (F19).
  app.use(createRequestLogger());
  // Baseline security headers + framework fingerprint suppression (DEF-05).
  // Dependency-free (no helmet) — mitigates clickjacking, MIME-sniffing, and
  // referrer leakage; HSTS is emitted only when the request arrives over TLS.
  const httpInstance = app.getHttpAdapter().getInstance();
  if (typeof httpInstance.disable === 'function') httpInstance.disable('x-powered-by');
  app.use(
    (
      req: { secure?: boolean; headers: Record<string, string | undefined> },
      res: { setHeader: (k: string, v: string) => void },
      next: () => void,
    ) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      }
      next();
    },
  );
  // /r/:code (short-link redirect) is public and lives outside the API prefix.
  // /health + /ready (F18) are mounted at the root so load balancers/orchestrators
  // reach them at conventional paths.
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'r/:code', method: RequestMethod.GET },
      { path: 'health', method: RequestMethod.GET },
      { path: 'ready', method: RequestMethod.GET },
    ],
  });
  // Organisation / HR / SIS imports post the spreadsheet as base64 inside the JSON
  // body, so Express's 100 kB default silently capped imports at a few hundred rows —
  // anything larger died as an opaque 500 (F10). The ceiling is now deliberate,
  // env-tunable, and large enough for the documented 5,000-row import cap.
  const bodyLimit = `${maxUploadMb()}mb`;
  app.useBodyParser('json', { limit: bodyLimit });
  app.useBodyParser('urlencoded', { limit: bodyLimit, extended: true });

  // CORS. An explicit CORS_ORIGIN always wins, so a configured deployment is
  // unaffected and production keeps its previous default.
  //
  // With no CORS_ORIGIN set, development reflects the caller's origin. This matters
  // only when a LAN device calls the API DIRECTLY on :3000 — the normal path goes
  // through the Vite dev proxy, where the browser sees a single origin and performs
  // no CORS check at all. The old dev default of 'http://localhost:5173' rejected
  // http://<LAN-IP>:5173, which is a confusing failure to diagnose from a phone.
  // A blank CORS_ORIGIN counts as "not set". Left as an empty string it would be
  // handed to the CORS layer verbatim, which then matches no origin at all and makes
  // every preflight fail with a 404 that looks like a routing bug.
  const configuredOrigin = process.env.CORS_ORIGIN?.trim();
  const corsOrigin =
    configuredOrigin || (process.env.NODE_ENV === 'production' ? 'http://localhost:5173' : true);
  app.enableCors({ origin: corsOrigin, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: true } }),
  );
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());
  warnIfPublicUrlUnusable();
  await app.listen(Number(process.env.PORT ?? 3000));
}

/**
 * Say at startup — once, loudly — when outbound links cannot possibly work.
 *
 * Every parent-evaluation invitation, password reset and short link is built from
 * PUBLIC_APP_URL. Left at its development default on a server, each one goes out
 * pointing at the RECIPIENT'S own machine: the message is delivered, the token is
 * consumed, and the link is dead. That failure is invisible from the server, so the
 * only place to catch it is here, before anything is sent.
 */
function warnIfPublicUrlUnusable(): void {
  const log = new Logger('PublicAppUrl');
  const configured = (process.env.PUBLIC_APP_URL ?? '').trim();
  const effective = configured || DEV_FALLBACK_APP_URL;

  if (!isUnreachablePublicHost(effective)) {
    log.log(`Outbound links will use ${effective}`);
    return;
  }
  const how =
    'Set PUBLIC_APP_URL to the address people actually type to reach this application — ' +
    'e.g. http://192.168.1.20:8080 on a LAN server, or https://360.example.com in production. ' +
    'Docker: put it in .env next to compose.yaml. From source: apps/api/.env.';

  if (process.env.NODE_ENV === 'production') {
    log.error(
      `PUBLIC_APP_URL is ${configured ? `"${configured}"` : 'not set, so links fall back to ' + DEV_FALLBACK_APP_URL} — ` +
      `a host that only resolves on the recipient's own machine. External invitations will be REFUSED until this is fixed. ${how}`,
    );
  } else {
    log.warn(`Outbound links will use ${effective} — correct for development, wrong on a server. ${how}`);
  }
}

void bootstrap();
