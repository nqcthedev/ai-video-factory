import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedConfig } from "../config/load.js";
import { type Job } from "../core/job.js";
import type { Logger } from "../core/logger.js";
import { mapWithConcurrency } from "../core/pool.js";
import { backoffDelay, sleep } from "../core/retry.js";
import { createJob, runPipeline } from "../pipeline.js";
import { FORMATS } from "../formats.js";
import { createTtsProviders } from "../tts/providers.js";
import { HtmlRenderer } from "../visuals/designed/renderer.js";
import { createVisualProviders } from "../visuals/providers.js";
import type { BatchItem } from "./topics.js";

export interface BatchReportItem {
  topic: string;
  format: string;
  jobId: string;
  status: "done" | "failed";
  attempts: number;
  video?: string;
  url?: string;
  costUsd?: number;
  error?: string;
}

/**
 * Run many topics with a concurrency limit. Providers (Kokoro model, browser) are shared across
 * jobs; API rate limits are shared process-wide. A failed job is resumed — not restarted — after
 * an exponential backoff, so finished stages are never paid for twice.
 */
export async function runBatch(
  loaded: LoadedConfig,
  items: BatchItem[],
  log: Logger,
  opts: { concurrency: number; jobRetries?: number },
): Promise<{ report: BatchReportItem[]; reportPath: string }> {
  const renderer = new HtmlRenderer();
  const ttsByFormat = new Map<string, ReturnType<typeof createTtsProviders>>();
  const tts = (format: keyof typeof FORMATS) => {
    if (!ttsByFormat.has(format)) ttsByFormat.set(format, createTtsProviders(loaded.config, loaded.env, loaded.modelsDir, {}, FORMATS[format].speechRate));
    return ttsByFormat.get(format)!;
  };
  const visuals = createVisualProviders(loaded.config, loaded.env);
  const retries = opts.jobRetries ?? 1;
  try {
    const results = await mapWithConcurrency(items, opts.concurrency, async (item, i): Promise<BatchReportItem> => {
      const job: Job = createJob(loaded, { topic: item.topic, format: item.format, options: { brief: item.brief, publish: item.publish, publishAt: item.publishAt } }, log);
      log.info(`[${i + 1}/${items.length}] ${item.topic}`, { job: job.manifest.id, format: item.format });
      let attempt = 0;
      for (;;) {
        attempt++;
        try {
          const r = await runPipeline(job, loaded, { renderer, tts, visuals });
          return { topic: item.topic, format: item.format, jobId: job.manifest.id, status: "done", attempts: attempt, video: r.video, url: r.publishedUrl, costUsd: job.manifest.cost?.totalUsd };
        } catch (err) {
          if (attempt > retries) {
            return { topic: item.topic, format: item.format, jobId: job.manifest.id, status: "failed", attempts: attempt, error: (err as Error).message };
          }
          const wait = backoffDelay(attempt, { baseDelayMs: 15_000, maxDelayMs: 300_000 });
          log.warn("job failed, will resume", { job: job.manifest.id, attempt, waitMs: wait, error: (err as Error).message.slice(0, 200) });
          await sleep(wait);
        }
      }
    });
    const report = results.map((r, i) => (r.status === "fulfilled" ? r.value : { topic: items[i]!.topic, format: items[i]!.format, jobId: "-", status: "failed" as const, attempts: 1, error: String(r.reason) }));
    const reportPath = join(loaded.jobsDir, `batch-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    return { report, reportPath };
  } finally {
    await renderer.close();
  }
}
