import { HttpError, ProviderError, ProviderUnavailableError } from "../core/errors.js";
import { type FetchLike, httpBuffer, httpJson } from "../core/http.js";
import { RateLimiter, sharedLimiter } from "../core/rateLimiter.js";
import { defaultIsRetryable, isQuotaExhausted, withRetry } from "../core/retry.js";
import { encodeWav, pcm16ToWav } from "../core/wav.js";
import type { AppConfig, AppEnv } from "../config/schema.js";
import { KokoroEngine } from "./kokoro/engine.js";
import { normalizeForSpeech } from "./textNormalize.js";
import type { TtsProvider, TtsResult, WordTiming } from "./types.js";

export interface HttpDeps {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  limiter?: RateLimiter;
  retries?: number;
}

/** Map an HTTP failure to a ProviderError the fallback chain understands. */
export function toProviderError(provider: string, err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof HttpError) {
    const exhausted = isQuotaExhausted(err) || err.status === 402;
    const auth = err.status === 401 || err.status === 403;
    return new ProviderError(provider, `HTTP ${err.status}: ${err.body.slice(0, 240)}`, {
      retryable: !exhausted && !auth && defaultIsRetryable(err),
      exhausted: exhausted || auth,
      cause: err,
    });
  }
  return new ProviderError(provider, (err as Error)?.message ?? String(err), { retryable: defaultIsRetryable(err), cause: err });
}

async function callWithPolicy<T>(provider: string, deps: HttpDeps, fn: () => Promise<T>): Promise<T> {
  try {
    return await withRetry(() => (deps.limiter ? deps.limiter.schedule(fn) : fn()), {
      retries: deps.retries ?? 3,
      baseDelayMs: 2000,
      maxDelayMs: 60_000,
      sleep: deps.sleep,
    });
  } catch (err) {
    throw toProviderError(provider, err);
  }
}

// ───────────────────────────── Kokoro (local) ─────────────────────────────

const engines = new Map<string, KokoroEngine>();
/** One engine (≈350 MB of weights) per model dir, shared by every job in the process. */
function sharedEngine(dir: string): KokoroEngine {
  let e = engines.get(dir);
  if (!e) {
    e = new KokoroEngine(dir);
    engines.set(dir, e);
  }
  return e;
}

export class KokoroTts implements TtsProvider {
  readonly name = "kokoro";
  constructor(
    private readonly modelsDir: string,
    private readonly cfg: AppConfig["tts"]["kokoro"],
    private readonly speechRate = 1,
  ) {}

  get dir() {
    return `${this.modelsDir}/kokoro`;
  }

  async available() {
    return KokoroEngine.filesPresent(this.dir)
      ? { ok: true }
      : { ok: false, reason: `model files missing in ${this.dir} — run \`avf models download\`` };
  }

  async synthesize(text: string): Promise<TtsResult> {
    const a = await this.available();
    if (!a.ok) throw new ProviderUnavailableError(this.name, a.reason!);
    const r = await sharedEngine(this.dir).synthesize(text, {
      voice: this.cfg.voice,
      speed: clampSpeed(this.cfg.speed * this.speechRate, 0.5, 2),
      lang: this.cfg.lang,
      sentencePauseSec: this.cfg.sentencePauseSec,
    });
    return {
      wav: encodeWav({ sampleRate: r.sampleRate, channels: 1, samples: r.samples }),
      words: r.words,
      characters: text.length,
      voice: `kokoro:${this.cfg.voice}`,
    };
  }
}

// ───────────────────────────── Gemini native TTS ─────────────────────────────

interface GeminiTtsResponse {
  candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }>;
}

/**
 * Gemini native speech generation (REST generateContent with responseModalities AUDIO).
 * Docs: https://ai.google.dev/gemini-api/docs/speech-generation — returns base64 s16le PCM @ 24 kHz.
 * No word timings → captions use the alignment estimator.
 */
export class GeminiTts implements TtsProvider {
  readonly name = "gemini";
  constructor(
    private readonly env: Pick<AppEnv, "GEMINI_API_KEY" | "GEMINI_NATIVE_BASE_URL">,
    private readonly cfg: AppConfig["tts"]["gemini"],
    private readonly deps: HttpDeps = {},
  ) {}

  async available() {
    return this.env.GEMINI_API_KEY ? { ok: true } : { ok: false, reason: "GEMINI_API_KEY not set" };
  }

  async synthesize(text: string): Promise<TtsResult> {
    if (!this.env.GEMINI_API_KEY) throw new ProviderUnavailableError(this.name, "GEMINI_API_KEY not set");
    const url = new URL(`models/${this.cfg.model}:generateContent`, this.env.GEMINI_NATIVE_BASE_URL).toString();
    const spoken = normalizeForSpeech(text);
    const res = await callWithPolicy(this.name, { limiter: sharedLimiter("gemini-tts", { maxPerMinute: 3 }), ...this.deps }, () =>
      httpJson<GeminiTtsResponse>(url, {
        method: "POST",
        fetch: this.deps.fetch,
        headers: { "x-goog-api-key": this.env.GEMINI_API_KEY! },
        body: {
          contents: [{ parts: [{ text: this.cfg.style ? `${this.cfg.style} ${spoken}` : spoken }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.cfg.voice } } },
          },
        },
      }),
    );
    const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part?.inlineData?.data) throw new ProviderError(this.name, "response contained no audio", { retryable: true });
    const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? "")?.[1] ?? 24000);
    return { wav: pcm16ToWav(Buffer.from(part.inlineData.data, "base64"), rate), characters: text.length, voice: `gemini:${this.cfg.voice}` };
  }
}

// ───────────────────────────── OpenAI TTS ─────────────────────────────

/** OpenAI /v1/audio/speech (gpt-4o-mini-tts / tts-1). Returns WAV directly. No word timings. */
export class OpenAiTts implements TtsProvider {
  readonly name = "openai";
  constructor(
    private readonly env: Pick<AppEnv, "OPENAI_API_KEY" | "OPENAI_BASE_URL">,
    private readonly cfg: AppConfig["tts"]["openai"],
    private readonly deps: HttpDeps = {},
    private readonly speechRate = 1,
  ) {}

  async available() {
    return this.env.OPENAI_API_KEY ? { ok: true } : { ok: false, reason: "OPENAI_API_KEY not set" };
  }

  async synthesize(text: string): Promise<TtsResult> {
    if (!this.env.OPENAI_API_KEY) throw new ProviderUnavailableError(this.name, "OPENAI_API_KEY not set");
    const url = new URL("audio/speech", this.env.OPENAI_BASE_URL).toString();
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      voice: this.cfg.voice,
      input: normalizeForSpeech(text),
      response_format: "wav",
      speed: clampSpeed(this.cfg.speed * this.speechRate, 0.25, 4),
    };
    // `instructions` is only supported by the gpt-4o*-tts family.
    if (this.cfg.model.includes("gpt-4o")) body.instructions = this.cfg.instructions;
    const res = await callWithPolicy(this.name, { limiter: sharedLimiter("openai-tts", { maxPerMinute: 50 }), ...this.deps }, () =>
      httpBuffer(url, { method: "POST", fetch: this.deps.fetch, headers: { authorization: `Bearer ${this.env.OPENAI_API_KEY}` }, body }),
    );
    return { wav: res.data, characters: text.length, voice: `openai:${this.cfg.voice}` };
  }
}

// ───────────────────────────── ElevenLabs ─────────────────────────────

interface ElevenAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/**
 * ElevenLabs /v1/text-to-speech/{voice_id}/with-timestamps — returns audio + per-character
 * alignment, which we fold into word timings (no estimation needed).
 * Docs: https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps
 */
export class ElevenLabsTts implements TtsProvider {
  readonly name = "elevenlabs";
  constructor(
    private readonly env: Pick<AppEnv, "ELEVENLABS_API_KEY">,
    private readonly cfg: AppConfig["tts"]["elevenlabs"],
    private readonly deps: HttpDeps & { baseUrl?: string } = {},
  ) {}

  async available() {
    return this.env.ELEVENLABS_API_KEY ? { ok: true } : { ok: false, reason: "ELEVENLABS_API_KEY not set" };
  }

  async synthesize(text: string): Promise<TtsResult> {
    if (!this.env.ELEVENLABS_API_KEY) throw new ProviderUnavailableError(this.name, "ELEVENLABS_API_KEY not set");
    const base = this.deps.baseUrl ?? "https://api.elevenlabs.io/";
    const url = new URL(`v1/text-to-speech/${encodeURIComponent(this.cfg.voiceId)}/with-timestamps?output_format=pcm_24000`, base).toString();
    const res = await callWithPolicy(this.name, { limiter: sharedLimiter("elevenlabs", { maxPerMinute: 30 }), ...this.deps }, () =>
      httpJson<{ audio_base64: string; alignment?: ElevenAlignment; normalized_alignment?: ElevenAlignment }>(url, {
        method: "POST",
        fetch: this.deps.fetch,
        headers: { "xi-api-key": this.env.ELEVENLABS_API_KEY! },
        body: {
          text,
          model_id: this.cfg.modelId,
          voice_settings: { stability: this.cfg.stability, similarity_boost: this.cfg.similarityBoost },
        },
      }),
    );
    if (!res.audio_base64) throw new ProviderError(this.name, "response contained no audio", { retryable: true });
    const alignment = res.alignment ?? res.normalized_alignment;
    return {
      wav: pcm16ToWav(Buffer.from(res.audio_base64, "base64"), 24000),
      words: alignment ? charAlignmentToWords(alignment) : undefined,
      characters: text.length,
      voice: `elevenlabs:${this.cfg.voiceId}`,
    };
  }
}

/** Fold per-character timings into words (whitespace-separated, punctuation stripped). */
export function charAlignmentToWords(a: ElevenAlignment): WordTiming[] {
  const words: WordTiming[] = [];
  let cur: { text: string; start: number; end: number } | undefined;
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (cur) words.push(cur);
      cur = undefined;
      return;
    }
    const s = a.character_start_times_seconds[i] ?? 0;
    const e = a.character_end_times_seconds[i] ?? s;
    if (!cur) cur = { text: ch, start: s, end: e };
    else {
      cur.text += ch;
      cur.end = e;
    }
  });
  if (cur) words.push(cur);
  return words
    .map((w) => ({ ...w, text: w.text.replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%]+$/gu, "") }))
    .filter((w) => w.text.length > 0);
}

function clampSpeed(v: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, v)) * 100) / 100;
}

/** Build the TTS fallback chain. `speechRate` is the format's pacing multiplier (Shorts ≈ 1.12). */
export function createTtsProviders(cfg: AppConfig, env: AppEnv, modelsDir: string, deps: HttpDeps = {}, speechRate = 1): TtsProvider[] {
  return cfg.tts.order.map((name) => {
    switch (name) {
      case "kokoro":
        return new KokoroTts(modelsDir, cfg.tts.kokoro, speechRate);
      case "gemini":
        return new GeminiTts(env, cfg.tts.gemini, deps);
      case "openai":
        return new OpenAiTts(env, cfg.tts.openai, deps, speechRate);
      case "elevenlabs":
        return new ElevenLabsTts(env, cfg.tts.elevenlabs, deps);
    }
  });
}
