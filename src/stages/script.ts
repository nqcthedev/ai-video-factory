import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { z } from "zod";
import { THEMES, type AppConfig } from "../config/schema.js";
import type { Logger } from "../core/logger.js";
import { nullLogger } from "../core/logger.js";
import type { FormatSpec } from "../formats.js";
import type { ChatMessage, LlmClient } from "../llm/client.js";
import { splitDisplayWords } from "../tts/textNormalize.js";

export const LAYOUTS = ["hero", "stat", "list", "quote"] as const;

const require = createRequire(import.meta.url);
let iconNames: Set<string> | undefined;
/** Lucide icon names available locally (lucide-static, ISC licence). */
export function availableIcons(): Set<string> {
  if (!iconNames) {
    const dir = join(dirname(require.resolve("lucide-static/package.json")), "icons");
    iconNames = new Set(existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".svg")).map((f) => f.slice(0, -4)) : []);
  }
  return iconNames;
}

export const SUGGESTED_ICONS = [
  "brain", "brain-circuit", "eye", "hand", "fingerprint", "dna", "microscope", "atom", "flask-conical", "telescope",
  "fish", "shell", "waves", "anchor", "leaf", "sprout", "tree-pine", "mountain", "earth", "globe", "sun", "moon",
  "snowflake", "droplets", "flame", "zap", "lightbulb", "sparkles", "star", "target", "rocket", "trophy",
  "circle-check", "list-checks", "timer", "hourglass", "alarm-clock", "clock", "calendar", "coffee", "bed",
  "heart", "heart-pulse", "activity", "dumbbell", "footprints", "apple", "glass-water", "smile", "frown",
  "users", "user", "message-circle", "megaphone", "bell", "trending-up", "trending-down", "chart-line",
  "chart-column", "percent", "dollar-sign", "coins", "piggy-bank", "wallet", "cpu", "bot", "smartphone", "laptop",
  "book-open", "graduation-cap", "notebook-pen", "pencil", "puzzle", "layers", "shield-check", "lock", "key",
  "compass", "map", "orbit", "infinity", "gauge", "scale", "repeat", "rotate-ccw", "play", "pause",
  "triangle-alert", "circle-help", "quote", "music", "headphones", "camera", "palette", "rabbit", "turtle", "bird",
];

const Visual = z.object({
  description: z.string().min(10).max(500),
  searchQuery: z.string().min(2).max(80),
  icon: z.string().min(1).max(40),
  layout: z.enum(LAYOUTS),
  /** Only for layout "list": 2–3 very short items. */
  points: z.array(z.string().min(1).max(32)).max(3).optional(),
});

/** Models sometimes put `points`/`layout`/`icon` next to `visual` instead of inside it — accept both. */
function hoistVisualFields(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const scene = { ...(raw as Record<string, unknown>) };
  const visual = { ...((scene.visual as Record<string, unknown>) ?? {}) };
  for (const k of ["points", "layout", "icon", "description", "searchQuery"]) {
    if (scene[k] !== undefined && visual[k] === undefined) visual[k] = scene[k];
    delete scene[k];
  }
  return { ...scene, visual };
}

export const SceneSchema = z.preprocess(
  hoistVisualFields,
  z.object({
    narration: z.string().min(8).max(420),
    keyword: z.string().min(1).max(26),
    subtitle: z.string().max(64).optional().default(""),
    visual: Visual,
  }),
);

export const ScriptSchema = z.object({
  title: z.string().min(8).max(100),
  description: z.string().min(40).max(4500),
  tags: z.array(z.string().min(1).max(40)).min(5).max(20),
  thumbnailText: z.string().min(2).max(36),
  theme: z.enum(THEMES),
  hook: SceneSchema,
  scenes: z.array(SceneSchema).min(3).max(14),
});

export type Scene = z.output<typeof SceneSchema>;
export type Script = z.output<typeof ScriptSchema>;

/** Hook first, then the body scenes — the order everything downstream uses. */
export function allScenes(s: Script): Scene[] {
  return [s.hook, ...s.scenes];
}

export function countWords(text: string): number {
  return splitDisplayWords(text).length;
}

const EMOJI = /\p{Extended_Pictographic}/u;

/** Checks the schema can't express: word budget, scene count, YouTube limits, on-screen text sizes. */
export function validateScript(script: Script, format: FormatSpec, callToAction?: string): string[] {
  const problems: string[] = [];
  const scenes = allScenes(script);
  if (callToAction) {
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    const cta = norm(callToAction);
    const at = scenes.findIndex((s) => norm(s.narration).includes(cta));
    if (at !== scenes.length - 1)
      problems.push(at < 0 ? `The last scene must end with the call to action: "${callToAction}".` : `The call to action must be in the LAST scene only (found in scene ${at}). Move it to the end.`);
  }
  const words = scenes.reduce((a, s) => a + countWords(s.narration), 0);
  const [minW, maxW] = format.words;
  const perScene = scenes.map((s, i) => `${i === 0 ? "hook" : `scenes[${i - 1}]`}=${countWords(s.narration)}`).join(", ");
  if (words < Math.floor(minW * 0.95))
    problems.push(`Narration is too short: ${words} words in total, need ${minW}-${maxW}. Add about ${minW - words + 5} words of substance (a concrete example), not filler. Per scene now: ${perScene}.`);
  if (words > Math.ceil(maxW * 1.05))
    problems.push(`Narration is too long: ${words} words in total, need ${minW}-${maxW}. Remove about ${words - maxW + 5} words: shorten every scene to ${Math.floor(maxW / scenes.length)} words or fewer, or drop the weakest scene. Per scene now: ${perScene}.`);
  const [minS, maxS] = format.scenes;
  if (scenes.length < minS || scenes.length > maxS) problems.push(`Use ${minS}-${maxS} scenes in total (hook + scenes); got ${scenes.length}.`);
  if (script.title.length > 70) problems.push(`Title must be at most 70 characters (got ${script.title.length}).`);
  const layouts = new Set(scenes.map((s) => s.visual.layout));
  if (layouts.size < 3) problems.push(`Use at least 3 different visual.layout values across scenes (got only: ${[...layouts].join(", ")}).`);
  const tagChars = script.tags.join(",").length;
  if (tagChars > 480) problems.push(`Tags total ${tagChars} characters; YouTube allows 500. Use fewer/shorter tags.`);
  scenes.forEach((s, i) => {
    const label = i === 0 ? "hook" : `scenes[${i - 1}]`;
    if (s.keyword.trim().split(/\s+/).length > 3) problems.push(`${label}.keyword "${s.keyword}" must be 1-3 words.`);
    if (EMOJI.test(s.narration) || EMOJI.test(s.keyword)) problems.push(`${label}: no emojis in narration or keyword.`);
    if (/[#*_<>\[\]{}]/.test(s.narration)) problems.push(`${label}.narration must be plain spoken text (no markdown, hashtags or brackets).`);
    if (s.visual.layout === "list" && (!s.visual.points || s.visual.points.length < 2)) problems.push(`${label}: layout "list" needs 2-3 visual.points.`);
    if (s.visual.layout === "stat" && !/\d/.test(s.keyword)) problems.push(`${label}: layout "stat" needs a number in keyword (e.g. "500M", "2/3", "90%"), otherwise use "hero".`);
    if (countWords(s.narration) > 60) problems.push(`${label}.narration is ${countWords(s.narration)} words; keep scenes under 60 words.`);
  });
  return problems;
}

/** Cosmetic clean-up that never needs another LLM round-trip. */
export function normalizeScript(script: Script): Script {
  const icons = availableIcons();
  const fix = (s: Scene): Scene => ({
    ...s,
    narration: s.narration.replace(/\s+/g, " ").trim(),
    keyword: s.keyword.replace(/\s+/g, " ").trim(),
    subtitle: (s.subtitle ?? "").trim(),
    visual: { ...s.visual, icon: icons.size === 0 || icons.has(s.visual.icon) ? s.visual.icon : "sparkles" },
  });
  return {
    ...script,
    title: script.title.trim(),
    tags: [...new Set(script.tags.map((t) => t.replace(/^#/, "").trim()).filter(Boolean))],
    hook: fix(script.hook),
    scenes: script.scenes.map(fix),
  };
}

export function buildPrompt(topic: string, format: FormatSpec, channel: AppConfig["channel"], brief?: string): ChatMessage[] {
  const seconds = `${format.targetSec[0]}-${format.targetSec[1]} seconds`;
  const isShort = format.name === "short";
  const system = [
    `You are the head writer of the faceless YouTube channel "${channel.name}" (${channel.niche}).`,
    `Tone: ${channel.tone}. Audience: ${channel.audience}. Language: ${channel.language}.`,
    "You write tight, factual, highly watchable narration scripts for AI voice-over. You only state well-established facts;",
    "when a number is uncertain you round it and say 'about' or 'roughly'. Never invent studies, quotes, percentages or statistics:",
    "only use numbers from the producer's brief or textbook-level facts. A 'stat' scene may use a duration, count or size instead of a percentage.",
    "Respond with ONE JSON object only, no markdown fences, no commentary.",
  ].join(" ");
  const user = `Write a ${isShort ? "vertical Short (9:16)" : "horizontal YouTube video (16:9)"} about: "${topic}".
${brief ? `Brief from the producer: ${brief}\n` : ""}
LENGTH: ${format.words[0]}-${format.words[1]} spoken words in total (about ${seconds}) — this is a hard limit, count them. ${format.scenes[0]}-${format.scenes[1]} scenes in total, counting the hook, so roughly ${Math.round(format.words[1] / format.scenes[1])}-${Math.round(format.words[1] / format.scenes[0])} words per scene.

STRUCTURE
- "hook": the first 2-3 seconds. One or two short sentences that create curiosity with a concrete, surprising fact or a direct question. Never start with "In this video", "Did you know" or "Have you ever".
- "scenes": each scene is ONE idea, 1-3 sentences. Build up: explain the why, give a vivid concrete example (a real experiment, a real-life situation, a number the viewer can picture), then a payoff. Each scene should make the viewer want the next one (open loops, "but here's the twist").
- Talk to the viewer ("you"), keep it conversational and specific. No generic filler like "truly remarkable", "fascinating world", "in conclusion".
- The last scene wraps up with a memorable takeaway and ends with this call to action, said naturally: "${channel.callToAction}"
- Write for the ear: short sentences, contractions, no lists read aloud, no parentheses, no emojis, no hashtags in narration. Numbers as digits (e.g. 500 million, 3).

ON-SCREEN TEXT (per scene)
- "keyword": the big text on screen, 1-3 words, max 18 characters, punchy (e.g. "9 BRAINS", "BLUE BLOOD", "JUST 5 MINUTES").
- "subtitle": a supporting line of max 7 words that adds information, not a repeat of the keyword.
- "visual.layout": "stat" when the keyword is a number (keyword must contain the number, e.g. "500M", "2/3", "90%"), "list" for 2-3 parallel items (then "visual.points" MUST contain the 2-3 items, each max 24 characters, and the narration must actually say every item — never announce "three steps" without naming them), "quote" for a punchline or takeaway, otherwise "hero". Use at least 3 different layouts across the video, including at least one "stat" and one "list".
- "visual.icon": one Lucide icon name that fits, preferably from: ${SUGGESTED_ICONS.join(", ")}.
- "visual.description": a concrete photographic shot for an AI image model (subject, setting, lighting, camera), no text in the image.
- "visual.searchQuery": 2-4 words for a stock photo search.

METADATA
- "title": max 60 characters, curiosity-driven but honest${isShort ? "" : ", no clickbait"}.
- "description": 2-3 sentences summarizing the video, then a blank line and 3-5 relevant hashtags${isShort ? " including #shorts" : ""}.
- "tags": 8-15 search tags, lowercase.
- "thumbnailText": 2-4 words for the thumbnail, max 24 characters.
- "theme": the colour theme that fits the topic, one of: ${THEMES.join(", ")} (ocean = sea/water/nature-blue, forest = nature/health, sunset = warm/motivation, ember = energy/urgency, midnight = space/mind/tech, mono = serious/minimal).

JSON SHAPE
{"title": "...", "description": "...", "tags": ["..."], "thumbnailText": "...", "theme": "ocean",
 "hook": {"narration": "...", "keyword": "...", "subtitle": "...", "visual": {"layout": "hero", "icon": "...", "description": "...", "searchQuery": "..."}},
 "scenes": [{"narration": "...", "keyword": "...", "subtitle": "...", "visual": {"layout": "list", "points": ["...", "..."], "icon": "...", "description": "...", "searchQuery": "..."}}]}
${channel.extraInstructions ? `\nEXTRA RULES\n${channel.extraInstructions}\n` : ""}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Pull the first JSON object out of a completion (tolerates ```json fences and stray prose). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new SyntaxError("no JSON object found in completion");
  return JSON.parse(candidate.slice(start, end + 1));
}

export interface ScriptResult {
  script: Script;
  attempts: number;
  usage: { promptTokens: number; completionTokens: number };
  model: string;
  warnings: string[];
}

/**
 * Ask the LLM for a script, validate it with zod + editorial rules, and on failure retry with
 * the exact problems fed back to the model. After the last attempt, a script that only misses
 * soft rules (length/limits) is accepted with warnings; schema-invalid output never is.
 */
export async function generateScript(
  llm: LlmClient,
  args: {
    topic: string;
    format: FormatSpec;
    channel: AppConfig["channel"];
    brief?: string;
    maxAttempts: number;
    logger?: Logger;
    /** Called with every raw completion (the pipeline keeps them in the job dir for debugging). */
    onCompletion?: (attempt: number, text: string) => void;
  },
): Promise<ScriptResult> {
  const log = args.logger ?? nullLogger;
  const messages = buildPrompt(args.topic, args.format, args.channel, args.brief);
  const usage = { promptTokens: 0, completionTokens: 0 };
  let best: { script: Script; problems: string[] } | undefined;
  let model = llm.model;
  for (let attempt = 1; attempt <= args.maxAttempts; attempt++) {
    const res = await llm.chat(messages, { json: true });
    args.onCompletion?.(attempt, res.text);
    model = res.model;
    usage.promptTokens += res.usage.promptTokens;
    usage.completionTokens += res.usage.completionTokens;
    let feedback: string;
    try {
      const parsed = ScriptSchema.safeParse(extractJson(res.text));
      if (!parsed.success) {
        feedback = "The JSON does not match the required shape:\n" + parsed.error.issues.slice(0, 12).map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n");
      } else {
        const script = normalizeScript(parsed.data);
        const problems = validateScript(script, args.format, args.channel.callToAction);
        if (!problems.length) return { script, attempts: attempt, usage, model, warnings: [] };
        if (!best || problems.length < best.problems.length) best = { script, problems };
        feedback = "Please fix these problems:\n" + problems.map((p) => `- ${p}`).join("\n");
      }
    } catch (e) {
      feedback = `Your reply was not valid JSON (${(e as Error).message}). Reply with one JSON object only.`;
    }
    log.warn("script rejected, asking for a revision", { attempt, feedback: feedback.slice(0, 400) });
    messages.push({ role: "assistant", content: res.text.slice(0, 12_000) }, { role: "user", content: `${feedback}\nReturn the complete corrected JSON object.` });
  }
  if (best) {
    log.warn("accepting best script with soft warnings", { problems: best.problems });
    return { script: best.script, attempts: args.maxAttempts, usage, model, warnings: best.problems };
  }
  throw new Error(`LLM did not return a valid script after ${args.maxAttempts} attempts`);
}
