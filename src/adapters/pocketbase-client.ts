/**
 * Reusable, minimal PocketBase HTTP client: auth (with a single re-auth on
 * 401), pagination, timeouts, and typed errors, built around an injected
 * `fetch`. No pi imports, no domain knowledge — this is a general-purpose
 * adapter meant to be reused by the sync push (a later phase) for
 * create/update calls through the same `request()` primitive.
 */

export type PocketBaseFetch = typeof fetch;

export interface PocketBaseRecord {
  id: string;
  [key: string]: unknown;
}

export interface PocketBaseListResult<T> {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: T[];
}

export interface PocketBaseClientOptions {
  /** Base URL, e.g. `https://pb.example.com` (no trailing slash required). */
  url: string;
  email: string;
  password: string;
  /** Injectable for tests; defaults to `globalThis.fetch`. */
  fetch?: PocketBaseFetch;
  /** Per-request timeout in ms. Defaults to 3000. */
  timeoutMs?: number;
}

export type PocketBaseErrorKind = "network" | "timeout" | "http" | "auth";

export class PocketBaseError extends Error {
  readonly kind: PocketBaseErrorKind;
  readonly status: number | undefined;

  constructor(kind: PocketBaseErrorKind, message: string, status?: number) {
    super(message);
    this.name = "PocketBaseError";
    this.kind = kind;
    this.status = status;
  }
}

interface AuthResponse {
  token: string;
  record: PocketBaseRecord;
}

const DEFAULT_TIMEOUT_MS = 3000;
const AUTH_PATH = "/api/collections/users/auth-with-password";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Build a `records` list path with pagination/filter/sort query params. */
function listPath(collection: string, page: number, perPage: number, filter?: string, sort?: string): string {
  const params = new URLSearchParams({ page: String(page), perPage: String(perPage) });
  if (filter) params.set("filter", filter);
  if (sort) params.set("sort", sort);
  return `/api/collections/${encodeURIComponent(collection)}/records?${params.toString()}`;
}

/**
 * Minimal PocketBase client: lazily authenticates on the first request,
 * reuses the token, and re-authenticates exactly once on a 401 before
 * failing cleanly. `request` is the generic primitive other adapters (and
 * a future sync sink) build on; `list` is a pagination convenience for
 * read-only catalog fetches.
 */
export class PocketBaseClient {
  private readonly baseUrl: string;
  private readonly email: string;
  private readonly password: string;
  private readonly doFetch: PocketBaseFetch;
  private readonly timeoutMs: number;
  private token: string | undefined;
  /** Single-flight guard: concurrent callers with no token share this in-flight authentication instead of each posting their own. Cleared on settle (success or failure) so a failed auth never poisons a later attempt. */
  private authInFlight: Promise<void> | undefined;

  constructor(options: PocketBaseClientOptions) {
    this.baseUrl = options.url.replace(/\/+$/, "");
    this.email = options.email;
    this.password = options.password;
    this.doFetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Perform `request` with the current token (authenticating first if there is none). `signal` bounds the underlying fetch when starting a fresh authentication; ignored by a caller that joins one already in flight. */
  private authenticate(signal?: AbortSignal): Promise<void> {
    if (!this.authInFlight) {
      this.authInFlight = this.doAuthenticate(signal).finally(() => {
        this.authInFlight = undefined;
      });
    }
    return this.authInFlight;
  }

  private async doAuthenticate(signal?: AbortSignal): Promise<void> {
    const response = await this.rawFetch("POST", AUTH_PATH, { identity: this.email, password: this.password }, undefined, signal);
    if (!response.ok) {
      throw new PocketBaseError("auth", `kankaku: hub authentication failed (${response.status})`, response.status);
    }
    const body = (await response.json()) as AuthResponse;
    this.token = body.token;
  }

  /** `signal`, when given, is composed with this call's own per-request timeout signal (`AbortSignal.any`) so a caller can additionally bound a whole sequence of calls with one overall deadline. */
  private async rawFetch(method: string, path: string, body: unknown, token: string | undefined, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    try {
      return await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(token !== undefined ? { Authorization: token } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: requestSignal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new PocketBaseError("timeout", `kankaku: hub request timed out after ${this.timeoutMs}ms: ${method} ${path}`);
      }
      throw new PocketBaseError("network", `kankaku: hub request failed: ${method} ${path}: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Generic request primitive: `method`/`path` (e.g. `/api/collections/clients/records`)
   * with an optional JSON `body`. Authenticates lazily, retries exactly
   * once on a 401 after re-authenticating, and throws a typed
   * {@link PocketBaseError} on network failure, timeout, auth failure, or
   * any other non-2xx response. `signal`, when given, is composed with
   * every underlying request's own per-request timeout, so a caller can
   * bound this whole call (including a lazy auth and the 401 retry) with
   * one overall deadline; an abort surfaces as a `"timeout"` error, same as
   * a per-request timeout.
   */
  async request<T = unknown>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    if (this.token === undefined) {
      await this.authenticate(signal);
    }

    let response = await this.rawFetch(method, path, body, this.token, signal);

    if (response.status === 401) {
      this.token = undefined;
      await this.authenticate(signal);
      response = await this.rawFetch(method, path, body, this.token, signal);
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw new PocketBaseError("auth", `kankaku: hub rejected credentials for ${method} ${path}`, response.status);
      }
      throw new PocketBaseError("http", `kankaku: hub request failed: ${method} ${path} (${response.status})`, response.status);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /**
   * Fetch every record of `collection`, paginating until every page is
   * read. `perPage` defaults to 200; `filter`/`sort` are passed through
   * verbatim as PocketBase filter/sort expressions. `signal`, when given,
   * bounds the whole pagination loop (see {@link request}).
   */
  async list<T extends PocketBaseRecord = PocketBaseRecord>(
    collection: string,
    opts: { filter?: string; sort?: string; perPage?: number } = {},
    signal?: AbortSignal,
  ): Promise<T[]> {
    const perPage = opts.perPage ?? 200;
    const items: T[] = [];
    let page = 1;

    for (;;) {
      const result = await this.request<PocketBaseListResult<T>>("GET", listPath(collection, page, perPage, opts.filter, opts.sort), undefined, signal);
      items.push(...result.items);
      if (page >= result.totalPages || result.items.length === 0) break;
      page += 1;
    }

    return items;
  }
}
