import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { estimateWordTimings, detectSpeech } from "../captions/align.js";
import type { CaptionWord } from "../captions/ass.js";
import { ProviderError } from "../core/errors.js";
import type { Job } from "../core/job.js";
import { concatSamples, decodeWav, encodeWav, type Pcm, silence } from "../core/wav.js";
import { runFfmpeg } from "../render/ffmpeg.js";
import { buildTimeline, type Timeline } from "../render/timeline.js";
import { splitDisplayWords } from "../tts/textNormalize.js";
import type { TtsProvider, WordTiming } from "../tts/types.js";
import type { Scene } from "./script.js";

export const NARRATION_RATE = 24_000;

export interface VoiceScene {
  index: number;
  file: string;
  duration: number;
  /** Word timings relative to the start of this scene's (trimmed) audio. */
  words: CaptionWord[];
  timing: "provider" | "estimated";
}

export interface VoiceStageData {
  provider: string;
  voice: string;
  characters: number;
  scenes: VoiceScene[];
  narration: string;
  timeline: Timeline;
  /** All words on the video timeline (absolute seconds). */
  words: CaptionWord[];
  attempts: Array<{ provider: string; ok: boolean; error?: string }>;
}

/** Bring any provider WAV to 24 kHz mono so scenes can be stitched sample-accurately. */
async function toNarrationPcm(wav: Buffer, tmpPath: string): Promise<Pcm> {
  const pcm = decodeWav(wav);
  if (pcm.sampleRate === NARRATION_RATE && pcm.channels === 1) return pcm;
  writeFileSync(`${tmpPath}.src.wav`, wav);
  await runFfmpeg(["-y", "-v", "error", "-i", `${tmpPath}.src.wav`, "-ac", "1", "-ar", String(NARRATION_RATE), "-c:a", "pcm_s16le", `${tmpPath}.conv.wav`]);
  return decodeWav(readFileSync(`${tmpPath}.conv.wav`));
}

/** Trim leading/trailing silence (keeping a little air) and shift word timings to match. */
export function trimSilence(pcm: Pcm, words: WordTiming[] | undefined, pre = 0.06, post = 0.14): { pcm: Pcm; words?: WordTiming[] } {
  const { speechStart, speechEnd } = detectSpeech(pcm, { thresholdRatio: 0.03 });
  const firstWord = words?.[0]?.start ?? speechStart;
  const lastWord = words?.[words.length - 1]?.end ?? speechEnd;
  const start = Math.max(0, Math.min(speechStart, firstWord) - pre);
  const end = Math.min(pcm.samples.length / pcm.sampleRate, Math.max(speechEnd, lastWord) + post);
  const s0 = Math.floor(start * pcm.sampleRate);
  const s1 = Math.ceil(end * pcm.sampleRate);
  return {
    pcm: { ...pcm, samples: pcm.samples.slice(s0, s1) },
    words: words?.map((w) => ({ ...w, start: Math.max(0, w.start - start), end: Math.max(0, w.end - start) })),
  };
}

/** Attach display text + punctuation (for caption chunking) to provider or estimated timings. */
function attachDisplay(narration: string, timings: WordTiming[]): CaptionWord[] | undefined {
  const display = splitDisplayWords(narration);
  if (display.length !== timings.length) return undefined;
  return display.map((d, i) => ({ text: d.text, start: timings[i]!.start, end: timings[i]!.end, breakAfter: d.breakAfter || undefined }));
}

export async function runVoiceStage(
  job: Job,
  scenes: Scene[],
  providers: TtsProvider[],
  opts: { gapSec: number; transitionSec: number },
): Promise<VoiceStageData> {
  mkdirSync(job.path("audio"), { recursive: true });
  const attempts: VoiceStageData["attempts"] = [];
  for (const provider of providers) {
    const avail = await provider.available();
    if (!avail.ok) {
      job.log.info(`tts ${provider.name} skipped`, { reason: avail.reason });
      attempts.push({ provider: provider.name, ok: false, error: avail.reason });
      continue;
    }
    try {
      const out: VoiceScene[] = [];
      const pcms: Pcm[] = [];
      let characters = 0;
      let voice = provider.name;
      // One voice per video: every scene must come from the same provider.
      for (const [i, scene] of scenes.entries()) {
        const t0 = Date.now();
        const res = await provider.synthesize(scene.narration);
        characters += res.characters;
        voice = res.voice;
        const rel = `audio/scene-${String(i).padStart(2, "0")}.wav`;
        const raw = await toNarrationPcm(res.wav, job.path(rel));
        const trimmed = trimSilence(raw, res.words);
        let words = trimmed.words ? attachDisplay(scene.narration, trimmed.words) : undefined;
        const timing: VoiceScene["timing"] = words ? "provider" : "estimated";
        if (!words) words = attachDisplay(scene.narration, estimateWordTimings(scene.narration, trimmed.pcm))!;
        writeFileSync(job.path(rel), encodeWav(trimmed.pcm));
        const duration = trimmed.pcm.samples.length / trimmed.pcm.sampleRate;
        out.push({ index: i, file: rel, duration, words, timing });
        pcms.push(trimmed.pcm);
        job.log.info(`voiced scene ${i + 1}/${scenes.length}`, { provider: provider.name, sec: +duration.toFixed(2), ms: Date.now() - t0, timing });
      }
      const timeline = buildTimeline(
        out.map((s) => s.duration),
        { gapSec: opts.gapSec, transitionSec: opts.transitionSec },
      );
      // Stitch the narration on the timeline (lead-in, gaps, tail).
      const parts: Float32Array[] = [silence(timeline.leadIn, NARRATION_RATE)];
      pcms.forEach((p, i) => {
        parts.push(p.samples);
        if (i < pcms.length - 1) parts.push(silence(timeline.scenes[i + 1]!.audioStart - (timeline.scenes[i]!.audioStart + timeline.scenes[i]!.audioDuration), NARRATION_RATE));
      });
      parts.push(silence(timeline.tail, NARRATION_RATE));
      writeFileSync(job.path("audio/narration.wav"), encodeWav({ sampleRate: NARRATION_RATE, channels: 1, samples: concatSamples(parts) }));
      const words = out.flatMap((s, i) =>
        s.words.map((w) => ({ ...w, start: w.start + timeline.scenes[i]!.audioStart, end: w.end + timeline.scenes[i]!.audioStart })),
      );
      attempts.push({ provider: provider.name, ok: true });
      return { provider: provider.name, voice, characters, scenes: out, narration: "audio/narration.wav", timeline, words, attempts };
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      job.log.warn(`tts ${provider.name} failed, falling back`, { error: err.message, exhausted: err.exhausted });
      attempts.push({ provider: provider.name, ok: false, error: err.message });
    }
  }
  throw new Error(`All TTS providers failed: ${attempts.map((a) => `${a.provider}: ${a.error}`).join("; ")}`);
}
