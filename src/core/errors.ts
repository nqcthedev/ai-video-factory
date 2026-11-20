/** Error raised for non-2xx HTTP responses. Carries enough context to decide on retries. */
export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly url: string;
  /** Server-suggested wait before retrying, in ms (Retry-After header or provider hint). */
  readonly retryAfterMs?: number;

  constructor(opts: { status: number; body: string; url: string; retryAfterMs?: number; message?: string }) {
    super(opts.message ?? `HTTP ${opts.status} from ${redactUrl(opts.url)}: ${truncate(opts.body, 300)}`);
    this.name = "HttpError";
    this.status = opts.status;
    this.body = opts.body;
    this.url = opts.url;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/**
 * A provider-level failure. `retryable` = worth retrying the same provider later;
 * `exhausted` = quota is gone (e.g. free-tier limit 0, daily cap), move on to the next provider.
 */
export class ProviderError extends Error {
  readonly provider: string;
  readonly retryable: boolean;
  readonly exhausted: boolean;
  override readonly cause?: unknown;

  constructor(provider: string, message: string, opts: { retryable?: boolean; exhausted?: boolean; cause?: unknown } = {}) {
    super(`[${provider}] ${message}`);
    this.name = "ProviderError";
    this.provider = provider;
    this.retryable = opts.retryable ?? false;
    this.exhausted = opts.exhausted ?? false;
    this.cause = opts.cause;
  }
}

/** Provider is not configured (missing key, missing model files...). Never retried. */
export class ProviderUnavailableError extends ProviderError {
  constructor(provider: string, reason: string) {
    super(provider, `unavailable: ${reason}`, { retryable: false });
    this.name = "ProviderUnavailableError";
  }
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function redactUrl(url: string): string {
  return url.replace(/([?&](key|api_key|access_token)=)[^&]+/gi, "$1***");
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
