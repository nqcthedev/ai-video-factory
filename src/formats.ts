import type { FormatName } from "./config/schema.js";

export interface FormatSpec {
  name: FormatName;
  label: string;
  width: number;
  height: number;
  /** Narration word budget (Kokoro af_heart ≈ 2.2 words/s at speed 1.0, ≈ 2.45 at 1.12). */
  words: [min: number, max: number];
  /** Multiplier applied to the configured TTS speed (Shorts are paced a little faster). */
  speechRate: number;
  scenes: [min: number, max: number];
  targetSec: [min: number, max: number];
  captions: {
    fontSize: number;
    marginV: number;
    marginH: number;
    maxWordsPerChunk: number;
    maxCharsPerChunk: number;
    outline: number;
    shadow: number;
  };
}

/**
 * Safe areas: on Shorts/Reels/TikTok the bottom ~22 % (title, channel, music) and a right
 * column (like/comment/share) are covered by UI, so captions sit at ~64–70 % height, centred,
 * and scene graphics keep their main content in the upper-middle band.
 */
export const FORMATS: Record<FormatName, FormatSpec> = {
  short: {
    name: "short",
    label: "9:16 Shorts / Reels / TikTok",
    width: 1080,
    height: 1920,
    words: [100, 125],
    speechRate: 1.12,
    scenes: [6, 8],
    targetSec: [42, 56],
    captions: { fontSize: 94, marginV: 560, marginH: 100, maxWordsPerChunk: 3, maxCharsPerChunk: 15, outline: 8, shadow: 4 },
  },
  long: {
    name: "long",
    label: "16:9 YouTube",
    width: 1920,
    height: 1080,
    words: [150, 190],
    speechRate: 1.03,
    scenes: [7, 10],
    targetSec: [65, 88],
    captions: { fontSize: 72, marginV: 64, marginH: 240, maxWordsPerChunk: 5, maxCharsPerChunk: 30, outline: 6, shadow: 3 },
  },
};
