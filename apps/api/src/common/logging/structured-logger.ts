import type { LoggerService, LogLevel } from '@nestjs/common';
import { currentRequestId } from '../context/request-context';

/**
 * Dependency-free structured logger (F19). Emits one JSON object per line
 * (`{ time, level, context, requestId, message, ... }`) so logs ship cleanly to
 * any aggregator (Loki, ELK, CloudWatch, Datadog). Every line automatically
 * carries the current request/correlation id from AsyncLocalStorage, so all logs
 * for one request can be grouped.
 *
 * Configuration (env):
 *   LOG_LEVEL  = error | warn | log | debug | verbose   (default: log)
 *   LOG_FORMAT = json | pretty                          (default: json;
 *                                                        pretty when NODE_ENV!=production)
 *
 * Registered via `app.useLogger()` in main.ts, so Nest's own logs and every
 * `new Logger(context)` call across the app route through it — no call-site change.
 */
const LEVEL_ORDER: Record<LogLevel, number> = { verbose: 0, debug: 1, log: 2, warn: 3, error: 4, fatal: 5 };

export class StructuredLogger implements LoggerService {
  private readonly threshold: number;
  private readonly pretty: boolean;

  constructor() {
    const configured = (process.env.LOG_LEVEL as LogLevel) || 'log';
    this.threshold = LEVEL_ORDER[configured] ?? LEVEL_ORDER.log;
    const fmt = process.env.LOG_FORMAT;
    this.pretty = fmt ? fmt === 'pretty' : process.env.NODE_ENV !== 'production';
  }

  log(message: unknown, context?: string): void { this.emit('log', message, context); }
  error(message: unknown, stackOrContext?: string, context?: string): void {
    // Nest calls error(message, stack, context)
    this.emit('error', message, context ?? stackOrContext, stackOrContext && context ? stackOrContext : undefined);
  }
  warn(message: unknown, context?: string): void { this.emit('warn', message, context); }
  debug(message: unknown, context?: string): void { this.emit('debug', message, context); }
  verbose(message: unknown, context?: string): void { this.emit('verbose', message, context); }
  fatal(message: unknown, context?: string): void { this.emit('fatal', message, context); }

  private emit(level: LogLevel, message: unknown, context?: string, stack?: string): void {
    if ((LEVEL_ORDER[level] ?? 2) < this.threshold) return;
    const requestId = currentRequestId();
    const base: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      context: context ?? 'App',
      message: typeof message === 'string' ? message : safeStringify(message),
    };
    if (requestId) base.requestId = requestId;
    if (stack) base.stack = stack;

    if (this.pretty) {
      const rid = requestId ? ` [${requestId}]` : '';
      // eslint-disable-next-line no-console
      console.log(`${base.time} ${level.toUpperCase().padEnd(7)} [${base.context}]${rid} ${base.message}${stack ? '\n' + stack : ''}`);
    } else {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(base));
    }
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
