import { phonemize as espeak } from "phonemizer";
import { type DisplayWord, isSentenceEnd, normalizeForSpeech, splitDisplayWords } from "../textNormalize.js";
import { KOKORO_VOCAB } from "./vocab.js";

/**
 * Text → Kokoro phoneme tokens, keeping track of which tokens belong to which display word.
 *
 * Whole clauses are phonemized together (espeak picks context-dependent forms, e.g. "a" → ɐ
 * instead of the letter name "eɪ"). To recover word boundaries we also phonemize every word on
 * its own just to count how many phoneme-words it yields ("1.8" → "one point eight" = 3).
 * If the counts disagree we fall back to per-word phonemes for that clause.
 *
 * Post-processing rules mirror kokoro-js (Apache-2.0, hexgrad / xenova).
 */
export interface PhonemizedWord {
  word: DisplayWord;
  /** Phoneme string for this word (no surrounding spaces). */
  phonemes: string;
}

export interface PhonemeChunk {
  words: PhonemizedWord[];
  /** Full phoneme string fed to the model, e.g. "ðɪ ˈɑːktəpəs ɪz smˈɑːɹt." */
  text: string;
  tokens: number[];
  /** Token index range [start, end) per word, relative to `tokens` (without boundary pads). */
  wordTokenRanges: Array<[number, number]>;
  /** True if this chunk ends a sentence (a slightly longer pause follows). */
  endsSentence: boolean;
}

const cache = new Map<string, string[]>();

async function espeakWords(text: string, lang: string): Promise<string[]> {
  const key = `${lang}|${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const parts = await espeak(text, lang);
  const words = parts.join(" ").split(/\s+/).filter(Boolean).map(postProcess);
  cache.set(key, words);
  return words;
}

export function postProcess(ps: string): string {
  return ps
    .replace(/kəkˈoːɹoʊ/g, "kˈoʊkəɹoʊ")
    .replace(/kəkˈɔːɹəʊ/g, "kˈəʊkəɹəʊ")
    .replace(/ʲ/g, "j")
    .replace(/r/g, "ɹ")
    .replace(/x/g, "k")
    .replace(/ɬ/g, "l");
}

function toTokens(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const id = KOKORO_VOCAB[ch];
    if (id !== undefined) out.push(id);
  }
  return out;
}

/** Phonemize one clause (words up to a punctuation break). */
async function phonemizeClause(words: DisplayWord[], lang: string): Promise<PhonemizedWord[]> {
  const spoken = words.map((w) => normalizeForSpeech(w.text));
  const whole = await espeakWords(spoken.join(" "), lang);
  const single = await Promise.all(spoken.map((s) => espeakWords(s, lang)));
  const counts = single.map((p) => p.length);
  if (counts.reduce((a, b) => a + b, 0) === whole.length && counts.every((c) => c > 0)) {
    let i = 0;
    return words.map((word, k) => {
      const ph = whole.slice(i, i + counts[k]!).join(" ");
      i += counts[k]!;
      return { word, phonemes: ph };
    });
  }
  return words.map((word, k) => ({ word, phonemes: single[k]!.join(" ") }));
}

/**
 * Split narration into model-sized chunks (by sentence, merged up to `maxTokens`),
 * each with per-word token ranges.
 */
export async function phonemizeText(text: string, lang = "en-us", maxTokens = 400): Promise<PhonemeChunk[]> {
  const words = splitDisplayWords(text);
  // 1) clauses
  const clauses: DisplayWord[][] = [];
  let cur: DisplayWord[] = [];
  for (const w of words) {
    cur.push(w);
    if (w.breakAfter) {
      clauses.push(cur);
      cur = [];
    }
  }
  if (cur.length) clauses.push(cur);
  const phClauses = await Promise.all(clauses.map((c) => phonemizeClause(c, lang)));

  // 2) sentences = runs of clauses until a sentence end
  const sentences: PhonemizedWord[][] = [];
  let sent: PhonemizedWord[] = [];
  for (const c of phClauses) {
    sent.push(...c);
    if (isSentenceEnd(c[c.length - 1]!.word.breakAfter)) {
      sentences.push(sent);
      sent = [];
    }
  }
  if (sent.length) sentences.push(sent);

  // 3) build chunks; merge short sentences, split very long ones at clause boundaries
  const chunks: PhonemeChunk[] = [];
  let pending: PhonemizedWord[] = [];
  const flush = () => {
    if (pending.length) chunks.push(buildChunk(pending));
    pending = [];
  };
  for (const s of sentences) {
    const sTok = buildChunk(s).tokens.length;
    if (sTok > maxTokens) {
      flush();
      // split at clause breaks
      let part: PhonemizedWord[] = [];
      for (const w of s) {
        part.push(w);
        if (w.word.breakAfter && buildChunk(part).tokens.length > maxTokens * 0.6) {
          chunks.push(buildChunk(part));
          part = [];
        }
      }
      if (part.length) chunks.push(buildChunk(part));
      continue;
    }
    if (pending.length && buildChunk([...pending, ...s]).tokens.length > maxTokens) flush();
    pending.push(...s);
    // Keep sentences separate for natural sentence-final prosody when chunks get long enough.
    if (buildChunk(pending).tokens.length > maxTokens * 0.5) flush();
  }
  flush();
  return chunks;
}

export function buildChunk(words: PhonemizedWord[]): PhonemeChunk {
  const tokens: number[] = [];
  const ranges: Array<[number, number]> = [];
  let text = "";
  words.forEach((pw, i) => {
    const start = tokens.length;
    tokens.push(...toTokens(pw.phonemes));
    ranges.push([start, tokens.length]);
    text += pw.phonemes;
    const p = pw.word.breakAfter;
    const punct = p === "—" ? "—" : p;
    if (punct) {
      text += punct;
      tokens.push(...toTokens(punct));
    }
    if (i < words.length - 1) {
      text += " ";
      tokens.push(KOKORO_VOCAB[" "]!);
    }
  });
  const last = words[words.length - 1];
  return { words, text, tokens, wordTokenRanges: ranges, endsSentence: last ? isSentenceEnd(last.word.breakAfter) : false };
}
