/**
 * The one way the app talks to the API. It:
 * - keeps the access token in memory only (never in localStorage, so injected scripts can't read
 *   a long-lived secret; the refresh token is an HttpOnly cookie the browser sends itself);
 * - refreshes the access token once when a call gets 401, sharing one refresh between callers;
 * - unwraps `{ data, meta }` and turns `{ error }` into an ApiError with the server's code,
 *   message and request id (shown to staff as a reference code);
 * - adds an Idempotency-Key to money-moving calls, kept the same across retries of one action.
 *
 * All money arithmetic happens on the server. The app only displays the strings it is given.
 */

export const API_BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ApiResult<T> {
  data: T;
  meta?: Record<string, unknown>;
}

type TokenListener = (token: string | null) => void;

let accessToken: string | null = null;
let refreshing: Promise<string | null> | null = null;
const listeners = new Set<TokenListener>();

export function getAccessToken() {
  return accessToken;
}

export function setAccessToken(token: string | null) {
  accessToken = token;
  for (const l of listeners) l(token);
}

export function onTokenChange(l: TokenListener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The fetch used by this module; replaceable in tests. */
let fetchImpl: typeof fetch = (...args) => fetch(...args);
export function setFetch(f: typeof fetch) {
  fetchImpl = f;
}

async function parse(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toError(status: number, body: unknown): ApiError {
  const e = (body as { error?: { code?: string; message?: string; details?: unknown; requestId?: string } } | undefined)?.error;
  if (e) return new ApiError(status, e.code ?? 'ERROR', e.message ?? 'Something went wrong', e.details, e.requestId);
  if (status === 0) return new ApiError(0, 'NETWORK', 'Cannot reach the server. Check the connection and try again.');
  return new ApiError(status, 'HTTP_' + status, 'Something went wrong. Please try again.');
}

/** Gets a fresh access token from the refresh cookie. Resolves null when signed out. */
export function refreshAccessToken(): Promise<string | null> {
  refreshing ??= acrossTabs(async () => {
    try {
      const res = await fetchImpl(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = await parse(res);
      if (!res.ok) {
        setAccessToken(null);
        return null;
      }
      const token = (body as { data: { accessToken: string } }).data.accessToken;
      setAccessToken(token);
      return token;
    } catch {
      // Network trouble: keep the current state; the caller sees its own error.
      return accessToken;
    } finally {
      refreshing = null;
    }
  });
  return refreshing;
}

/**
 * Runs one refresh at a time across every tab of this site (POS and kitchen screen open side by
 * side), so a tab never sends a refresh cookie that another tab is rotating at that moment.
 */
function acrossTabs<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? (locks.request('ros-auth-refresh', fn) as Promise<T>) : fn();
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Send this Idempotency-Key. Pass the same key when retrying the same action. */
  idempotencyKey?: string;
  /** Skip the automatic refresh-and-retry (used by the auth calls themselves). */
  noRefresh?: boolean;
  signal?: AbortSignal;
}

export function buildUrl(path: string, query?: RequestOptions['query']) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return `${API_BASE}${path}${s ? `?${s}` : ''}`;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<ApiResult<T>> {
  const send = async (token: string | null) => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    try {
      return await fetchImpl(buildUrl(path, opts.query), {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        credentials: 'same-origin',
        signal: opts.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw toError(0, undefined);
    }
  };

  let res = await send(accessToken);
  if (res.status === 401 && !opts.noRefresh) {
    const token = await refreshAccessToken();
    if (token) res = await send(token);
  }
  const body = await parse(res);
  if (!res.ok) throw toError(res.status, body);
  return (body as ApiResult<T>) ?? { data: undefined as T };
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) => request<T>(path, { query, signal }).then((r) => r.data),
  page: <T>(path: string, query?: RequestOptions['query']) => request<T[]>(path, { query }).then((r) => ({ items: r.data, meta: r.meta as unknown as PageMeta })),
  /** Every row of a paged list (100 per request), for admin lists that must show everything. */
  all: async <T>(path: string, query?: RequestOptions['query']): Promise<T[]> => {
    const rows: T[] = [];
    for (let page = 1; ; page++) {
      const r = await request<T[]>(path, { query: { ...query, page, pageSize: 100 } });
      rows.push(...r.data);
      const meta = r.meta as unknown as PageMeta | undefined;
      if (!meta || page >= meta.totalPages) return rows;
    }
  },
  post: <T>(path: string, body?: unknown, idempotencyKey?: string) => request<T>(path, { method: 'POST', body: body ?? {}, idempotencyKey }).then((r) => r.data),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body }).then((r) => r.data),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body }).then((r) => r.data),
  del: <T>(path: string, body?: unknown) => request<T>(path, { method: 'DELETE', body }).then((r) => r.data),
};

/** Downloads a protected file (invoice PDF, export) with the access token and opens it. */
export async function openFile(path: string, query?: RequestOptions['query']) {
  const go = (token: string | null) => fetchImpl(buildUrl(path, query), { headers: token ? { Authorization: `Bearer ${token}` } : {}, credentials: 'same-origin' });
  let res = await go(accessToken);
  if (res.status === 401) res = await go(await refreshAccessToken());
  if (!res.ok) throw toError(res.status, await parse(res));
  const url = URL.createObjectURL(await res.blob());
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function newKey() {
  return crypto.randomUUID();
}

/** A short message for staff, with the reference code when the server gave one. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'VALIDATION_FAILED' && Array.isArray(err.details) && typeof err.details[0] === 'string') {
      const first = err.details[0] as string;
      return first.charAt(0).toUpperCase() + first.slice(1);
    }
    const friendly = FRIENDLY[err.code];
    const msg = friendly ?? err.message;
    return err.requestId && err.status >= 500 ? `${msg} (reference ${err.requestId.slice(0, 8)})` : msg;
  }
  return 'Something went wrong. Please try again.';
}

const FRIENDLY: Record<string, string> = {
  CONCURRENT_UPDATE: 'This order was changed on another device. It has been refreshed; please try again.',
  NO_OPEN_SHIFT: 'Open your cash drawer first.',
  MISSING_PERMISSION: 'Your role cannot do this. Ask a manager.',
  RATE_LIMITED: 'Too many tries. Wait a minute and try again.',
  IDEMPOTENCY_IN_PROGRESS: 'Still working on the last tap. Please wait a moment.',
};
