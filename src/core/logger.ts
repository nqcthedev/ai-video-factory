import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const COLOR: Record<LogLevel, string> = { debug: "\x1b[90m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
  /** Also append JSON lines to this file (per-job log). */
  toFile(path: string): Logger;
}

interface Sink {
  level: LogLevel;
  json: boolean;
  files: string[];
}

/**
 * Structured logger: JSON lines (one object per event) to files and, by default, a compact
 * human-readable line on stderr. Set AVF_LOG_FORMAT=json for JSON on stderr too (CI, log shippers).
 */
export function createLogger(opts: { level?: LogLevel; json?: boolean; bindings?: Record<string, unknown> } = {}): Logger {
  const envLevel = process.env.AVF_LOG_LEVEL as LogLevel | undefined;
  const sink: Sink = {
    level: opts.level ?? (envLevel && envLevel in ORDER ? envLevel : "info"),
    json: opts.json ?? process.env.AVF_LOG_FORMAT === "json",
    files: [],
  };
  return make(sink, opts.bindings ?? {});
}

function make(sink: Sink, bindings: Record<string, unknown>, files: string[] = []): Logger {
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    const record = { time: new Date().toISOString(), level, msg, ...bindings, ...serialize(fields) };
    const line = JSON.stringify(record);
    for (const f of [...sink.files, ...files]) {
      try {
        appendFileSync(f, line + "\n");
      } catch {
        /* logging must never crash the pipeline */
      }
    }
    if (ORDER[level] < ORDER[sink.level]) return;
    if (sink.json) {
      process.stderr.write(line + "\n");
    } else {
      const ctx = Object.entries({ ...bindings, ...serialize(fields) })
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
      const tty = process.stderr.isTTY;
      const lvl = tty ? `${COLOR[level]}${level.padEnd(5)}\x1b[0m` : level.padEnd(5);
      process.stderr.write(`${record.time.slice(11, 19)} ${lvl} ${msg}${ctx ? (tty ? ` \x1b[90m${ctx}\x1b[0m` : ` ${ctx}`) : ""}\n`);
    }
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (b) => make(sink, { ...bindings, ...b }, files),
    toFile: (path) => {
      mkdirSync(dirname(path), { recursive: true });
      return make(sink, bindings, [...files, path]);
    },
  };
}

function serialize(fields?: Record<string, unknown>): Record<string, unknown> {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = v instanceof Error ? { name: v.name, message: v.message } : v;
  return out;
}

/** Silent logger for tests. */
export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => nullLogger,
  toFile: () => nullLogger,
};
