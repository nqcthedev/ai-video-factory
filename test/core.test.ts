import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseTopics } from "../src/batch/topics.js";
import { ConfigError, deepMerge, loadEnv, parseConfig } from "../src/config/load.js";
import { ConfigSchema } from "../src/config/schema.js";
import { estimateCost } from "../src/core/cost.js";
import { HttpError } from "../src/core/errors.js";
import { parseGoDuration, parseRetryAfter } from "../src/core/http.js";
import { Job, newJobId, slugify } from "../src/core/job.js";
import { nullLogger } from "../src/core/logger.js";
import { mapWithConcurrency } from "../src/core/pool.js";
import { RateLimiter } from "../src/core/rateLimiter.js";
import { backoffDelay, isQuotaExhausted, withRetry } from "../src/core/retry.js";

describe("retry & backoff", () => {
  it("grows exponentially and caps", () => {
    const d = [1, 2, 3, 4, 10].map((a) => backoffDelay(a, { baseDelayMs: 1000, maxDelayMs: 5000, jitter: 0 }));
    expect(d).toEqual([1000, 2000, 4000, 5000, 5000]);
    const j = backoffDelay(1, { baseDelayMs: 1000, jitter: 0.5, random: () => 0 });
    expect(j).toBe(500);
  });

  it("retries retryable errors and honours Retry-After", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const r = await withRetry(
      async () => {
        if (++n < 3) throw new HttpError({ status: 429, body: "slow down", url: "u", retryAfterMs: 7000 });
        return "ok";
      },
      { retries: 5, baseDelayMs: 100, maxDelayMs: 60_000, jitter: 0, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(r).toBe("ok");
    expect(sleeps).toEqual([7000, 7000]);
  });

  it("does not retry 400s or exhausted quotas", async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new HttpError({ status: 400, body: "bad", url: "u" }); }, { retries: 3, sleep: async () => {} })).rejects.toThrow();
    expect(n).toBe(1);
    const q = new HttpError({ status: 429, body: "Quota exceeded ... limit: 0", url: "u" });
    expect(isQuotaExhausted(q)).toBe(true);
    expect(isQuotaExhausted(new HttpError({ status: 429, body: "x", url: "u", retryAfterMs: 3 * 3600_000 }))).toBe(true);
    expect(isQuotaExhausted(new HttpError({ status: 429, body: "x", url: "u", retryAfterMs: 2000 }))).toBe(false);
  });

  it("parses retry hints", () => {
    expect(parseGoDuration("3h6m19.5s")).toBe(11_179_500);
    expect(parseRetryAfter(new Headers({ "retry-after": "12" }), "")).toBe(12_000);
    expect(parseRetryAfter(undefined, "Please retry in 41.2s.")).toBe(41_200);
    expect(parseRetryAfter(undefined, '"retryDelay": "17s"')).toBe(17_000);
    expect(parseRetryAfter(undefined, "nothing")).toBeUndefined();
  });
});

describe("rate limiter & pool", () => {
  it("enforces max requests per minute with a fake clock", async () => {
    let now = 0;
    const waits: number[] = [];
    const rl = new RateLimiter({ maxPerMinute: 2 }, () => now, async (ms) => { waits.push(ms); now += ms; });
    await rl.acquire();
    await rl.acquire();
    await rl.acquire();
    expect(waits).toEqual([60_000]);
  });

  it("enforces a minimum interval", async () => {
    let now = 0;
    const rl = new RateLimiter({ minIntervalMs: 500 }, () => now, async (ms) => { now += ms; });
    await rl.acquire();
    await rl.acquire();
    expect(now).toBe(500);
  });

  it("limits concurrency and keeps order", async () => {
    let inFlight = 0;
    let max = 0;
    const res = await mapWithConcurrency([5, 1, 3, 2], 2, async (v) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, v));
      inFlight--;
      if (v === 3) throw new Error("boom");
      return v * 2;
    });
    expect(max).toBe(2);
    expect(res.map((r) => (r.status === "fulfilled" ? r.value : "err"))).toEqual([10, 2, "err", 4]);
  });
});

describe("cost estimate", () => {
  const prices = ConfigSchema.parse({}).costs;
  it("prices LLM tokens, TTS characters and images", () => {
    const c = estimateCost({ llm: { model: "gemini-2.5-flash", promptTokens: 1_000_000, completionTokens: 100_000 }, tts: { provider: "elevenlabs", characters: 1000 }, images: { "gemini-image": 8, designed: 2 } }, prices);
    expect(c.llmUsd).toBeCloseTo(0.3 + 0.25);
    expect(c.ttsUsd).toBeCloseTo(0.18);
    expect(c.imagesUsd).toBeCloseTo(0.312);
    expect(c.totalUsd).toBeCloseTo(0.55 + 0.18 + 0.312);
  });
  it("Kokoro is free and unknown models are flagged", () => {
    const c = estimateCost({ llm: { model: "mystery", promptTokens: 10, completionTokens: 10 }, tts: { provider: "kokoro", characters: 5000 } }, prices);
    expect(c.totalUsd).toBe(0);
    expect(c.notes.join()).toMatch(/no price configured for LLM model mystery/);
  });
});

describe("config", () => {
  it("fills every default from an empty file", () => {
    const c = parseConfig({});
    expect(c.tts.order[0]).toBe("kokoro");
    expect(c.render.loudness.integratedLufs).toBe(-14);
    expect(c.visuals.order).toEqual(["designed"]);
  });
  it("reports precise validation errors", () => {
    try {
      parseConfig({ render: { fps: 7, captions: { highlightColor: "yellow" } }, tts: { order: ["espeak"] } }, "avf.config.yaml");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as Error).message;
      expect(msg).toContain("render.fps");
      expect(msg).toContain("render.captions.highlightColor");
      expect(msg).toContain("tts.order.0");
    }
  });
  it("deep-merges overrides, replacing arrays", () => {
    expect(deepMerge({ a: { b: 1, c: [1, 2] } }, { a: { c: [3] } })).toEqual({ a: { b: 1, c: [3] } });
  });
  it("validates env", () => {
    expect(loadEnv({ GEMINI_API_KEY: "k" }).GEMINI_BASE_URL).toMatch(/openai\/$/);
    expect(() => loadEnv({ GEMINI_BASE_URL: "not a url" })).toThrow(ConfigError);
  });
});

describe("batch topics", () => {
  it("parses YAML with defaults and string shorthand", () => {
    const items = parseTopics("defaults:\n  format: long\ntopics:\n  - Why octopuses are so smart\n  - topic: The 5-minute rule\n    format: short\n    publishAt: 2026-12-01T15:00:00Z\n", "yaml");
    expect(items).toEqual([
      { topic: "Why octopuses are so smart", format: "long" },
      { topic: "The 5-minute rule", format: "short", publishAt: "2026-12-01T15:00:00Z" },
    ]);
  });
  it("parses CSV", () => {
    const items = parseTopics('topic,format,publish\n"Why cats purr, explained",short,yes\nDeep sea fish,long,\n', "csv");
    expect(items).toEqual([
      { topic: "Why cats purr, explained", format: "short", publish: true },
      { topic: "Deep sea fish", format: "long" },
    ]);
  });
  it("rejects bad entries", () => {
    expect(() => parseTopics("topics:\n  - topic: x\n    format: square\n", "yaml")).toThrow(/topics/);
  });
});

describe("job manifest", () => {
  it("creates ids, caches finished stages and resumes after failure", async () => {
    expect(slugify("Why Octopuses are SO smart?!")).toBe("why-octopuses-are-so-smart");
    expect(newJobId("Hello world", "short", new Date("2026-11-20T05:20:00Z"))).toMatch(/^20261120-0520-short-hello-world-[0-9a-f]{4}$/);
    const dir = mkdtempSync(join(tmpdir(), "avf-job-"));
    const job = Job.create(dir, { topic: "t", format: "short", config: ConfigSchema.parse({}) }, nullLogger);
    const fn = vi.fn(async () => ({ value: 42 }));
    expect(await job.runStage("script", fn)).toEqual({ value: 42 });
    await expect(job.runStage("voice", async () => { throw new Error("tts down"); })).rejects.toThrow("tts down");
    const reloaded = Job.load(dir, job.manifest.id, nullLogger);
    expect(reloaded.stage("script").status).toBe("done");
    expect(reloaded.stage("voice")).toMatchObject({ status: "failed", error: "tts down", attempts: 1 });
    expect(await reloaded.runStage("script", fn)).toEqual({ value: 42 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await reloaded.runStage("voice", async () => "ok")).toBe("ok");
    expect(reloaded.stage("voice").attempts).toBe(2);
    reloaded.invalidateFrom("voice");
    expect(reloaded.stage("voice").status).toBe("pending");
    expect(reloaded.stage("script").status).toBe("done");
  });
});
