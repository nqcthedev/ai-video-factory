import { z } from "zod";

export const TTS_PROVIDERS = ["kokoro", "gemini", "openai", "elevenlabs"] as const;
export const VISUAL_PROVIDERS = ["gemini-image", "pexels", "designed"] as const;
export const THEMES = ["midnight", "ocean", "sunset", "forest", "ember", "mono"] as const;
export const FORMATS = ["short", "long"] as const;
export const TRANSITIONS = [
  "fade", "fadeblack", "smoothleft", "smoothright", "smoothup", "smoothdown", "slideleft", "slideup",
  "circleopen", "wipeleft", "dissolve", "zoomin", "slideright", "slidedown",
] as const;

export type TtsProviderName = (typeof TTS_PROVIDERS)[number];
export type VisualProviderName = (typeof VISUAL_PROVIDERS)[number];
export type ThemeName = (typeof THEMES)[number];
export type FormatName = (typeof FORMATS)[number];

const Channel = z.object({
  name: z.string().min(1).default("Curious Minutes"),
  niche: z.string().default("evergreen science, psychology and self-improvement explainers"),
  tone: z.string().default("warm, curious and punchy; concrete facts over hype; no clickbait claims"),
  audience: z.string().default("general audience, 16-45, watching on a phone"),
  language: z.string().default("English"),
  callToAction: z.string().default("Follow for one new idea every day."),
  /** "auto" lets the script stage pick a theme that fits the topic. */
  theme: z.union([z.enum(THEMES), z.literal("auto")]).default("auto"),
  /** Extra rules appended to the script prompt (banned words, recurring segments, etc.). */
  extraInstructions: z.string().default(""),
});

const Llm = z.object({
  provider: z.enum(["gemini", "openai"]).default("gemini"),
  model: z.string().default("gemini-2.5-flash"),
  /** Tried in order when the primary model is out of quota / unavailable (same provider + key). */
  fallbackModels: z.array(z.string()).default(["gemini-3-flash-preview", "gemini-3.5-flash-lite"]),
  /** OpenAI-compatible base URL. Gemini: https://generativelanguage.googleapis.com/v1beta/openai/ */
  baseUrl: z.string().url().optional(),
  temperature: z.number().min(0).max(2).default(0.8),
  /** Attempts to get schema-valid JSON before giving up. */
  maxAttempts: z.number().int().min(1).max(6).default(4),
  requestsPerMinute: z.number().int().positive().default(8),
  timeoutMs: z.number().int().positive().default(120_000),
  /** Sent as `reasoning_effort` (Gemini 2.5 / OpenAI reasoning models). "none" disables thinking tokens. */
  reasoningEffort: z.enum(["none", "low", "medium", "high"]).optional().default("low"),
});

const Tts = z.object({
  /** Tried in order; the whole video uses ONE voice — on failure the next provider re-voices every scene. */
  order: z.array(z.enum(TTS_PROVIDERS)).min(1).default(["kokoro", "gemini", "openai", "elevenlabs"]),
  /** Silence inserted between scenes (seconds). */
  sceneGapSec: z.number().min(0).max(2).default(0.28),
  kokoro: z
    .object({
      voice: z.string().default("af_heart"),
      speed: z.number().min(0.5).max(2).default(1.0),
      /** "en-us" or "en-gb" (espeak-ng language used for phonemes). */
      lang: z.enum(["en-us", "en-gb"]).default("en-us"),
      /** Pause after sentence-ending punctuation (seconds) inside a scene. */
      sentencePauseSec: z.number().min(0).max(1.5).default(0.12),
    })
    .prefault({}),
  gemini: z
    .object({
      model: z.string().default("gemini-2.5-flash-preview-tts"),
      voice: z.string().default("Kore"),
      /** Natural-language delivery hint prepended to the text. */
      style: z.string().default("Say in a warm, upbeat, clear explainer voice:"),
    })
    .prefault({}),
  openai: z
    .object({
      model: z.string().default("gpt-4o-mini-tts"),
      voice: z.string().default("coral"),
      instructions: z.string().default("Warm, upbeat, clear explainer voice. Natural pacing."),
      speed: z.number().min(0.25).max(4).default(1.0),
    })
    .prefault({}),
  elevenlabs: z
    .object({
      voiceId: z.string().default("21m00Tcm4TlvDq8ikWAM"),
      modelId: z.string().default("eleven_multilingual_v2"),
      stability: z.number().min(0).max(1).default(0.45),
      similarityBoost: z.number().min(0).max(1).default(0.8),
    })
    .prefault({}),
});

const Visuals = z.object({
  /** Tried per scene in order. "designed" (local HTML → PNG) never needs a network and always works. */
  order: z.array(z.enum(VISUAL_PROVIDERS)).min(1).default(["designed"]),
  geminiImage: z
    .object({
      model: z.string().default("gemini-2.5-flash-image"),
      style: z.string().default("cinematic, photorealistic, soft natural light, rich color, shallow depth of field, no text, no watermark"),
    })
    .prefault({}),
  pexels: z.object({ perPage: z.number().int().min(1).max(30).default(8) }).prefault({}),
  concurrency: z.number().int().min(1).max(8).default(3),
});

const Captions = z.object({
  enabled: z.boolean().default(true),
  font: z.string().default("Inter Display Black"),
  /** Highlight colour for the word being spoken (#RRGGBB). Defaults to the theme accent. */
  highlightColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#FFFFFF"),
  uppercase: z.boolean().default(true),
  /** Override words per caption chunk (default: 3 for shorts, 6 for long). */
  maxWordsPerChunk: z.number().int().min(1).max(10).optional(),
});

const Music = z.object({
  enabled: z.boolean().default(true),
  /** Path to your own licensed track/folder. Without it a royalty-free ambient pad is synthesized locally. */
  path: z.string().optional(),
  /** Music bed level relative to full scale before ducking (dB). */
  volumeDb: z.number().min(-60).max(0).default(-17),
  /** Sidechain-duck the music under the voice. */
  duck: z.boolean().default(true),
});

const Render = z.object({
  fps: z.number().int().min(24).max(60).default(30),
  crf: z.number().int().min(14).max(32).default(20),
  preset: z.enum(["ultrafast", "veryfast", "faster", "fast", "medium", "slow"]).default("medium"),
  transition: z
    .object({
      duration: z.number().min(0).max(1.5).default(0.4),
      types: z.array(z.enum(TRANSITIONS)).min(1).default(["slideleft", "slideup"]),
    })
    .prefault({}),
  /** Ken Burns: final zoom factor for background layers (1.0 = static). */
  kenBurnsZoom: z.number().min(1).max(1.4).default(1.08),
  captions: Captions.prefault({}),
  music: Music.prefault({}),
  loudness: z
    .object({
      integratedLufs: z.number().min(-30).max(-8).default(-14),
      truePeakDb: z.number().min(-9).max(0).default(-1.5),
      lra: z.number().min(1).max(20).default(11),
    })
    .prefault({}),
  /** Also export the other aspect ratio from the same job (e.g. a 16:9 cut of a short). */
  thumbnail: z.boolean().default(true),
});

const Publish = z.object({
  youtube: z
    .object({
      enabled: z.boolean().default(false),
      privacyStatus: z.enum(["private", "unlisted", "public"]).default("private"),
      /** ISO 8601 time; YouTube requires privacyStatus=private for scheduled publishing. */
      publishAt: z.string().datetime({ offset: true }).optional(),
      categoryId: z.string().default("27"),
      madeForKids: z.boolean().default(false),
      /** Altered/synthetic content disclosure (status.containsSyntheticMedia). AI voice ⇒ true. */
      containsSyntheticMedia: z.boolean().default(true),
      defaultLanguage: z.string().default("en"),
    })
    .prefault({}),
});

/** USD prices used for the per-video cost estimate. Verify against current provider pricing. */
const Costs = z.object({
  llm: z
    .record(z.string(), z.object({ inputPerMTok: z.number().min(0), outputPerMTok: z.number().min(0) }))
    .default({
      "gemini-2.5-flash": { inputPerMTok: 0.3, outputPerMTok: 2.5 },
      "gemini-2.5-flash-lite": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
      "gemini-3-flash-preview": { inputPerMTok: 0.5, outputPerMTok: 3.0 },
      "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6 },
    }),
  tts: z
    .object({
      kokoro: z.number().min(0).default(0),
      /** Per 1M input characters (approximation for token/audio-second based pricing). */
      geminiPerMChars: z.number().min(0).default(20),
      openaiPerMChars: z.number().min(0).default(15),
      elevenlabsPerMChars: z.number().min(0).default(180),
    })
    .prefault({}),
  images: z
    .object({
      geminiPerImage: z.number().min(0).default(0.039),
      pexelsPerImage: z.number().min(0).default(0),
      designedPerImage: z.number().min(0).default(0),
    })
    .prefault({}),
});

export const ConfigSchema = z.object({
  channel: Channel.prefault({}),
  llm: Llm.prefault({}),
  tts: Tts.prefault({}),
  visuals: Visuals.prefault({}),
  render: Render.prefault({}),
  publish: Publish.prefault({}),
  batch: z.object({ concurrency: z.number().int().min(1).max(8).default(2) }).prefault({}),
  costs: Costs.prefault({}),
  paths: z
    .object({
      jobsDir: z.string().default("jobs"),
      /** Where Kokoro model files live. Default: ~/.cache/ai-video-factory/models */
      modelsDir: z.string().optional(),
    })
    .prefault({}),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/** Secrets and endpoints come only from the environment, never from YAML. */
export const EnvSchema = z.object({
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_BASE_URL: z.string().url().default("https://generativelanguage.googleapis.com/v1beta/openai/"),
  GEMINI_NATIVE_BASE_URL: z.string().url().default("https://generativelanguage.googleapis.com/v1beta/"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1/"),
  ELEVENLABS_API_KEY: z.string().optional(),
  PEXELS_API_KEY: z.string().optional(),
  YOUTUBE_CLIENT_ID: z.string().optional(),
  YOUTUBE_CLIENT_SECRET: z.string().optional(),
  YOUTUBE_REFRESH_TOKEN: z.string().optional(),
  AVF_MODELS_DIR: z.string().optional(),
  AVF_JOBS_DIR: z.string().optional(),
});
export type AppEnv = z.infer<typeof EnvSchema>;
