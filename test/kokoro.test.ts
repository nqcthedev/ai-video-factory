import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { addGraphOutput, listGraphOutputs } from "../src/tts/kokoro/onnxPatch.js";
import { parseNpz } from "../src/tts/kokoro/npz.js";
import { buildChunk, phonemizeText } from "../src/tts/kokoro/phonemes.js";
import { KOKORO_VOCAB } from "../src/tts/kokoro/vocab.js";

// Minimal protobuf writer for test fixtures.
const varint = (n: number) => { const o: number[] = []; while (n > 0x7f) { o.push((n & 0x7f) | 0x80); n >>>= 7; } o.push(n); return o; };
const ld = (field: number, payload: number[]) => [...varint((field << 3) | 2), ...varint(payload.length), ...payload];
const str = (s: string) => [...new TextEncoder().encode(s)];

describe("ONNX graph patch", () => {
  it("appends a graph output and is idempotent", () => {
    const valueInfo = (name: string) => ld(1, str(name));
    const graph = [...ld(1, str("node-bytes")), ...ld(12, valueInfo("audio"))];
    const model = Uint8Array.from([...varint(8), ...varint(7), ...ld(7, graph), ...ld(2, str("producer"))]); // ir_version=7
    expect(listGraphOutputs(model)).toEqual(["audio"]);
    const patched = addGraphOutput(model, "/encoder/Cast_output_0");
    expect(listGraphOutputs(patched)).toEqual(["audio", "/encoder/Cast_output_0"]);
    expect(addGraphOutput(patched, "/encoder/Cast_output_0")).toBe(patched);
    // fields after the graph survive
    expect(new TextDecoder().decode(patched)).toContain("producer");
  });
});

describe("npz voices", () => {
  it("parses float32 arrays from a .npz", () => {
    const header = "{'descr': '<f4', 'fortran_order': False, 'shape': (2, 1, 3), }";
    const padded = header.padEnd(118, " ") + "\n"; // 10 + 118 = 128 bytes (aligned)
    const data = new Float32Array([1, 2, 3, 4, 5, 6]);
    const npy = new Uint8Array(10 + padded.length + data.byteLength);
    npy.set([0x93, ...str("NUMPY"), 1, 0, padded.length & 0xff, padded.length >> 8]);
    npy.set(str(padded), 10);
    npy.set(new Uint8Array(data.buffer), 10 + padded.length);
    const voices = parseNpz(zipSync({ "af_test.npy": npy }));
    expect(voices.get("af_test")!.shape).toEqual([2, 1, 3]);
    expect(Array.from(voices.get("af_test")!.data)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("phonemization with word boundaries (espeak-ng wasm, offline)", () => {
  it("maps every display word to its own token range", async () => {
    const chunks = await phonemizeText("An octopus has about 500 million neurons, and three hearts.");
    const words = chunks.flatMap((c) => c.words.map((w) => w.word.text));
    expect(words).toEqual(["An", "octopus", "has", "about", "500", "million", "neurons", "and", "three", "hearts"]);
    for (const c of chunks) {
      expect(c.tokens.every((t) => t > 0)).toBe(true);
      let prevEnd = 0;
      for (const [s, e] of c.wordTokenRanges) {
        expect(e).toBeGreaterThan(s);
        expect(s).toBeGreaterThanOrEqual(prevEnd);
        prevEnd = e;
      }
      expect(c.text).toContain(",");
    }
  });

  it("uses context-dependent forms (the article 'a' is not the letter name)", async () => {
    const [c] = await phonemizeText("It is a test.");
    expect(c!.words[2]!.phonemes).not.toContain("eɪ");
  });

  it("builds chunks with punctuation tokens between words", () => {
    const c = buildChunk([
      { word: { text: "Hi", raw: "Hi,", breakAfter: "," }, phonemes: "hˈaɪ" },
      { word: { text: "you", raw: "you.", breakAfter: "." }, phonemes: "juː" },
    ]);
    expect(c.text).toBe("hˈaɪ, juː.");
    expect(c.tokens).toContain(KOKORO_VOCAB[","]);
    expect(c.wordTokenRanges).toEqual([[0, 4], [6, 9]]);
    expect(c.endsSentence).toBe(true);
  });
});
