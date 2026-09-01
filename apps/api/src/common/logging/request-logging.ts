import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { requestContext } from '../context/request-context';

interface MinReq { method?: string; url?: string; originalUrl?: string; headers: Record<string, string | string[] | undefined> }
interface MinRes { statusCode: number; setHeader: (k: string, v: string) => void; on: (ev: string, cb: () => void) => void }

/**
 * Request-id + request-completion logging middleware (F19). Runs first in the
 * Express chain so every downstream log line (and any error) is correlated:
 *   - reuses an inbound `X-Request-Id` (from an upstream proxy) or generates one,
 *   - echoes it back on the `X-Request-Id` response header,
 *   - stores it in AsyncLocalStorage so the StructuredLogger stamps every line,
 *   - logs a single structured summary per completed request
 *     (method, path, status, duration).
 * Health probes (`/health`, `/ready`) are skipped to keep logs quiet.
 */
export function createRequestLogger(): (req: MinReq, res: MinRes, next: () => void) => void {
  const logger = new Logger('HTTP');
  return (req, res, next) => {
    const inbound = req.headers['x-request-id'];
    const requestId = (Array.isArray(inbound) ? inbound[0] : inbound) || randomUUID();
    res.setHeader('X-Request-Id', requestId);

    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    const start = Date.now();
    res.on('finish', () => {
      if (path === '/health' || path === '/ready') return;
      const durationMs = Date.now() - start;
      const level = res.statusCode >= 500 ? 'error' : 'log';
      const line = `${req.method} ${path} ${res.statusCode} ${durationMs}ms`;
      if (level === 'error') logger.error(line);
      else logger.log(line);
    });

    // enterWith persists the store across the rest of this request's async chain;
    // RequestContextInterceptor later merges in the org id without clobbering it.
    requestContext.enterWith({ requestId });
    next();
  };
}
