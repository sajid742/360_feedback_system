/**
 * Thin fetch wrapper implementing the project-wide response envelope
 * `{ success, message, data, errors }` (API_CONTRACT.md). Injects the JWT
 * access token, unwraps `data` on success, and throws a typed ApiError on
 * failure so hooks can surface `message` / field `errors` uniformly.
 *
 * The access token is read from an injectable getter so this module has no
 * dependency on the auth feature (avoids a circular import). Auth wires it up
 * once at bootstrap via `setAccessTokenGetter`.
 */

export interface ApiEnvelope<T> {
  success: boolean;
  message: string;
  data: T;
  errors: ApiFieldError[] | null;
}

export interface ApiFieldError {
  field?: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly errors: ApiFieldError[];

  constructor(status: number, message: string, errors: ApiFieldError[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.errors = errors;
  }
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ListParams {
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  search?: string;
  [key: string]: string | number | boolean | undefined;
}

// Backend mounts routes under the /api/v1 global prefix (DEPLOYMENT.md); the
// Vite dev server proxies this path to port 3000.
const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

// Default to reading the persisted token directly so requests that fire before
// AuthProvider's effect runs (e.g. a standalone printable report route) are still
// authenticated. AuthProvider overrides this with its in-memory getter at bootstrap.
let accessTokenGetter: () => string | null = () => {
  try {
    return localStorage.getItem('e360.accessToken');
  } catch {
    return null;
  }
};

export function setAccessTokenGetter(getter: () => string | null): void {
  accessTokenGetter = getter;
}

/* --------------------------------------------------------------------------
 * Session continuity (F-H1)
 *
 * The access token is short-lived (~15 min) and nothing previously handled its
 * expiry: requests simply started returning 401, screens silently stopped
 * updating, and the user got no error and no prompt to sign in again — the app
 * appeared to freeze mid-task.
 *
 * On a 401 the refresh token is now rotated ONCE and the original request is
 * replayed. Concurrent 401s share a single in-flight refresh, so a screen firing
 * several parallel requests doesn't cause a refresh storm (which the backend's
 * refresh-reuse detection would treat as token theft). If refresh fails, the
 * stored session is cleared and the app navigates to /login.
 * ------------------------------------------------------------------------ */
const TOKEN_KEY = 'e360.accessToken';
const REFRESH_KEY = 'e360.refreshToken';
const USER_KEY = 'e360.user';

let onSessionRefreshed: ((accessToken: string) => void) | null = null;
let onSessionExpired: (() => void) | null = null;

/** AuthProvider registers these so React state follows a background refresh. */
export function setSessionHandlers(handlers: {
  onRefreshed?: (accessToken: string) => void;
  onExpired?: () => void;
}): void {
  onSessionRefreshed = handlers.onRefreshed ?? null;
  onSessionExpired = handlers.onExpired ?? null;
}

let refreshInFlight: Promise<string | null> | null = null;

function clearStoredSession(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    /* storage unavailable */
  }
}

function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  const path = window.location.pathname;
  // Public routes must not bounce (parent evaluation links, password recovery).
  if (/^\/(login|forgot-password|reset-password|evaluate)/.test(path)) return;
  window.location.assign('/login?expired=1');
}

/** Rotate the refresh token. Returns a new access token, or null if the session is over. */
async function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async (): Promise<string | null> => {
    let refreshToken: string | null = null;
    try {
      refreshToken = localStorage.getItem(REFRESH_KEY);
    } catch {
      refreshToken = null;
    }
    if (!refreshToken) return null;
    try {
      const response = await fetch(`${BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) return null;
      const envelope = (await response.json()) as ApiEnvelope<{
        accessToken: string;
        refreshToken: string;
        user: unknown;
      }> | null;
      if (!envelope?.success || !envelope.data?.accessToken) return null;
      localStorage.setItem(TOKEN_KEY, envelope.data.accessToken);
      localStorage.setItem(REFRESH_KEY, envelope.data.refreshToken);
      if (envelope.data.user) localStorage.setItem(USER_KEY, JSON.stringify(envelope.data.user));
      onSessionRefreshed?.(envelope.data.accessToken);
      return envelope.data.accessToken;
    } catch {
      return null;
    }
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

/** A 401 here means bad credentials, not an expired session — never retry these. */
function isCredentialEndpoint(path: string): boolean {
  return path.startsWith('/auth/login') || path.startsWith('/auth/refresh') || path.startsWith('/auth/mfa/login');
}

/** Handle a 401: refresh once and report whether the caller should retry. */
async function handleUnauthorized(path: string): Promise<string | null> {
  if (isCredentialEndpoint(path)) return null;
  const token = await refreshAccessToken();
  if (token) return token;
  clearStoredSession();
  onSessionExpired?.();
  redirectToLogin();
  return null;
}

function buildQuery(params?: ListParams): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      search.append(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

/** Per-call options. `headers` carries non-session credentials such as the
 *  platform provisioning key (F22), which is not a bearer token. */
export interface RequestOptions {
  headers?: Record<string, string>;
}

async function request<T>(method: string, path: string, body?: unknown, params?: ListParams, options?: RequestOptions): Promise<T> {
  const url = `${BASE_URL}${path}${buildQuery(params)}`;
  const send = (token: string | null): Promise<Response> =>
    fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options?.headers ?? {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  let response = await send(accessTokenGetter());

  // Expired access token: refresh once and replay the request (F-H1).
  if (response.status === 401) {
    const refreshed = await handleUnauthorized(path);
    if (refreshed) response = await send(refreshed);
  }

  const envelope = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;

  if (!response.ok || !envelope?.success) {
    throw new ApiError(
      response.status,
      envelope?.message ?? `Request failed with status ${response.status}`,
      envelope?.errors ?? [],
    );
  }

  return envelope.data;
}

/**
 * Fetch a binary file (e.g. report export) with the auth token and trigger a
 * browser download. Kept separate from `request()` because file responses are
 * raw bytes, not the JSON envelope.
 */
async function download(path: string, filename: string, params?: ListParams): Promise<void> {
  const requestUrl = `${BASE_URL}${path}${buildQuery(params)}`;
  const send = (token: string | null): Promise<Response> =>
    fetch(requestUrl, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) } });

  let response = await send(accessTokenGetter());
  // Downloads are often the first request after an idle period — refresh + replay (F-H1).
  if (response.status === 401) {
    const refreshed = await handleUnauthorized(path);
    if (refreshed) response = await send(refreshed);
  }
  if (!response.ok) throw new ApiError(response.status, `Download failed with status ${response.status}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export const apiClient = {
  get: <T>(path: string, params?: ListParams): Promise<T> => request<T>('GET', path, undefined, params),
  post: <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> => request<T>('POST', path, body, undefined, options),
  put: <T>(path: string, body?: unknown): Promise<T> => request<T>('PUT', path, body),
  delete: <T>(path: string): Promise<T> => request<T>('DELETE', path),
  download,
};
