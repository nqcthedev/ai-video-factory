import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import YAML from "yaml";
import { z } from "zod";
import { FORMATS } from "../config/schema.js";
import { formatZodError } from "../config/load.js";

const Entry = z.object({
  topic: z.string().min(3),
  format: z.enum(FORMATS).optional(),
  brief: z.string().optional(),
  publish: z.boolean().optional(),
  publishAt: z.string().datetime({ offset: true }).optional(),
});

const BatchFile = z.object({
  defaults: Entry.omit({ topic: true }).partial().default({}),
  topics: z.array(z.union([z.string().min(3), Entry])).min(1),
});

export type BatchItem = z.infer<typeof Entry> & { format: (typeof FORMATS)[number] };

/**
 * Load a batch from YAML (`topics:` list of strings or objects, optional `defaults:`) or CSV
 * (header row with at least `topic`; optional format, brief, publish, publishAt).
 */
export function parseTopics(text: string, kind: "yaml" | "csv", source = "topics"): BatchItem[] {
  let raw: unknown;
  if (kind === "csv") {
    const rows = parseCsv(text, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
    raw = {
      topics: rows.map((r) => ({
        topic: r.topic,
        ...(r.format ? { format: r.format } : {}),
        ...(r.brief ? { brief: r.brief } : {}),
        ...(r.publish ? { publish: /^(1|true|yes)$/i.test(r.publish) } : {}),
        ...(r.publishAt ? { publishAt: r.publishAt } : {}),
      })),
    };
  } else {
    raw = YAML.parse(text);
    if (Array.isArray(raw)) raw = { topics: raw };
  }
  const parsed = BatchFile.safeParse(raw);
  if (!parsed.success) throw new Error(formatZodError(parsed.error, source));
  const { defaults, topics } = parsed.data;
  return topics.map((t) => {
    const e = typeof t === "string" ? { topic: t } : t;
    return { ...defaults, ...e, format: e.format ?? defaults.format ?? "short" };
  });
}

export function loadTopicsFile(path: string): BatchItem[] {
  const ext = extname(path).toLowerCase();
  return parseTopics(readFileSync(path, "utf8"), ext === ".csv" ? "csv" : "yaml", path);
}
