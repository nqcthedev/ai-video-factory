import { encodeWav } from "../core/wav.js";

/**
 * Procedural, royalty-free background bed: warm detuned pad chords + a soft plucked arpeggio.
 * Generated from scratch (no samples), so there is nothing to license. Deterministic per seed.
 *
 * It is deliberately understated — it sits ~20 dB under the voice and is ducked while the
 * narrator talks. Bring your own licensed track via `render.music.path` for a branded sound.
 */
const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

/** i–VI–III–VII in A minor, voiced for a pad (MIDI notes; first = bass). */
const PROGRESSIONS: number[][][] = [
  [
    [45, 57, 60, 64, 67, 71], // Am9
    [41, 57, 60, 64, 65, 69], // Fmaj7
    [48, 55, 60, 62, 64, 67], // Cadd9
    [43, 55, 59, 62, 64, 67], // G6
  ],
  [
    [48, 55, 60, 64, 67, 71], // Cmaj7
    [45, 57, 60, 64, 67, 69], // Am7
    [41, 57, 60, 64, 65, 69], // Fmaj7
    [43, 55, 59, 62, 65, 67], // G7
  ],
];

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export interface MusicOptions {
  seconds: number;
  sampleRate?: number;
  bpm?: number;
  seed?: number;
}

export function synthesizeMusic({ seconds, sampleRate = 44100, bpm = 92, seed = 1 }: MusicOptions): Float32Array {
  const rand = rng(seed);
  const prog = PROGRESSIONS[seed % PROGRESSIONS.length]!;
  const beat = 60 / bpm;
  const chordLen = beat * 8; // two bars per chord
  const frames = Math.ceil(seconds * sampleRate);
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  const nChords = Math.ceil(seconds / chordLen) + 1;
  const TAU = Math.PI * 2;

  // Pad: each chord fades in/out with raised-cosine envelopes overlapping the neighbours.
  const xfade = Math.min(1.6, chordLen * 0.35);
  for (let c = 0; c < nChords; c++) {
    const notes = prog[c % prog.length]!;
    const t0 = c * chordLen - xfade / 2;
    const t1 = t0 + chordLen + xfade;
    const s0 = Math.max(0, Math.floor(t0 * sampleRate));
    const s1 = Math.min(frames, Math.ceil(t1 * sampleRate));
    notes.forEach((note, ni) => {
      const isBass = ni === 0;
      const f = midiHz(isBass ? note : note);
      const amp = isBass ? 0.07 : 0.05;
      const partials = isBass ? [[1, 1], [2, 0.25]] : [[1, 1], [2, 0.3], [3, 0.08]];
      const detune = [1 - 0.0021, 1 + 0.0019];
      const phases = partials.map(() => [rand() * TAU, rand() * TAU]);
      for (let s = s0; s < s1; s++) {
        const t = s / sampleRate;
        const lt = t - t0;
        const env = lt < xfade ? 0.5 - 0.5 * Math.cos((Math.PI * lt) / xfade) : t1 - t < xfade ? 0.5 - 0.5 * Math.cos((Math.PI * (t1 - t)) / xfade) : 1;
        let l = 0;
        let r = 0;
        partials.forEach(([mult, pa], pi) => {
          l += pa! * Math.sin(TAU * f * mult! * detune[0]! * t + phases[pi]![0]!);
          r += pa! * Math.sin(TAU * f * mult! * detune[1]! * t + phases[pi]![1]!);
        });
        const trem = 1 + 0.06 * Math.sin(TAU * 0.11 * t + ni);
        L[s]! += l * amp * env * trem;
        R[s]! += r * amp * env * trem;
      }
    });
  }

  // Pluck arpeggio: chord tones an octave up on eighth notes, soft attack, exponential decay.
  const pattern = [1, 3, 2, 4, 1, 3, 5, 3];
  const eighth = beat / 2;
  const nSteps = Math.floor(seconds / eighth);
  for (let k = 0; k < nSteps; k++) {
    const tStart = k * eighth;
    if (tStart < 2 || tStart > seconds - 2.5) continue; // let the pad open and close alone
    const chord = prog[Math.floor(tStart / chordLen) % prog.length]!;
    const note = chord[pattern[k % pattern.length]!]! + 12;
    const f = midiHz(note);
    const vel = (k % 2 === 0 ? 0.045 : 0.03) * (0.85 + rand() * 0.3);
    const pan = 0.5 + 0.25 * Math.sin(k * 0.7);
    const s0 = Math.floor(tStart * sampleRate);
    const len = Math.floor(1.2 * sampleRate);
    for (let i = 0; i < len && s0 + i < frames; i++) {
      const t = i / sampleRate;
      const env = Math.min(1, t / 0.006) * Math.exp(-t / 0.28);
      const v = vel * env * (Math.sin(TAU * f * t) + 0.18 * Math.sin(TAU * 2 * f * t) * Math.exp(-t / 0.08));
      L[s0 + i]! += v * (1 - pan) * 2 * 0.7;
      R[s0 + i]! += v * pan * 2 * 0.7;
    }
  }

  // One-pole low-pass (~2.2 kHz) to keep it soft, then normalize peak to -6 dBFS.
  const a = Math.exp((-TAU * 2200) / sampleRate);
  let yl = 0;
  let yr = 0;
  let peak = 1e-9;
  for (let s = 0; s < frames; s++) {
    yl = (1 - a) * L[s]! + a * yl;
    yr = (1 - a) * R[s]! + a * yr;
    L[s] = yl;
    R[s] = yr;
    peak = Math.max(peak, Math.abs(yl), Math.abs(yr));
  }
  const g = 0.5 / peak;
  const out = new Float32Array(frames * 2);
  for (let s = 0; s < frames; s++) {
    out[s * 2] = L[s]! * g;
    out[s * 2 + 1] = R[s]! * g;
  }
  return out;
}

export function musicWav(opts: MusicOptions): Buffer {
  const sampleRate = opts.sampleRate ?? 44100;
  return encodeWav({ sampleRate, channels: 2, samples: synthesizeMusic({ ...opts, sampleRate }) });
}
