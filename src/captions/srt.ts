import { chunkWords, type CaptionWord } from "./ass.js";

function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

/** Plain SRT (sentence-ish chunks) — upload it to YouTube as a closed-caption track. */
export function buildSrt(words: CaptionWord[], maxWords = 8, maxChars = 42): string {
  return chunkWords(words, maxWords, maxChars, 0.8)
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end + 0.2)}\n${c.words.map((w) => w.text).join(" ")}\n`)
    .join("\n");
}
