import 'reflect-metadata';
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { VendorEnvelopeInterceptor } from './common/vendor-envelope.interceptor';

/** Load the self-contained admin page, whichever build layout we're running in. */
function loadAdminHtml(): string {
  const candidates = [
    join(__dirname, 'admin', 'admin.page.html'),      // dist/admin (nest build/start)
    join(process.cwd(), 'src', 'admin', 'admin.page.html'), // ts-node fallback
    join(process.cwd(), 'apps', 'mock-sis', 'src', 'admin', 'admin.page.html'),
  ];
  for (const p of candidates) if (existsSync(p)) return readFileSync(p, 'utf8');
  return '<h1>Mock SIS Admin</h1><p>admin.page.html was not found in the build output.</p>';
}

/**
 * Mock SIS bootstrap. Emulates an external vendor Student Information System:
 * REST under `/api/v1`, API-key protected, responses wrapped in a vendor
 * envelope. The 360 Feedback System consumes these APIs through its own
 * SisProvider adapter, never touching this service's database.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // The vendor API sits under /api/v1; the local admin tool lives under /admin
  // (page at /admin, CRUD at /admin/api/*) and is excluded from the prefix.
  app.setGlobalPrefix('api/v1', { exclude: ['admin', 'admin/(.*)'] });
  app.enableCors({ origin: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
  app.useGlobalInterceptors(new VendorEnvelopeInterceptor());

  // Serve the self-contained admin page directly on the underlying HTTP server so
  // it bypasses the vendor envelope interceptor (it must return raw HTML).
  const adminHtml = loadAdminHtml();
  const express = app.getHttpAdapter().getInstance() as { get: (path: string, h: (req: unknown, res: { type: (t: string) => { send: (b: string) => void } }) => void) => void };
  express.get('/admin', (_req, res) => res.type('html').send(adminHtml));

  await app.listen(Number(process.env.PORT ?? 3100));
  // eslint-disable-next-line no-console
  console.log(`Mock SIS admin UI: http://localhost:${process.env.PORT ?? 3100}/admin`);
}

void bootstrap();
