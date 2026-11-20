import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { AppConfig } from "../config/schema.js";
import type { Job } from "../core/job.js";
import type { FormatSpec } from "../formats.js";
import {
  analyzeOutput,
  type QaReport,
  type AudioMixInput,
  buildLoudnormArgs,
  buildRenderArgs,
  parseLoudnormJson,
  probeDuration,
  runFfmpeg,
} from "../render/ffmpeg.js";
import { musicWav } from "../render/music.js";
import type { Timeline } from "../render/timeline.js";
import { fontsDir } from "../visuals/designed/templates.js";
import type { VisualScene } from "./visuals.js";

export interface RenderStageData {
  video: string;
  audio: string;
  duration: number;
  sizeBytes: number;
  music: string | null;
  loudness: { inputLufs: number; targetLufs: number };
  encodeMs: number;
  /** Automatic check of the delivered file. */
  qa: QaReport & { passed: boolean; issues: string[] };
}

const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus"]);

/** Resolve `render.music.path` (file or folder → deterministic pick per job) or synthesize a bed. */
export function pickMusic(job: Job, cfg: AppConfig["render"]["music"], seconds: number): { path: string | null; loop: boolean } {
  if (!cfg.enabled) return { path: null, loop: false };
  if (cfg.path) {
    const p = resolve(cfg.path);
    if (existsSync(p) && statSync(p).isDirectory()) {
      const files = readdirSync(p).filter((f) => AUDIO_EXT.has(extname(f).toLowerCase())).sort();
      if (files.length) {
        const pick = files[[...job.manifest.id].reduce((a, c) => a + c.charCodeAt(0), 0) % files.length]!;
        return { path: join(p, pick), loop: true };
      }
    } else if (existsSync(p)) return { path: p, loop: true };
    job.log.warn("music path not found, using generated bed", { path: cfg.path });
  }
  const out = job.path("audio/music.wav");
  if (!existsSync(out)) {
    const seed = [...job.manifest.id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
    writeFileSync(out, musicWav({ seconds: seconds + 1, seed }));
  }
  return { path: out, loop: false };
}

export async function runRenderStage(
  job: Job,
  args: { format: FormatSpec; render: AppConfig["render"]; timeline: Timeline; visuals: VisualScene[]; narration: string; captions?: string; outputName: string },
): Promise<RenderStageData> {
  mkdirSync(job.path("output"), { recursive: true });
  const { timeline, render } = args;
  const music = pickMusic(job, render.music, timeline.total);
  const mix: AudioMixInput = {
    narration: job.path(args.narration),
    music: music.path ?? undefined,
    loopMusic: music.loop,
    musicVolumeDb: render.music.volumeDb,
    duck: render.music.duck,
    total: timeline.total,
  };
  const audioOut = job.path("audio/final.wav");
  // Pass 1: measure loudness of the full mix. Pass 2: apply linear normalization.
  const pass1 = await runFfmpeg(buildLoudnormArgs({ ...mix, output: audioOut }, render.loudness));
  const measured = parseLoudnormJson(pass1.stderr);
  await runFfmpeg(buildLoudnormArgs({ ...mix, output: audioOut }, render.loudness, measured));
  job.log.info("audio mixed & normalized", { inputLufs: measured.input_i, target: render.loudness.integratedLufs, music: music.path ? "on" : "off" });

  const video = `output/${args.outputName}.mp4`;
  const ffArgs = buildRenderArgs({
    width: args.format.width,
    height: args.format.height,
    fps: render.fps,
    timeline,
    scenes: args.visuals.map((v) => ({ bg: job.path(v.bg), fg: job.path(v.fg), bgWidth: v.bgWidth, bgHeight: v.bgHeight })),
    transitions: render.transition.types,
    kenBurnsZoom: render.kenBurnsZoom,
    audio: audioOut,
    subtitles: args.captions ? { file: job.path(args.captions), fontsDir: fontsDir() } : undefined,
    output: job.path(video),
    crf: render.crf,
    preset: render.preset,
  });
  writeFileSync(job.path("output/ffmpeg-command.txt"), ["ffmpeg", ...ffArgs.map((a) => (/[\s;'[\]]/.test(a) ? `"${a}"` : a))].join(" "));
  const t0 = Date.now();
  let lastLog = 0;
  await runFfmpeg(ffArgs, {
    onProgress: (sec) => {
      if (Date.now() - lastLog > 10_000) {
        lastLog = Date.now();
        job.log.info("encoding", { progress: `${Math.min(100, Math.round((sec / timeline.total) * 100))}%` });
      }
    },
  });
  const duration = await probeDuration(job.path(video));
  const report = await analyzeOutput(job.path(video));
  const issues: string[] = [];
  if (Math.abs(duration - timeline.total) > 0.25) issues.push(`duration ${duration.toFixed(2)}s != timeline ${timeline.total.toFixed(2)}s`);
  if (!(Math.abs(report.integratedLufs - render.loudness.integratedLufs) <= 1)) issues.push(`loudness ${report.integratedLufs} LUFS (target ${render.loudness.integratedLufs})`);
  if (report.truePeakDb > render.loudness.truePeakDb + 0.5) issues.push(`true peak ${report.truePeakDb} dBFS`);
  if (report.blackSegments.length) issues.push(`black frames at ${report.blackSegments.map((b) => `${b.start}-${b.end}s`).join(", ")}`);
  if (issues.length) job.log.warn("output QA found issues", { issues });
  else job.log.info("output QA passed", { lufs: report.integratedLufs, truePeak: report.truePeakDb, duration });
  return {
    video,
    audio: "audio/final.wav",
    duration,
    sizeBytes: statSync(job.path(video)).size,
    music: music.path,
    loudness: { inputLufs: Number(measured.input_i), targetLufs: render.loudness.integratedLufs },
    encodeMs: Date.now() - t0,
    qa: { ...report, passed: issues.length === 0, issues },
  };
}
