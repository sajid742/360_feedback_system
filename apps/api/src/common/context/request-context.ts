import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestStore {
  organizationId?: string;
  requestId?: string;
  /**
   * Per-request cache slot (F-P2). The tenant-aware SIS provider stores the loaded
   * roster snapshot here so one HTTP request loads it once instead of re-reading and
   * re-parsing the whole JSON blob on every single SisProvider method call.
   * Deliberately opaque so this module stays dependency-free.
   */
  cache?: Map<string, unknown>;
}

/**
 * Per-request context: the organization id (so app-wide singletons like the
 * tenant-aware SIS provider resolve the current tenant without a signature change)
 * and the request/correlation id (F19, so every log line for a request can be tied
 * together). The request id is set first by the request-id middleware; the org id
 * is merged in by RequestContextInterceptor after auth.
 */
export const requestContext = new AsyncLocalStorage<RequestStore>();

export function currentOrgId(): string | undefined {
  return requestContext.getStore()?.organizationId;
}

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

/**
 * Memoise a value for the lifetime of the current request (F-P2). Outside a request
 * (crons, startup) there is no store, so the loader simply runs — no cross-request
 * cache is ever created, which keeps this safe for multi-tenant data.
 */
export async function requestCached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const store = requestContext.getStore();
  if (!store) return load();
  if (!store.cache) store.cache = new Map();
  if (store.cache.has(key)) return store.cache.get(key) as T;
  const value = await load();
  store.cache.set(key, value);
  return value;
}
