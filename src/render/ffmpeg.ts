import { spawn } from "node:child_process";
import type { Timeline } from "./timeline.js";

export class FfmpegError extends Error {
  constructor(message: string, readonly stderr: string, readonly code: number | null) {
    super(message);
    this.name = "FfmpegError";
  }
}

/** Run ffmpeg/ffprobe; resolves with stderr (ffmpeg logs there). Reports progress via `-progress pipe:1`. */
export function runFfmpeg(
  args: string[],
  opts: { bin?: string; onProgress?: (seconds: number) => void; signal?: AbortSignal } = {},
): Promise<{ stderr: string; stdout: string }> {
  const bin = opts.bin ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], signal: opts.signal });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 400_000) stderr = stderr.slice(-200_000);
    });
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      if (stdout.length > 400_000) stdout = stdout.slice(-200_000);
      const m = /out_time_us=(\d+)/g;
      let last: RegExpExecArray | null = null;
      for (let x = m.exec(s); x; x = m.exec(s)) last = x;
      if (last && opts.onProgress) opts.onProgress(Number(last[1]) / 1e6);
    });
    child.on("error", (e) => reject(new FfmpegError(`${bin} failed to start: ${e.message}`, stderr, null)));
    child.on("close", (code) => {
      if (code === 0) resolve({ stderr, stdout });
      else reject(new FfmpegError(`${bin} exited with code ${code}: ${stderr.split("\n").filter(Boolean).slice(-6).join(" | ")}`, stderr, code));
    });
  });
}

export async function probeDuration(file: string): Promise<number> {
  const { stdout } = await runFfmpeg(["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], {
    bin: process.env.FFPROBE_PATH ?? "ffprobe",
  });
  return Number(stdout.trim());
}

/** Escape a path for use inside a filtergraph option value (subtitles=..., fontsdir=...). */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

export interface SceneLayers {
  bg: string;
  fg: string;
  bgWidth: number;
  bgHeight: number;
}

export interface VideoGraphInput {
  width: number;
  height: number;
  fps: number;
  timeline: Timeline;
  scenes: SceneLayers[];
  transitions: string[];
  kenBurnsZoom: number;
  audio: string;
  subtitles?: { file: string; fontsDir: string };
  output: string;
  crf: number;
  preset: string;
  /** Fade to black over the last 0.5 s (default: only for landscape). */
  fadeOut?: boolean;
}

/**
 * Build the single-pass ffmpeg command: per scene a Ken-Burns background (zoom in/out,
 * alternating) with the foreground graphics easing in on top, xfade transitions between
 * scenes, burned-in ASS captions, then H.264/AAC with faststart.
 *
 * Each PNG is decoded once and repeated with the `loop` filter (cheaper than `-loop 1`).
 */
export function buildRenderArgs(o: VideoGraphInput): string[] {
  const { width: W, height: H, fps } = o;
  const n = o.scenes.length;
  if (n !== o.timeline.scenes.length) throw new Error(`scene count mismatch: ${n} layers vs ${o.timeline.scenes.length} timeline scenes`);
  const args: string[] = ["-y", "-hide_banner", "-nostats", "-progress", "pipe:1"];
  for (const s of o.scenes) args.push("-i", s.bg, "-i", s.fg);
  args.push("-i", o.audio);
  const audioIdx = n * 2;
  const f: string[] = [];
  o.scenes.forEach((s, i) => {
    const D = o.timeline.scenes[i]!.clipDuration;
    const frames = Math.max(1, Math.ceil(D * fps));
    const z0 = i % 2 === 0 ? 1 : o.kenBurnsZoom;
    const z1 = i % 2 === 0 ? o.kenBurnsZoom : 1;
    // Scale the (oversized) background to W*z(t) wide, then centre-crop W×H. Even sizes keep the
    // crop offset integral, so the zoom stays centred without sub-pixel wobble.
    const zExpr = `(${z0}+(${(z1 - z0).toFixed(4)})*min(t/${D.toFixed(3)},1))`;
    const drift = i % 4 === 1 ? 1 : i % 4 === 3 ? -1 : 0; // gentle horizontal drift on some scenes
    const xExpr = `(iw-${W})/2${drift ? `${drift > 0 ? "+" : "-"}(iw-${W})/2*0.6*min(t/${D.toFixed(3)},1)` : ""}`;
    f.push(
      `[${i * 2}:v]format=rgb24,loop=loop=${frames - 1}:size=1:start=0,setpts=N/${fps}/TB,` +
        `scale=w='trunc(${W}*${zExpr}/2)*2':h='trunc(${H}*${zExpr}/2)*2':eval=frame:flags=bicubic,` +
        `crop=${W}:${H}:x='${xExpr}':y='(ih-${H})/2',setsar=1[bg${i}]`,
    );
    // The first scene's graphics are on screen from frame 0 (the first frame doubles as a
    // preview/thumbnail and must never be empty); later scenes ease in during the transition.
    const animate = i > 0;
    f.push(
      `[${i * 2 + 1}:v]format=rgba,loop=loop=${frames - 1}:size=1:start=0,setpts=N/${fps}/TB` +
        `${animate ? ",fade=t=in:st=0.12:d=0.45:alpha=1" : ""}[fg${i}]`,
    );
    // Ease-out slide up (cubic) during the first 0.6 s.
    const y = animate ? `'if(lt(t,0.6),${Math.round(H * 0.025)}*pow(1-t/0.6,3),0)'` : "0";
    f.push(`[bg${i}][fg${i}]overlay=x=0:y=${y}:eval=frame:shortest=1,fps=${fps},format=yuv420p[v${i}]`);
  });
  let last = "v0";
  o.timeline.transitionOffsets.forEach((off, k) => {
    const type = o.transitions[k % o.transitions.length] ?? "fade";
    const out = k === n - 2 ? "vx" : `x${k + 1}`;
    f.push(`[${last}][v${k + 1}]xfade=transition=${type}:duration=${o.timeline.transitionDuration.toFixed(3)}:offset=${off.toFixed(3)}[${out}]`);
    last = out;
  });
  if (n === 1) f.push(`[v0]null[vx]`);
  const tail: string[] = [];
  if (o.subtitles) tail.push(`subtitles=filename='${escapeFilterPath(o.subtitles.file)}':fontsdir='${escapeFilterPath(o.subtitles.fontsDir)}'`);
  // No fade from black at the start (first frame = preview). Vertical shorts loop, so they
  // don't fade out either; 16:9 videos get a short fade to black at the very end.
  if (o.fadeOut ?? W > H) tail.push(`fade=t=out:st=${Math.max(0, o.timeline.total - 0.5).toFixed(3)}:d=0.5`);
  tail.push("format=yuv420p");
  f.push(`[vx]${tail.join(",")}[vout]`);
  args.push(
    "-filter_complex", f.join(";"),
    "-map", "[vout]", "-map", `${audioIdx}:a`,
    "-t", o.timeline.total.toFixed(3),
    "-r", String(fps),
    "-c:v", "libx264", "-preset", o.preset, "-crf", String(o.crf), "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-g", String(fps * 2), "-bf", "2",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-movflags", "+faststart",
    o.output,
  );
  return args;
}

export interface AudioMixInput {
  narration: string;
  music?: string;
  /** Loop the music file if shorter than the video. */
  loopMusic?: boolean;
  musicVolumeDb: number;
  duck: boolean;
  total: number;
}

/** Filtergraph for voice + optional ducked music bed (shared by the analysis and final passes). */
export function buildAudioFilter(o: AudioMixInput): string {
  const voice = `[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${o.total.toFixed(3)}`;
  if (!o.music) return `${voice}[mix]`;
  const fadeOut = Math.max(0, o.total - 2.5).toFixed(3);
  const music = `[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${o.total.toFixed(3)},volume=${o.musicVolumeDb}dB,afade=t=in:d=1.5,afade=t=out:st=${fadeOut}:d=2.5`;
  if (!o.duck) return `${voice}[v];${music}[m];[v][m]amix=inputs=2:normalize=0:duration=first[mix]`;
  return [
    `${voice},asplit=2[v][sc]`,
    `${music}[m]`,
    // Duck the music ~8-10 dB while the narrator speaks; slow release so it swells back between lines.
    `[m][sc]sidechaincompress=threshold=0.02:ratio=6:attack=40:release=600:makeup=1[md]`,
    `[v][md]amix=inputs=2:normalize=0:duration=first[mix]`,
  ].join(";");
}

export function audioInputs(o: AudioMixInput): string[] {
  const a = ["-i", o.narration];
  if (o.music) a.push(...(o.loopMusic ? ["-stream_loop", "-1"] : []), "-i", o.music);
  return a;
}

export interface LoudnormMeasurement {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

export function parseLoudnormJson(stderr: string): LoudnormMeasurement {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("loudnorm analysis produced no JSON");
  return JSON.parse(stderr.slice(start, end + 1)) as LoudnormMeasurement;
}

/** Two-pass EBU R128 loudness normalization (pass 1 measures, pass 2 applies linearly). */
export function buildLoudnormArgs(
  o: AudioMixInput & { output: string },
  target: { integratedLufs: number; truePeakDb: number; lra: number },
  measured?: LoudnormMeasurement,
): string[] {
  const base = `I=${target.integratedLufs}:TP=${target.truePeakDb}:LRA=${target.lra}`;
  const ln = measured
    ? `loudnorm=${base}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true:print_format=summary`
    : `loudnorm=${base}:print_format=json`;
  const graph = `${buildAudioFilter(o)};[mix]${ln},aresample=48000[out]`;
  const args = ["-y", "-hide_banner", "-nostats", ...audioInputs(o), "-filter_complex", graph, "-map", "[out]", "-t", o.total.toFixed(3)];
  return measured ? [...args, "-c:a", "pcm_s16le", "-ar", "48000", o.output] : [...args, "-f", "null", "-"];
}

export interface QaReport {
  integratedLufs: number;
  truePeakDb: number;
  blackSegments: Array<{ start: number; end: number }>;
}

/** Parse ebur128 summary + blackdetect lines from one `-f null` analysis pass. */
export function parseQa(stderr: string): QaReport {
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const integratedLufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1] ?? NaN);
  const truePeakDb = Number(/Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(summary)?.[1] ?? NaN);
  const blackSegments = [...stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => ({ start: Number(m[1]), end: Number(m[2]) }));
  return { integratedLufs, truePeakDb, blackSegments };
}

/** Decode the finished file once: loudness (EBU R128, true peak) and black-frame detection. */
export async function analyzeOutput(file: string): Promise<QaReport> {
  const { stderr } = await runFfmpeg(["-hide_banner", "-nostats", "-i", file, "-vf", "blackdetect=d=0.3:pix_th=0.06", "-af", "ebur128=peak=true", "-f", "null", "-"]);
  return parseQa(stderr);
}
