import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

interface FieldError {
  field?: string;
  message: string;
}

/** Configured request-body ceiling in MB (mirrors the value set in main.ts). */
export function maxUploadMb(): number {
  const value = Number(process.env.MAX_UPLOAD_MB);
  return Number.isFinite(value) && value > 0 ? value : 10;
}

/** body-parser's PayloadTooLargeError, thrown before routing. */
function isPayloadTooLarge(exception: unknown): boolean {
  const e = exception as { type?: string; status?: number; name?: string } | null;
  return Boolean(e && (e.type === 'entity.too.large' || e.name === 'PayloadTooLargeError'));
}

/**
 * Renders any thrown error as the failure envelope
 * `{ success:false, message, data:null, errors }`, mapping class-validator
 * arrays into `errors[]`. Provided by the Configuration foundation.
 *
 * Server-side errors (5xx) are logged with the request context + stack via the
 * structured logger (F19); the request id (X-Request-Id) is attached by the logger
 * automatically so a reported error can be traced to its request.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    const oversized = isPayloadTooLarge(exception);
    const status = oversized
      ? HttpStatus.PAYLOAD_TOO_LARGE
      : exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const { message, errors } = oversized
      ? {
          // Body-parser rejects an oversized body before any controller runs, so
          // without this an administrator uploading a large spreadsheet saw a bare
          // 500 "Internal server error" and had no idea the file was the problem (F10).
          message:
            `The uploaded file is too large. The limit is ${maxUploadMb()} MB; ` +
            'split the file into smaller batches, or raise MAX_UPLOAD_MB on the server.',
          errors: null as FieldError[] | null,
        }
      : this.extract(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const where = `${request?.method ?? '?'} ${(request?.originalUrl ?? request?.url ?? '').split('?')[0]}`;
      const stack = exception instanceof Error ? exception.stack : undefined;
      this.logger.error(`${status} on ${where}: ${message}`, stack);
    }

    response.status(status).json({ success: false, message, data: null, errors });
  }

  private extract(exception: unknown): { message: string; errors: FieldError[] | null } {
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === 'string') {
        return { message: body, errors: null };
      }
      const record = body as { message?: string | string[] };
      if (Array.isArray(record.message)) {
        return {
          message: 'Validation failed',
          errors: record.message.map((m) => ({ message: m })),
        };
      }
      return { message: record.message ?? exception.message, errors: null };
    }
    return { message: 'Internal server error', errors: null };
  }
}
