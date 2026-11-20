/** Tiny PCM WAV helpers (mono/stereo 16-bit). Enough for TTS stitching without extra deps. */
export interface Pcm {
  sampleRate: number;
  channels: number;
  /** Interleaved float samples in [-1, 1]. */
  samples: Float32Array;
}

export function encodeWav({ sampleRate, channels, samples }: Pcm): Buffer {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return buf;
}

export function decodeWav(buf: Buffer): Pcm {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let pos = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | undefined;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    let size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data before fmt chunk");
      if (size === 0xffffffff || body + size > buf.length) size = buf.length - body; // streamed WAVs
      const n = Math.floor(size / (fmt.bits / 8));
      const samples = new Float32Array(n);
      if (fmt.format === 1 && fmt.bits === 16) for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(body + i * 2) / 0x8000;
      else if (fmt.format === 3 && fmt.bits === 32) for (let i = 0; i < n; i++) samples[i] = buf.readFloatLE(body + i * 4);
      else throw new Error(`unsupported WAV format ${fmt.format}/${fmt.bits}bit`);
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples };
    }
    pos = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

/** Raw little-endian s16 PCM (e.g. Gemini TTS output) → WAV. */
export function pcm16ToWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const samples = new Float32Array(Math.floor(pcm.length / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 0x8000;
  return encodeWav({ sampleRate, channels, samples });
}

export function silence(seconds: number, sampleRate: number, channels = 1): Float32Array {
  return new Float32Array(Math.round(seconds * sampleRate) * channels);
}

export function concatSamples(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function durationSec(p: Pcm): number {
  return p.samples.length / p.channels / p.sampleRate;
}

/** RMS level per window (mono), used for silence trimming and pause detection. */
export function rmsEnvelope(p: Pcm, windowSec = 0.01): Float32Array {
  const win = Math.max(1, Math.round(windowSec * p.sampleRate));
  const frames = Math.floor(p.samples.length / p.channels);
  const out = new Float32Array(Math.ceil(frames / win));
  for (let w = 0; w < out.length; w++) {
    let acc = 0;
    let n = 0;
    for (let f = w * win; f < Math.min(frames, (w + 1) * win); f++) {
      for (let c = 0; c < p.channels; c++) {
        const s = p.samples[f * p.channels + c]!;
        acc += s * s;
        n++;
      }
    }
    out[w] = n ? Math.sqrt(acc / n) : 0;
  }
  return out;
}
