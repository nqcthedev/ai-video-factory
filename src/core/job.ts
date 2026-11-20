import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig, FormatName } from "../config/schema.js";
import type { Logger } from "./logger.js";

export const STAGES = ["script", "voice", "visuals", "captions", "render", "thumbnail", "publish"] as const;
export type StageName = (typeof STAGES)[number];

export interface StageRecord {
  status: "pending" | "running" | "done" | "failed" | "skipped";
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  attempts: number;
  error?: string;
  /** Small JSON result of the stage (paths are relative to the job dir). */
  data?: unknown;
}

export interface JobOptions {
  publish?: boolean;
  publishAt?: string;
  /** Free-form notes passed to the script prompt (angle, facts to include...). */
  brief?: string;
}

export interface Manifest {
  version: 1;
  id: string;
  topic: string;
  format: FormatName;
  createdAt: string;
  updatedAt: string;
  status: "running" | "done" | "failed";
  options: JobOptions;
  /** Resolved config snapshot, so `avf resume` re-runs with identical settings. */
  config: AppConfig;
  configHash: string;
  stages: Record<StageName, StageRecord>;
  outputs: Record<string, string>;
  /** Estimated API spend for this video (USD). */
  cost?: { llmUsd: number; ttsUsd: number; imagesUsd: number; totalUsd: number; notes: string[] };
  /** Which provider actually produced each asset type. */
  providers?: Record<string, unknown>;
  error?: string;
}

export function slugify(s: string, max = 40): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/g, "") || "video"
  );
}

export function newJobId(topic: string, format: FormatName, now = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-").slice(0, 13);
  return `${ts}-${format}-${slugify(topic, 32)}-${randomBytes(2).toString("hex")}`;
}

export function hashConfig(cfg: unknown): string {
  return createHash("sha256").update(JSON.stringify(cfg)).digest("hex").slice(0, 12);
}

export class Job {
  readonly dir: string;
  manifest: Manifest;

  private constructor(dir: string, manifest: Manifest, readonly log: Logger) {
    this.dir = dir;
    this.manifest = manifest;
  }

  static create(jobsDir: string, init: { topic: string; format: FormatName; config: AppConfig; options?: JobOptions; id?: string }, log: Logger): Job {
    const id = init.id ?? newJobId(init.topic, init.format);
    const dir = join(jobsDir, id);
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const manifest: Manifest = {
      version: 1,
      id,
      topic: init.topic,
      format: init.format,
      createdAt: now,
      updatedAt: now,
      status: "running",
      options: init.options ?? {},
      config: init.config,
      configHash: hashConfig(init.config),
      stages: Object.fromEntries(STAGES.map((s) => [s, { status: "pending", attempts: 0 }])) as Record<StageName, StageRecord>,
      outputs: {},
    };
    const job = new Job(dir, manifest, log.toFile(join(dir, "log.jsonl")).child({ job: id }));
    job.save();
    return job;
  }

  static load(jobsDir: string, id: string, log: Logger): Job {
    const dir = existsSync(join(id, "manifest.json")) ? id : join(jobsDir, id);
    const path = join(dir, "manifest.json");
    if (!existsSync(path)) throw new Error(`No job "${id}" (looked for ${path})`);
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
    return new Job(dir, manifest, log.toFile(join(dir, "log.jsonl")).child({ job: manifest.id }));
  }

  static list(jobsDir: string): Manifest[] {
    if (!existsSync(jobsDir)) return [];
    return readdirSync(jobsDir)
      .filter((d) => existsSync(join(jobsDir, d, "manifest.json")))
      .map((d) => JSON.parse(readFileSync(join(jobsDir, d, "manifest.json"), "utf8")) as Manifest)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  /** Atomic write (tmp + rename) so a crash never leaves a half-written manifest. */
  save(): void {
    this.manifest.updatedAt = new Date().toISOString();
    const tmp = this.path("manifest.json.tmp");
    writeFileSync(tmp, JSON.stringify(this.manifest, null, 2));
    renameSync(tmp, this.path("manifest.json"));
  }

  writeJson(rel: string, data: unknown): string {
    const p = this.path(rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(data, null, 2));
    return rel;
  }

  readJson<T>(rel: string): T {
    return JSON.parse(readFileSync(this.path(rel), "utf8")) as T;
  }

  stage(name: StageName): StageRecord {
    return this.manifest.stages[name];
  }

  /** Mark a stage and everything after it as pending (used by `resume --from`). */
  invalidateFrom(name: StageName): void {
    const idx = STAGES.indexOf(name);
    for (const s of STAGES.slice(idx)) this.manifest.stages[s] = { status: "pending", attempts: 0 };
    this.manifest.status = "running";
    this.save();
  }

  /**
   * Run a stage once: a stage already marked done is skipped and its cached data returned,
   * so an interrupted job resumes exactly where it stopped.
   */
  async runStage<T>(name: StageName, fn: () => Promise<T>, opts: { skip?: boolean } = {}): Promise<T | undefined> {
    const rec = this.manifest.stages[name];
    if (rec.status === "done") {
      this.log.info(`stage ${name}: cached`, { stage: name });
      return rec.data as T;
    }
    if (opts.skip) {
      this.manifest.stages[name] = { ...rec, status: "skipped" };
      this.save();
      return undefined;
    }
    const started = Date.now();
    this.manifest.stages[name] = { ...rec, status: "running", startedAt: new Date(started).toISOString(), attempts: rec.attempts + 1, error: undefined };
    this.save();
    this.log.info(`stage ${name}: start`, { stage: name, attempt: rec.attempts + 1 });
    try {
      const data = await fn();
      this.manifest.stages[name] = {
        ...this.manifest.stages[name],
        status: "done",
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        data,
      };
      this.save();
      this.log.info(`stage ${name}: done`, { stage: name, ms: Date.now() - started });
      return data;
    } catch (err) {
      this.manifest.stages[name] = {
        ...this.manifest.stages[name],
        status: "failed",
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        error: (err as Error)?.message ?? String(err),
      };
      this.save();
      this.log.error(`stage ${name}: failed`, { stage: name, error: (err as Error)?.message });
      throw err;
    }
  }
}
