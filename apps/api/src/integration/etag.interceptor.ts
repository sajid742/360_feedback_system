import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { map, type Observable } from 'rxjs';

/**
 * Adds conditional-caching headers to the external read-only reports API. Computes a
 * weak ETag over the raw payload, sets a short `Cache-Control: private, max-age`, and
 * answers `304 Not Modified` when the client's `If-None-Match` still matches — so an
 * external dashboard polling every minute mostly gets cheap 304s instead of re-querying.
 * Runs INSIDE the global response envelope (controller-scoped), so it hashes the raw
 * data deterministically. Max-age is configurable via `API_CACHE_MAX_AGE` (seconds).
 */
@Injectable()
export class EtagInterceptor implements NestInterceptor {
  private readonly maxAge = Math.max(0, Number(process.env.API_CACHE_MAX_AGE ?? 60) || 0);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<{ headers: Record<string, string | undefined> }>();
    const res = http.getResponse<{ setHeader(k: string, v: string): void; status(c: number): void }>();

    return next.handle().pipe(
      map((data) => {
        try {
          const etag = 'W/"' + createHash('sha1').update(JSON.stringify(data ?? null)).digest('hex') + '"';
          res.setHeader('ETag', etag);
          res.setHeader('Cache-Control', `private, max-age=${this.maxAge}`);
          const inm = req.headers['if-none-match'];
          if (inm && inm === etag) {
            res.status(304);
            return undefined; // body ignored on 304
          }
        } catch {
          /* hashing failed → serve normally without caching headers */
        }
        return data;
      }),
    );
  }
}
