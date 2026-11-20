import { HttpError, ProviderError } from "./errors.js";

export interface RetryOptions {
  /** Number of retries after the first attempt. */
  retries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  /** 0..1 — fraction of the delay randomized ("full jitter" when 1). */
  jitter?: number;
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Exponential backoff delay for a given attempt (1-based), with optional jitter. */
export function backoffDelay(
  attempt: number,
  { baseDelayMs = 1000, maxDelayMs = 60_000, factor = 2, jitter = 0.3, random = Math.random }: Partial<RetryOptions> = {},
): number {
  const raw = Math.min(maxDelayMs, baseDelayMs * factor ** (attempt - 1));
  // Keep (1 - jitter) of the delay fixed, randomize the rest — avoids thundering herds
  // when several batch workers hit the same rate limit at once.
  return Math.round(raw * (1 - jitter) + raw * jitter * random());
}

/** Default policy: retry network errors, 408/409/425/429/5xx and retryable ProviderErrors; never exhausted quotas. */
export function defaultIsRetryable(err: unknown): boolean {
  if (err instanceof ProviderError) return err.retryable && !err.exhausted;
  if (err instanceof HttpError) {
    if (isQuotaExhausted(err)) return false;
    return [408, 409, 425, 429].includes(err.status) || err.status >= 500;
  }
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    return (
      err.name === "TimeoutError" ||
      err.name === "AbortError" ||
      ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(code) ||
      /fetch failed|socket hang up|network/i.test(err.message)
    );
  }
  return false;
}

/**
 * A 429 is not always transient: free tiers report `limit: 0` (model not available on this plan)
 * or a daily cap with a multi-hour retry hint. Those should fail over, not spin.
 */
export function isQuotaExhausted(err: HttpError, maxUsefulWaitMs = 5 * 60_000): boolean {
  if (err.status !== 429 && err.status !== 403) return false;
  if (/limit:\s*0\b/.test(err.body)) return true;
  if (/insufficient_quota|quota_exceeded|billing/i.test(err.body) && err.status === 429 && !err.retryAfterMs) return true;
  if (err.retryAfterMs !== undefined && err.retryAfterMs > maxUsefulWaitMs) return true;
  return false;
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;
  const doSleep = opts.sleep ?? sleep;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt > opts.retries || !isRetryable(err)) throw err;
      let delayMs = backoffDelay(attempt, opts);
      const hinted = err instanceof HttpError ? err.retryAfterMs : undefined;
      if (hinted !== undefined) delayMs = Math.min(Math.max(delayMs, hinted), opts.maxDelayMs ?? 60_000);
      opts.onRetry?.({ attempt, delayMs, error: err });
      await doSleep(delayMs);
    }
  }
}
