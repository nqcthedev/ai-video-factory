import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema, EnvSchema } from "../src/config/schema.js";
import { ProviderError } from "../src/core/errors.js";
import { Job } from "../src/core/job.js";
import { nullLogger } from "../src/core/logger.js";
import { encodeWav } from "../src/core/wav.js";
import { runVoiceStage } from "../src/stages/voice.js";
import { charAlignmentToWords, ElevenLabsTts, GeminiTts, OpenAiTts, toProviderError } from "../src/tts/providers.js";
import type { TtsProvider } from "../src/tts/types.js";
import { GeminiImageVisuals, PexelsVisuals } from "../src/visuals/providers.js";
import { HttpError } from "../src/core/errors.js";
import { json, mockFetch, noSleep, sampleScript } from "./helpers.js";

const cfg = ConfigSchema.parse({});
const env = EnvSchema.parse({ GEMINI_API_KEY: "g", OPENAI_API_KEY: "o", ELEVENLABS_API_KEY: "e", PEXELS_API_KEY: "p" });

function tone(seconds: number, rate = 24000): Buffer {
  const s = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < s.length; i++) s[i] = 0.3 * Math.sin((2 * Math.PI * 200 * i) / rate);
  return encodeWav({ sampleRate: rate, channels: 1, samples: s });
}

describe("TTS providers (mocked HTTP)", () => {
  it("Gemini: sends x-goog-api-key + AUDIO modality and wraps PCM into WAV", async () => {
    const pcm = Buffer.alloc(4800 * 2); // 0.2 s of s16le @ 24 kHz
    const f = mockFetch([{ match: (u) => u.includes(":generateContent"), respond: () => json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcm.toString("base64") } }] } }] }) }]);
    const r = await new GeminiTts(env, cfg.tts.gemini, { fetch: f, sleep: noSleep }).synthesize("Hello world");
    expect(r.wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(r.wav.readUInt32LE(24)).toBe(24000);
    const call = f.calls[0]!;
    expect(call.url).toContain("models/gemini-2.5-flash-preview-tts:generateContent");
    expect(new Headers(call.init!.headers).get("x-goog-api-key")).toBe("g");
    const body = JSON.parse(String(call.init!.body));
    expect(body.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Kore");
  });

  it("OpenAI: retries a transient 500, then succeeds", async () => {
    let n = 0;
    const f = mockFetch([{ match: (u) => u.endsWith("/audio/speech"), respond: () => (++n === 1 ? new Response("oops", { status: 500 }) : new Response(new Uint8Array(tone(0.2)))) }]);
    const r = await new OpenAiTts(env, cfg.tts.openai, { fetch: f, sleep: noSleep }).synthesize("Hi");
    expect(n).toBe(2);
    expect(r.voice).toBe("openai:coral");
    const body = JSON.parse(String(f.calls[0]!.init!.body));
    expect(body).toMatchObject({ model: "gpt-4o-mini-tts", voice: "coral", response_format: "wav" });
  });

  it("OpenAI: a 429 with insufficient_quota is 'exhausted' and not retried", async () => {
    const f = mockFetch([{ match: () => true, respond: () => json({ error: { code: "insufficient_quota" } }, 429) }]);
    const err = await new OpenAiTts(env, cfg.tts.openai, { fetch: f, sleep: noSleep }).synthesize("Hi").catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.exhausted).toBe(true);
    expect(f.calls).toHaveLength(1);
  });

  it("ElevenLabs: converts character alignment into word timings", async () => {
    const text = "Hi there";
    const chars = [...text];
    const f = mockFetch([{
      match: (u) => u.includes("/with-timestamps"),
      respond: () => json({
        audio_base64: Buffer.alloc(2400).toString("base64"),
        alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.1), character_end_times_seconds: chars.map((_, i) => i * 0.1 + 0.1) },
      }),
    }]);
    const r = await new ElevenLabsTts(env, cfg.tts.elevenlabs, { fetch: f, sleep: noSleep }).synthesize(text);
    expect(r.words!.map((w) => w.text)).toEqual(["Hi", "there"]);
    expect(r.words![0]!.end).toBeCloseTo(0.2);
    expect(r.words![1]!.start).toBeCloseTo(0.3);
    expect(r.words![1]!.end).toBeCloseTo(0.8);
    expect(new Headers(f.calls[0]!.init!.headers).get("xi-api-key")).toBe("e");
  });

  it("strips punctuation from aligned words", () => {
    const chars = [..."Wow, ok."];
    const w = charAlignmentToWords({ characters: chars, character_start_times_seconds: chars.map((_, i) => i), character_end_times_seconds: chars.map((_, i) => i + 1) });
    expect(w.map((x) => x.text)).toEqual(["Wow", "ok"]);
  });

  it("classifies HTTP errors", () => {
    expect(toProviderError("x", new HttpError({ status: 401, body: "", url: "u" })).exhausted).toBe(true);
    expect(toProviderError("x", new HttpError({ status: 503, body: "", url: "u" })).retryable).toBe(true);
    expect(toProviderError("x", new HttpError({ status: 429, body: "Quota exceeded ... limit: 0, model", url: "u" })).exhausted).toBe(true);
  });
});

describe("voice stage fallback", () => {
  function provider(name: string, behaviour: (i: number) => "ok" | "fail"): TtsProvider & { calls: number } {
    let calls = 0;
    return {
      name,
      get calls() { return calls; },
      async available() { return { ok: true }; },
      async synthesize(text) {
        const i = calls++;
        if (behaviour(i) === "fail") throw new ProviderError(name, "rate limited", { exhausted: true });
        return { wav: tone(0.4 + text.length / 200), characters: text.length, voice: `${name}:v` };
      },
    };
  }

  it("re-voices the whole video with the next provider when one fails mid-way (one voice per video)", async () => {
    const job = Job.create(mkdtempSync(join(tmpdir(), "avf-test-")), { topic: "t", format: "short", config: cfg }, nullLogger);
    const scenes = [sampleScript().hook, ...sampleScript().scenes.slice(0, 2)];
    const a = provider("a", (i) => (i === 1 ? "fail" : "ok"));
    const b = provider("b", () => "ok");
    const unavailable: TtsProvider = { name: "c", available: async () => ({ ok: false, reason: "no key" }), synthesize: async () => { throw new Error("never"); } };
    const r = await runVoiceStage(job, scenes, [unavailable, a, b], { gapSec: 0.3, transitionSec: 0.4 });
    expect(r.provider).toBe("b");
    expect(b.calls).toBe(3);
    expect(r.attempts.map((x) => `${x.provider}:${x.ok}`)).toEqual(["c:false", "a:false", "b:true"]);
    expect(r.scenes.every((s) => s.timing === "estimated")).toBe(true);
    // absolute word timings are monotonic and inside the timeline
    for (let i = 1; i < r.words.length; i++) expect(r.words[i]!.start).toBeGreaterThanOrEqual(r.words[i - 1]!.start);
    expect(r.words[r.words.length - 1]!.end).toBeLessThanOrEqual(r.timeline.total);
  });

  it("throws a summary when every provider fails", async () => {
    const job = Job.create(mkdtempSync(join(tmpdir(), "avf-test-")), { topic: "t", format: "short", config: cfg }, nullLogger);
    const bad = provider("a", () => "fail");
    await expect(runVoiceStage(job, [sampleScript().hook], [bad], { gapSec: 0.3, transitionSec: 0.4 })).rejects.toThrow(/All TTS providers failed: a:/);
  });
});

describe("visual providers (mocked HTTP)", () => {
  const req = () => ({ scene: sampleScript().hook, index: 0, orientation: "portrait" as const, usedIds: new Set<string>() });

  it("Pexels: picks the matching orientation, skips used photos, keeps attribution", async () => {
    const photo = (id: number, w: number, h: number) => ({ id, width: w, height: h, url: `https://pexels.com/p/${id}`, photographer: `P${id}`, photographer_url: "", src: { original: `https://img/${id}`, large2x: `https://img/${id}/l2x`, large: "", portrait: "", landscape: "" } });
    const f = mockFetch([
      { match: (u) => u.includes("/v1/search"), respond: () => json({ photos: [photo(1, 6000, 4000), photo(2, 3000, 4500), photo(3, 4000, 6000)] }) },
      { match: (u) => u.startsWith("https://img/"), respond: () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00])) },
    ]);
    const p = new PexelsVisuals(env, cfg.visuals.pexels, { fetch: f, sleep: noSleep });
    const r1 = req();
    r1.usedIds.add("pexels:3");
    const a = await p.fetch(r1);
    expect(a.credit).toEqual({ author: "P2", url: "https://pexels.com/p/2", source: "Pexels" });
    expect(a.image!.ext).toBe("jpg");
    expect(f.calls[0]!.url).toContain("orientation=portrait");
    expect(new Headers(f.calls[0]!.init!.headers).get("authorization")).toBe("p");
  });

  it("Gemini image: free-tier 'limit: 0' is reported as exhausted without retries", async () => {
    const f = mockFetch([{ match: (u) => u.endsWith("/images/generations"), respond: () => json({ error: { message: "Quota exceeded for metric: x, limit: 0, model: gemini-2.5-flash-image" } }, 429) }]);
    const err = await new GeminiImageVisuals(env, cfg.visuals.geminiImage, { fetch: f, sleep: noSleep }).fetch(req()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.exhausted).toBe(true);
    expect(f.calls).toHaveLength(1);
  });

  it("Gemini image: decodes b64_json", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const f = mockFetch([{ match: () => true, respond: () => json({ data: [{ b64_json: png.toString("base64") }] }) }]);
    const a = await new GeminiImageVisuals(env, cfg.visuals.geminiImage, { fetch: f, sleep: noSleep }).fetch(req());
    expect(a.image!.ext).toBe("png");
    expect(JSON.parse(String(f.calls[0]!.init!.body))).toMatchObject({ model: "gemini-2.5-flash-image", response_format: "b64_json" });
  });
});

describe("LLM model fallback", () => {
  it("moves to the next model when the daily quota is exhausted and remembers it", async () => {
    const { createLlmClient } = await import("../src/llm/client.js");
    const f = mockFetch([{
      match: (u) => u.endsWith("/chat/completions"),
      respond: (_u, init) => {
        const model = JSON.parse(String(init!.body)).model;
        if (model === "gemini-2.5-flash") return json([{ error: { code: 429, message: "Quota exceeded ... limit: 20 ... Please retry in 2h16m15.5s." } }], 429);
        return json({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 5, completion_tokens: 2 }, model });
      },
    }]);
    const llm = createLlmClient(ConfigSchema.parse({}).llm, env, { fetch: f, sleep: noSleep });
    const r1 = await llm.chat([{ role: "user", content: "hi" }]);
    expect(r1.model).toBe("gemini-3-flash-preview");
    await llm.chat([{ role: "user", content: "again" }]);
    const models = f.calls.map((c) => JSON.parse(String(c.init!.body)).model);
    expect(models).toEqual(["gemini-2.5-flash", "gemini-3-flash-preview", "gemini-3-flash-preview"]);
    expect(new Headers(f.calls[0]!.init!.headers).get("authorization")).toBe("Bearer g");
  });
});
