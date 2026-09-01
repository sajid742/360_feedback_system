import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';

export interface ApiEnvelope<T> {
  success: boolean;
  message: string;
  data: T;
  errors: null;
}

/**
 * Wraps every successful controller return in the project envelope
 * `{ success, message, data, errors }` (API_CONTRACT.md). Controllers return
 * raw data; the interceptor standardizes the shape. Provided by the
 * Configuration foundation.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiEnvelope<T>> {
  intercept(_context: ExecutionContext, next: CallHandler<T>): Observable<ApiEnvelope<T>> {
    return next.handle().pipe(
      map((data) => ({
        success: true,
        message: 'OK',
        data,
        errors: null,
      })),
    );
  }
}
