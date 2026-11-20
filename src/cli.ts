#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { Command, InvalidArgumentError, Option } from "commander";
import { runBatch } from "./batch/runBatch.js";
import { loadTopicsFile } from "./batch/topics.js";
import { ConfigError, loadConfig } from "./config/load.js";
import { FORMATS, THEMES, TTS_PROVIDERS, VISUAL_PROVIDERS } from "./config/schema.js";
import { Job, STAGES, type StageName } from "./core/job.js";
import { createLogger } from "./core/logger.js";
import { runDoctor } from "./doctor.js";
import { createJob, exportJob, runPipeline } from "./pipeline.js";
import { KokoroEngine } from "./tts/kokoro/engine.js";
import { downloadKokoro } from "./tts/kokoro/models.js";

const log = createLogger();

function list<T extends string>(allowed: readonly T[]) {
  return (value: string): T[] => {
    const items = value.split(",").map((s) => s.trim()).filter(Boolean);
    for (const i of items) if (!allowed.includes(i as T)) throw new InvalidArgumentError(`"${i}" is not one of: ${allowed.join(", ")}`);
    return items as T[];
  };
}

function isoDate(v: string): string {
  if (Number.isNaN(Date.parse(v)) || !/T/.test(v)) throw new InvalidArgumentError("expected an ISO 8601 date-time, e.g. 2026-12-01T15:00:00Z");
  return v;
}

const program = new Command()
  .name("avf")
  .description("AI Video Factory: topic in, finished captioned video out.")
  .version("1.0.0")
  .option("-c, --config <file>", "config YAML (default: ./avf.config.yaml if present)");

const configPath = () => (program.opts() as { config?: string }).config;

program
  .command("make")
  .description("create one video from a topic")
  .argument("<topic>", "what the video is about")
  .addOption(new Option("-f, --format <format>", "output format").choices(FORMATS).default("short"))
  .option("--brief <text>", "extra guidance for the script writer (angle, facts to include)")
  .option("--voice <voice>", "Kokoro voice id (e.g. af_heart, am_michael, bf_emma)")
  .option("--speed <n>", "speech speed (0.5-2.0)", parseFloat)
  .addOption(new Option("--theme <theme>", "colour theme").choices([...THEMES, "auto"]))
  .option("--tts <providers>", `TTS fallback order (${TTS_PROVIDERS.join(",")})`, list(TTS_PROVIDERS))
  .option("--visuals <providers>", `visual providers in order (${VISUAL_PROVIDERS.join(",")})`, list(VISUAL_PROVIDERS))
  .option("--no-music", "disable the background music bed")
  .option("--publish", "upload to YouTube when done")
  .option("--publish-at <iso>", "schedule the YouTube release (implies private until then)", isoDate)
  .option("-o, --out <dir>", "also copy video, thumbnail and manifest to this folder")
  .option("--name <name>", "base file name used with --out")
  .action(async (topic: string, o) => {
    const overrides: Record<string, unknown> = {};
    const set = (path: string[], v: unknown) => {
      if (v === undefined) return;
      let cur = overrides;
      for (const k of path.slice(0, -1)) cur = (cur[k] ??= {}) as Record<string, unknown>;
      cur[path[path.length - 1]!] = v;
    };
    set(["tts", "kokoro", "voice"], o.voice);
    set(["tts", "kokoro", "speed"], o.speed);
    set(["channel", "theme"], o.theme);
    set(["tts", "order"], o.tts);
    set(["visuals", "order"], o.visuals);
    if (o.music === false) set(["render", "music", "enabled"], false);
    const loaded = loadConfig({ configPath: configPath(), overrides });
    const job = createJob(loaded, { topic, format: o.format, options: { brief: o.brief, publish: o.publish, publishAt: o.publishAt } }, log);
    log.info(`job ${job.manifest.id}`, { dir: job.dir });
    const r = await runPipeline(job, loaded);
    summary(job);
    if (o.out) {
      mkdirSync(o.out, { recursive: true });
      for (const f of exportJob(job, o.out, o.name ?? job.manifest.id)) log.info("exported", { file: f });
    }
    if (r.publishedUrl) log.info("published", { url: r.publishedUrl });
  });

program
  .command("batch")
  .description("create videos for every topic in a YAML or CSV file")
  .argument("<file>", "topics.yaml / topics.csv")
  .option("-j, --concurrency <n>", "videos in parallel (default: config batch.concurrency)", (v) => parseInt(v, 10))
  .option("--retries <n>", "resume a failed job this many times", (v) => parseInt(v, 10), 1)
  .action(async (file: string, o) => {
    const loaded = loadConfig({ configPath: configPath() });
    const items = loadTopicsFile(file);
    const concurrency = o.concurrency ?? loaded.config.batch.concurrency;
    log.info(`batch: ${items.length} topics`, { concurrency });
    const { report, reportPath } = await runBatch(loaded, items, log, { concurrency, jobRetries: o.retries });
    for (const r of report) {
      const fields = { job: r.jobId, video: r.video, cost: r.costUsd, error: r.error };
      if (r.status === "done") log.info(`DONE ${r.topic}`, fields);
      else log.error(`FAILED ${r.topic}`, fields);
    }
    log.info("batch report", { file: reportPath });
    if (report.some((r) => r.status === "failed")) process.exitCode = 1;
  });

program
  .command("resume")
  .description("continue a job from where it stopped (completed stages are reused)")
  .argument("<jobId>", "job id or job directory")
  .addOption(new Option("--from <stage>", "redo this stage and everything after it").choices(STAGES))
  .option("--publish", "also publish to YouTube")
  .option("--publish-at <iso>", "schedule the YouTube release", isoDate)
  .action(async (id: string, o) => {
    const loaded = loadConfig({ configPath: configPath() });
    const job = Job.load(loaded.jobsDir, id, log);
    if (o.from) job.invalidateFrom(o.from as StageName);
    if (o.publish || o.publishAt) {
      job.manifest.options = { ...job.manifest.options, publish: true, ...(o.publishAt ? { publishAt: o.publishAt } : {}) };
      if (job.manifest.stages.publish.status !== "done") job.manifest.stages.publish = { status: "pending", attempts: 0 };
      job.save();
    }
    await runPipeline(job, loaded);
    summary(job);
  });

program
  .command("list")
  .description("list jobs and their status")
  .action(() => {
    const loaded = loadConfig({ configPath: configPath() });
    const jobs = Job.list(loaded.jobsDir);
    if (!jobs.length) return console.log("no jobs yet");
    const mark: Record<string, string> = { done: "ok", failed: "FAIL", skipped: "-", running: "..", pending: "." };
    for (const m of jobs) {
      const stages = Object.entries(m.stages).map(([k, v]) => `${k}:${mark[v.status]}`).join(" ");
      console.log(`${m.status.padEnd(7)} ${m.id}  ${m.cost ? `$${m.cost.totalUsd.toFixed(4)}` : "       "}  ${stages}`);
    }
  });

program
  .command("doctor")
  .description("check ffmpeg, Chromium, models, keys and config")
  .option("--online", "also probe the LLM endpoint (lists models; no generation quota used)")
  .action(async (o) => {
    let loaded;
    try {
      loaded = loadConfig({ configPath: configPath() });
      console.log(`ok   ${"config".padEnd(28)} ${loaded.configPath ?? "(built-in defaults)"}`);
    } catch (e) {
      console.log(`FAIL ${"config".padEnd(28)} ${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }
    const checks = await runDoctor(loaded, { online: o.online });
    for (const c of checks) console.log(`${(c.status === "ok" ? "ok" : c.status === "warn" ? "warn" : "FAIL").padEnd(4)} ${c.name.padEnd(28)} ${c.detail}`);
    if (checks.some((c) => c.status === "fail")) process.exitCode = 1;
  });

const models = program.command("models").description("manage local model files");
models
  .command("download")
  .description("download Kokoro-82M (ONNX, ~350 MB) from GitHub releases and verify checksums")
  .option("--force", "re-download even if present")
  .action(async (o) => {
    const loaded = loadConfig({ configPath: configPath() });
    await downloadKokoro(loaded.modelsDir, log, { force: o.force });
  });

program
  .command("voices")
  .description("list local Kokoro voices")
  .action(async () => {
    const loaded = loadConfig({ configPath: configPath() });
    const v = await new KokoroEngine(`${loaded.modelsDir}/kokoro`).listVoices();
    console.log(v.join("\n"));
  });

function summary(job: Job) {
  const m = job.manifest;
  const p = (m.providers ?? {}) as Record<string, unknown>;
  const c = m.cost;
  console.log(
    [
      "",
      `done ${m.id}`,
      `  video      ${m.outputs.video ? job.path(m.outputs.video) : "-"}`,
      `  thumbnail  ${m.outputs.thumbnail ? job.path(m.outputs.thumbnail) : "-"}`,
      `  providers  llm=${p.llm} tts=${p.voice} timings=${p.wordTimings} visuals=${JSON.stringify(p.visuals)}`,
      c ? `  cost       $${c.totalUsd.toFixed(4)} (llm $${c.llmUsd.toFixed(4)}, tts $${c.ttsUsd.toFixed(4)}, images $${c.imagesUsd.toFixed(4)})` : "",
      "",
    ].join("\n"),
  );
}

program.parseAsync().catch((err) => {
  if (err instanceof ConfigError) log.error(err.message);
  else log.error((err as Error)?.message ?? String(err), { stack: process.env.AVF_DEBUG ? (err as Error)?.stack : undefined });
  process.exitCode = 1;
});
