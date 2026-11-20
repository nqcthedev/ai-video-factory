import { sleep } from "./retry.js";

/**
 * Minimal async rate limiter: guarantees at most `maxPerMinute` starts per rolling minute
 * and at least `minIntervalMs` between starts. Shared per provider across concurrent jobs.
 */
export class RateLimiter {
  private readonly starts: number[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly opts: { maxPerMinute?: number; minIntervalMs?: number },
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  /** Resolves when the caller may start a request. Calls are served FIFO. */
  acquire(): Promise<void> {
    const next = this.chain.then(() => this.waitTurn());
    this.chain = next.catch(() => undefined);
    return next;
  }

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    return fn();
  }

  private async waitTurn(): Promise<void> {
    const { maxPerMinute, minIntervalMs = 0 } = this.opts;
    for (;;) {
      const t = this.now();
      while (this.starts.length && t - this.starts[0]! >= 60_000) this.starts.shift();
      const last = this.starts[this.starts.length - 1];
      let delay = 0;
      if (last !== undefined && t - last < minIntervalMs) delay = minIntervalMs - (t - last);
      if (maxPerMinute && this.starts.length >= maxPerMinute) delay = Math.max(delay, 60_000 - (t - this.starts[0]!));
      if (delay <= 0) {
        this.starts.push(t);
        return;
      }
      await this.wait(delay);
    }
  }
}

const registry = new Map<string, RateLimiter>();

/** Process-wide limiter per key (e.g. "gemini"), so batch workers share one budget. */
export function sharedLimiter(key: string, opts: { maxPerMinute?: number; minIntervalMs?: number }): RateLimiter {
  let l = registry.get(key);
  if (!l) {
    l = new RateLimiter(opts);
    registry.set(key, l);
  }
  return l;
}
