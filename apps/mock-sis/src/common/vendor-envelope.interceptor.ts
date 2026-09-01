import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, type Observable } from 'rxjs';

/**
 * Wraps responses in a vendor-style envelope: list endpoints return
 * `{ data: [...], count }`, object endpoints return `{ data: {...} }`.
 * The 360 SisProvider adapter unwraps this — so the envelope shape is part of
 * the vendor contract, not the 360 system's internal format.
 */
@Injectable()
export class VendorEnvelopeInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((payload) => {
        if (Array.isArray(payload)) return { data: payload, count: payload.length };
        return { data: payload };
      }),
    );
  }
}
