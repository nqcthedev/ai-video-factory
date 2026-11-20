import { type AppConfig, ConfigSchema } from "../config/schema.js";

export interface CostInput {
  llm?: { model: string; promptTokens: number; completionTokens: number };
  tts?: { provider: string; characters: number };
  images?: Record<string, number>;
}

export interface CostBreakdown {
  llmUsd: number;
  ttsUsd: number;
  imagesUsd: number;
  totalUsd: number;
  notes: string[];
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/** Estimate the API spend of one video from usage counters and the configured price table. */
export function estimateCost(input: CostInput, prices: AppConfig["costs"]): CostBreakdown {
  // Built-in prices fill gaps in older job snapshots / user tables.
  prices = { ...prices, llm: { ...ConfigSchema.parse({}).costs.llm, ...prices.llm } };
  const notes: string[] = [];
  let llmUsd = 0;
  if (input.llm) {
    const p = prices.llm[input.llm.model] ?? Object.entries(prices.llm).find(([k]) => input.llm!.model.startsWith(k))?.[1];
    if (p) llmUsd = (input.llm.promptTokens / 1e6) * p.inputPerMTok + (input.llm.completionTokens / 1e6) * p.outputPerMTok;
    else notes.push(`no price configured for LLM model ${input.llm.model}`);
  }
  let ttsUsd = 0;
  if (input.tts) {
    const perM: Record<string, number> = {
      kokoro: prices.tts.kokoro,
      gemini: prices.tts.geminiPerMChars,
      openai: prices.tts.openaiPerMChars,
      elevenlabs: prices.tts.elevenlabsPerMChars,
    };
    const rate = perM[input.tts.provider];
    if (rate === undefined) notes.push(`no price configured for TTS provider ${input.tts.provider}`);
    else ttsUsd = (input.tts.characters / 1e6) * rate;
    if (input.tts.provider === "kokoro") notes.push("Kokoro runs locally: $0 API cost (CPU time only)");
  }
  let imagesUsd = 0;
  const perImage: Record<string, number> = {
    "gemini-image": prices.images.geminiPerImage,
    pexels: prices.images.pexelsPerImage,
    designed: prices.images.designedPerImage,
  };
  for (const [provider, n] of Object.entries(input.images ?? {})) imagesUsd += n * (perImage[provider] ?? 0);
  return { llmUsd: round(llmUsd), ttsUsd: round(ttsUsd), imagesUsd: round(imagesUsd), totalUsd: round(llmUsd + ttsUsd + imagesUsd), notes };
}
