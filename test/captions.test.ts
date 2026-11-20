import { describe, expect, it } from "vitest";
import { detectSpeech, estimateSyllables, estimateWordTimings } from "../src/captions/align.js";
import { assTime, buildAss, hexToAssInline, type CaptionStyle, type CaptionWord, chunkWords, escapeAss, hexToAss } from "../src/captions/ass.js";
import { buildSrt } from "../src/captions/srt.js";
import type { Pcm } from "../src/core/wav.js";
import { normalizeForSpeech, splitDisplayWords } from "../src/tts/textNormalize.js";

const style: CaptionStyle = {
  width: 1080, height: 1920, font: "Inter Display Black", fontSize: 100, textColor: "#FFFFFF", highlightColor: "#FFD23F",
  outlineColor: "#000000", outline: 8, shadow: 4, marginV: 560, marginH: 120, uppercase: true,
  maxWordsPerChunk: 3, maxCharsPerChunk: 16, leadSec: 0.05, pop: true,
};

function words(text: string, wordSec = 0.3): CaptionWord[] {
  return splitDisplayWords(text).map((w, i) => ({ text: w.text, start: i * wordSec, end: i * wordSec + wordSec * 0.9, breakAfter: w.breakAfter || undefined }));
}

describe("text helpers", () => {
  it("splits display words and keeps clause punctuation", () => {
    const w = splitDisplayWords('Octopuses solve puzzles, use tools — and "even" mimic others!');
    expect(w.map((x) => x.text)).toEqual(["Octopuses", "solve", "puzzles", "use", "tools", "and", "even", "mimic", "others"]);
    expect(w[2]!.breakAfter).toBe(",");
    expect(w[4]!.breakAfter).toBe("—");
    expect(w[8]!.breakAfter).toBe("!");
  });

  it("normalizes symbols for speech", () => {
    expect(normalizeForSpeech("1.8M subs & 90% of $5")).toBe("1.8 million subs and 90 percent of 5 dollars");
    expect(normalizeForSpeech("$2B deal")).toBe("2 billion dollars deal");
  });

  it("estimates syllables", () => {
    expect(estimateSyllables("cat")).toBe(1);
    expect(estimateSyllables("octopus")).toBe(3);
    expect(estimateSyllables("500")).toBeGreaterThan(2);
  });
});

describe("ASS generation", () => {
  it("converts colours and times", () => {
    expect(hexToAss("#FFD23F")).toBe("&H003FD2FF");
    expect(hexToAss("#000000", 0x60)).toBe("&H60000000");
    expect(assTime(0)).toBe("0:00:00.00");
    expect(assTime(61.234)).toBe("0:01:01.23");
    expect(assTime(3725.5)).toBe("1:02:05.50");
    expect(hexToAssInline("#FFD23F")).toBe("&H3FD2FF&");
    expect(escapeAss("a{b}\\c")).toBe("a(b)\\\\c");
  });

  it("never lets a chunk straddle punctuation and balances chunk sizes", () => {
    const chunks = chunkWords(words("Octopuses solve puzzles, use tools, and even mimic other animals."), 3, 16);
    expect(chunks.map((c) => c.words.map((w) => w.text).join(" "))).toEqual([
      "Octopuses solve", "puzzles", "use tools", "and even mimic", "other animals",
    ]);
  });

  it("splits on long silences", () => {
    const ws = words("one two three four");
    ws[2]!.start += 2;
    ws[2]!.end += 2;
    ws[3]!.start += 2;
    ws[3]!.end += 2;
    expect(chunkWords(ws, 6, 40).map((c) => c.words.length)).toEqual([2, 2]);
  });

  it("emits one event per word with the active word highlighted, in order, without overlaps", () => {
    const ass = buildAss(words("The octopus has nine brains."), style);
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("Style: Caption,Inter Display Black,100,");
    const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(events).toHaveLength(5);
    expect(events[0]).toContain("{\\c&H3FD2FF&\\fscx");
    expect(events[0]).toContain("{\\c&HFFFFFF&");
    expect(events[0]).toMatch(/\\t\(0,110/); // pop-in on the first word of a chunk
    const toSec = (t: string) => { const [h, m, s] = t.split(":"); return +h! * 3600 + +m! * 60 + +s!; };
    const spans = events.map((e) => e.split(",").slice(1, 3).map(toSec) as [number, number]);
    for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1] - 1e-9);
    expect(ass).toContain("THE");
  });

  it("builds SRT", () => {
    const srt = buildSrt(words("Hello there. General Kenobi."));
    expect(srt).toMatch(/^1\n00:00:00,000 --> 00:00:00,/);
    expect(srt).toContain("General Kenobi");
  });
});

describe("alignment estimator", () => {
  // 3 "words" of tone separated by silences: 0.2-0.8 s, [pause], 1.2-1.6 s, 1.6-2.0 s
  function synth(): Pcm {
    const sr = 16000;
    const s = new Float32Array(sr * 2.3);
    const tone = (a: number, b: number) => { for (let i = Math.floor(a * sr); i < b * sr; i++) s[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / sr); };
    tone(0.2, 0.8);
    tone(1.2, 2.0);
    return { sampleRate: sr, channels: 1, samples: s };
  }

  it("finds the speech region and pauses", () => {
    const d = detectSpeech(synth());
    expect(d.speechStart).toBeCloseTo(0.2, 1);
    expect(d.speechEnd).toBeCloseTo(2.0, 1);
    expect(d.pauses).toHaveLength(1);
    expect(d.pauses[0]!.start).toBeCloseTo(0.8, 1);
  });

  it("snaps clause breaks to detected pauses", () => {
    const t = estimateWordTimings("Hello, big world", synth());
    expect(t.map((w) => w.text)).toEqual(["Hello", "big", "world"]);
    expect(t[0]!.start).toBeCloseTo(0.2, 1);
    expect(t[0]!.end).toBeCloseTo(0.8, 1);
    expect(t[1]!.start).toBeCloseTo(1.2, 1);
    expect(t[2]!.end).toBeCloseTo(2.0, 1);
  });
});
