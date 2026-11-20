import { writeFileSync } from "node:fs";
import { buildAss, type CaptionStyle, type CaptionWord } from "../captions/ass.js";
import { buildSrt } from "../captions/srt.js";
import type { AppConfig } from "../config/schema.js";
import type { Job } from "../core/job.js";
import type { FormatSpec } from "../formats.js";
import type { Theme } from "../visuals/themes.js";

export interface CaptionsStageData {
  ass: string;
  srt: string;
  words: number;
}

export function captionStyle(format: FormatSpec, cfg: AppConfig["render"]["captions"], theme: Theme): CaptionStyle {
  const c = format.captions;
  return {
    width: format.width,
    height: format.height,
    font: cfg.font,
    fontSize: c.fontSize,
    textColor: cfg.textColor,
    highlightColor: cfg.highlightColor ?? theme.accent,
    outlineColor: "#000000",
    outline: c.outline,
    shadow: c.shadow,
    marginV: c.marginV,
    marginH: c.marginH,
    uppercase: cfg.uppercase,
    maxWordsPerChunk: cfg.maxWordsPerChunk ?? c.maxWordsPerChunk,
    maxCharsPerChunk: c.maxCharsPerChunk,
    leadSec: 0.05,
    pop: true,
  };
}

export function runCaptionsStage(job: Job, words: CaptionWord[], style: CaptionStyle): CaptionsStageData {
  writeFileSync(job.path("captions.ass"), buildAss(words, style));
  writeFileSync(job.path("captions.srt"), buildSrt(words));
  return { ass: "captions.ass", srt: "captions.srt", words: words.length };
}
