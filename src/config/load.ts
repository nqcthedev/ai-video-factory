import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { type AppConfig, type AppEnv, ConfigSchema, EnvSchema } from "./schema.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const DEFAULT_CONFIG_FILES = ["avf.config.yaml", "avf.config.yml"];

/** Deep-merge plain objects (arrays are replaced, not concatenated). */
export function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function formatZodError(err: z.ZodError, source: string): string {
  return `${source} is invalid:\n` + err.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

export function parseConfig(raw: unknown, source = "config"): AppConfig {
  const r = ConfigSchema.safeParse(raw ?? {});
  if (!r.success) throw new ConfigError(formatZodError(r.error, source));
  return r.data;
}

/** Minimal .env loader (KEY=VALUE lines); real env vars always win. */
export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    const [, key, value] = m as unknown as [string, string, string];
    if (process.env[key] === undefined) process.env[key] = value.replace(/^(['"])(.*)\1$/, "$2");
  }
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
  const r = EnvSchema.safeParse(env);
  if (!r.success) throw new ConfigError(formatZodError(r.error, "environment"));
  return r.data;
}

export interface LoadedConfig {
  config: AppConfig;
  env: AppEnv;
  configPath?: string;
  modelsDir: string;
  jobsDir: string;
}

export function loadConfig(opts: { configPath?: string; overrides?: unknown; cwd?: string; env?: NodeJS.ProcessEnv } = {}): LoadedConfig {
  const cwd = opts.cwd ?? process.cwd();
  loadDotEnv(join(cwd, ".env"));
  let configPath = opts.configPath ? resolve(cwd, opts.configPath) : undefined;
  if (!configPath) configPath = DEFAULT_CONFIG_FILES.map((f) => join(cwd, f)).find((f) => existsSync(f));
  let raw: unknown = {};
  if (configPath) {
    if (!existsSync(configPath)) throw new ConfigError(`Config file not found: ${configPath}`);
    try {
      raw = YAML.parse(readFileSync(configPath, "utf8")) ?? {};
    } catch (e) {
      throw new ConfigError(`Cannot parse YAML ${configPath}: ${(e as Error).message}`);
    }
  }
  const config = parseConfig(deepMerge(raw, opts.overrides), configPath ?? "config");
  const env = loadEnv(opts.env);
  const modelsDir = resolve(cwd, env.AVF_MODELS_DIR ?? config.paths.modelsDir ?? join(homedir(), ".cache", "ai-video-factory", "models"));
  const jobsDir = resolve(cwd, env.AVF_JOBS_DIR ?? config.paths.jobsDir);
  return { config, env, configPath, modelsDir, jobsDir };
}
