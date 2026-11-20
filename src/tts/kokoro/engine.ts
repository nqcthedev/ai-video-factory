import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import type { InferenceSession as OrtSession } from "onnxruntime-node";
import { concatSamples, silence } from "../../core/wav.js";
import type { WordTiming } from "../types.js";
import { addGraphOutput, KOKORO_DURATION_TENSOR } from "./onnxPatch.js";
import { parseNpz } from "./npz.js";
import { phonemizeText } from "./phonemes.js";
import { KOKORO_MAX_TOKENS, KOKORO_SAMPLE_RATE, KOKORO_SAMPLES_PER_FRAME } from "./vocab.js";

export const KOKORO_FILES = {
  model: "kokoro-v1.0.onnx",
  timedModel: "kokoro-v1.0.timed.onnx",
  voices: "voices-v1.0.bin",
} as const;

export interface KokoroResult {
  samples: Float32Array;
  sampleRate: number;
  words: WordTiming[];
}

/**
 * Local Kokoro-82M inference with onnxruntime-node. Produces 24 kHz mono audio plus
 * word timestamps derived from the model's own phoneme durations.
 */
export class KokoroEngine {
  private session?: OrtSession;
  private voices?: Map<string, { shape: number[]; data: Float32Array }>;
  private loading?: Promise<void>;

  constructor(private readonly dir: string) {}

  static filesPresent(dir: string): boolean {
    return existsSync(join(dir, KOKORO_FILES.voices)) && (existsSync(join(dir, KOKORO_FILES.timedModel)) || existsSync(join(dir, KOKORO_FILES.model)));
  }

  /** Create the duration-exposing model next to the original (one-time, ~1 s). */
  static ensureTimedModel(dir: string): string {
    const timed = join(dir, KOKORO_FILES.timedModel);
    if (!existsSync(timed)) writeFileSync(timed, addGraphOutput(readFileSync(join(dir, KOKORO_FILES.model)), KOKORO_DURATION_TENSOR));
    return timed;
  }

  private async load(): Promise<void> {
    if (this.session) return;
    this.loading ??= (async () => {
      const ort = await import("onnxruntime-node");
      const modelPath = KokoroEngine.ensureTimedModel(this.dir);
      this.session = await ort.InferenceSession.create(modelPath, {
        intraOpNumThreads: Math.max(1, cpus().length),
        graphOptimizationLevel: "all",
      });
      this.voices = parseNpz(readFileSync(join(this.dir, KOKORO_FILES.voices)));
    })();
    await this.loading;
  }

  async listVoices(): Promise<string[]> {
    if (!this.voices) this.voices = parseNpz(readFileSync(join(this.dir, KOKORO_FILES.voices)));
    return [...this.voices.keys()].sort();
  }

  /** Style vector for a phoneme count (Kokoro stores one 256-d style per length). */
  private style(voice: string, nTokens: number): Float32Array {
    const v = this.voices!.get(voice);
    if (!v) throw new Error(`unknown Kokoro voice "${voice}". Try: ${[...this.voices!.keys()].slice(0, 12).join(", ")}…`);
    const rows = v.shape[0]!;
    const dim = v.data.length / rows;
    const row = Math.min(Math.max(nTokens, 1), rows) - 1;
    return v.data.slice(row * dim, (row + 1) * dim);
  }

  async synthesize(text: string, opts: { voice: string; speed?: number; lang?: string; sentencePauseSec?: number }): Promise<KokoroResult> {
    await this.load();
    const ort = await import("onnxruntime-node");
    const speed = opts.speed ?? 1;
    const chunks = await phonemizeText(text, opts.lang ?? "en-us", Math.min(400, KOKORO_MAX_TOKENS));
    const parts: Float32Array[] = [];
    const words: WordTiming[] = [];
    let offsetSamples = 0;
    for (const [ci, chunk] of chunks.entries()) {
      if (!chunk.tokens.length) continue;
      const ids = [0, ...chunk.tokens, 0];
      const feeds = {
        tokens: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
        style: new ort.Tensor("float32", this.style(opts.voice, chunk.tokens.length), [1, 256]),
        speed: new ort.Tensor("float32", Float32Array.from([speed]), [1]),
      };
      const out = await this.session!.run(feeds);
      const audio = out.audio!.data as Float32Array;
      const dur = Array.from(out[KOKORO_DURATION_TENSOR]!.data as BigInt64Array, Number);
      // cumulative frame index at the start of each token (index 0 = leading pad)
      const cum: number[] = [0];
      for (const d of dur) cum.push(cum[cum.length - 1]! + d);
      const frameSec = KOKORO_SAMPLES_PER_FRAME / KOKORO_SAMPLE_RATE;
      chunk.wordTokenRanges.forEach(([s, e], wi) => {
        const pw = chunk.words[wi]!;
        words.push({
          text: pw.word.text,
          start: offsetSamples / KOKORO_SAMPLE_RATE + cum[s + 1]! * frameSec,
          end: offsetSamples / KOKORO_SAMPLE_RATE + cum[e + 1]! * frameSec,
        });
      });
      parts.push(audio);
      offsetSamples += audio.length;
      if (ci < chunks.length - 1) {
        const pause = silence(chunk.endsSentence ? (opts.sentencePauseSec ?? 0.12) : 0.04, KOKORO_SAMPLE_RATE);
        parts.push(pause);
        offsetSamples += pause.length;
      }
    }
    return { samples: concatSamples(parts), sampleRate: KOKORO_SAMPLE_RATE, words };
  }
}
