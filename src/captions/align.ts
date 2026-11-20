import { type Pcm, rmsEnvelope } from "../core/wav.js";
import { normalizeForSpeech, splitDisplayWords, type DisplayWord } from "../tts/textNormalize.js";
import type { WordTiming } from "../tts/types.js";

/**
 * Word timings for providers that return audio only (Gemini/OpenAI TTS).
 *
 * 1. find the speech region and internal pauses from the RMS envelope;
 * 2. weight each word by estimated syllables (numbers expanded: "1.8M" ≈ "one point eight million");
 * 3. snap clause breaks (commas, full stops) to detected pauses, then distribute words
 *    proportionally between anchors.
 *
 * Typical error is ~100–200 ms per word — fine for chunked captions, worse than real timings,
 * which is why providers that report timings (Kokoro, ElevenLabs) are preferred.
 */
export function estimateSyllables(word: string): number {
  const spoken = normalizeForSpeech(word).toLowerCase();
  let total = 0;
  for (const w of spoken.split(/\s+/)) {
    if (/^\d+$/.test(w)) {
      total += w.length * 1.5; // rough: digits read as words
      continue;
    }
    const clean = w.replace(/[^a-z]/g, "");
    if (!clean) continue;
    const groups = clean.replace(/e$/, "").match(/[aeiouy]+/g)?.length ?? 1;
    total += Math.max(1, groups);
  }
  return Math.max(1, total);
}

export interface Pause {
  start: number;
  end: number;
}

export function detectSpeech(pcm: Pcm, opts: { windowSec?: number; minPauseSec?: number; thresholdRatio?: number } = {}) {
  const windowSec = opts.windowSec ?? 0.01;
  const env = rmsEnvelope(pcm, windowSec);
  let peak = 0;
  for (const v of env) peak = Math.max(peak, v);
  const thr = Math.max(peak * (opts.thresholdRatio ?? 0.06), 1e-4);
  let first = -1;
  let last = -1;
  for (let i = 0; i < env.length; i++) {
    if (env[i]! > thr) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return { speechStart: 0, speechEnd: env.length * windowSec, pauses: [] as Pause[] };
  const minRun = Math.round((opts.minPauseSec ?? 0.12) / windowSec);
  const pauses: Pause[] = [];
  let runStart = -1;
  for (let i = first; i <= last; i++) {
    const quiet = env[i]! <= thr;
    if (quiet && runStart < 0) runStart = i;
    if (!quiet && runStart >= 0) {
      if (i - runStart >= minRun) pauses.push({ start: runStart * windowSec, end: i * windowSec });
      runStart = -1;
    }
  }
  return { speechStart: first * windowSec, speechEnd: (last + 1) * windowSec, pauses };
}

function distribute(words: DisplayWord[], start: number, end: number): WordTiming[] {
  const weights = words.map((w) => estimateSyllables(w.text) + 0.35);
  const total = weights.reduce((a, b) => a + b, 0);
  let t = start;
  return words.map((w, i) => {
    const d = ((end - start) * weights[i]!) / total;
    const timing = { text: w.text, start: t, end: t + d };
    t += d;
    return timing;
  });
}

export function estimateWordTimings(text: string, pcm: Pcm): WordTiming[] {
  const words = splitDisplayWords(text);
  if (!words.length) return [];
  const { speechStart, speechEnd, pauses } = detectSpeech(pcm);
  // First pass: proportional estimate over the whole speech region.
  const rough = distribute(words, speechStart, speechEnd);
  // Anchor clause breaks to the nearest unused detected pause.
  const anchors: Array<{ wordIndex: number; pause: Pause }> = [];
  const used = new Set<number>();
  const tolerance = Math.max(0.6, (speechEnd - speechStart) * 0.15);
  words.forEach((w, i) => {
    if (!w.breakAfter || i === words.length - 1) return;
    const expected = rough[i]!.end;
    let best = -1;
    let bestDist = Infinity;
    pauses.forEach((p, pi) => {
      if (used.has(pi)) return;
      const d = Math.abs((p.start + p.end) / 2 - expected);
      if (d < bestDist) {
        bestDist = d;
        best = pi;
      }
    });
    if (best >= 0 && bestDist <= tolerance) {
      // Keep anchors monotonic.
      const prev = anchors[anchors.length - 1];
      if (!prev || pauses[best]!.start > prev.pause.end) {
        used.add(best);
        anchors.push({ wordIndex: i, pause: pauses[best]! });
      }
    }
  });
  const out: WordTiming[] = [];
  let segStartWord = 0;
  let segStart = speechStart;
  for (const a of anchors) {
    out.push(...distribute(words.slice(segStartWord, a.wordIndex + 1), segStart, a.pause.start));
    segStartWord = a.wordIndex + 1;
    segStart = a.pause.end;
  }
  out.push(...distribute(words.slice(segStartWord), segStart, speechEnd));
  return out;
}
