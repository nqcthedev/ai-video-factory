import { describe, expect, it } from "vitest";
import { buildAudioFilter, buildLoudnormArgs, buildRenderArgs, escapeFilterPath, parseLoudnormJson } from "../src/render/ffmpeg.js";
import { synthesizeMusic } from "../src/render/music.js";
import { buildTimeline } from "../src/render/timeline.js";

describe("timeline", () => {
  const tl = buildTimeline([3, 4, 5], { gapSec: 0.3, transitionSec: 0.4, leadInSec: 0.25, tailSec: 1 });

  it("places narration with lead-in, gaps and tail", () => {
    expect(tl.scenes.map((s) => s.audioStart)).toEqual([0.25, 3.55, 7.85]);
    expect(tl.total).toBeCloseTo(7.85 + 5 + 1);
  });

  it("centres transitions on cuts in the middle of the gaps and preserves total length", () => {
    expect(tl.transitionOffsets[0]).toBeCloseTo(3.55 - 0.15 - 0.2);
    const clipSum = tl.scenes.reduce((a, s) => a + s.clipDuration, 0);
    expect(clipSum - tl.transitionOffsets.length * tl.transitionDuration).toBeCloseTo(tl.total);
    // xfade offset k == cumulative clip length - (k+1)*T
    let acc = 0;
    tl.transitionOffsets.forEach((off, k) => {
      acc += tl.scenes[k]!.clipDuration;
      expect(off).toBeCloseTo(acc - (k + 1) * tl.transitionDuration);
    });
  });

  it("shortens transitions for very short scenes", () => {
    const t = buildTimeline([0.3, 0.3], { gapSec: 0.1, transitionSec: 1 });
    expect(t.transitionDuration).toBeLessThan(0.3);
  });
});

describe("ffmpeg command building", () => {
  const tl = buildTimeline([3, 4], { gapSec: 0.3, transitionSec: 0.4 });
  const args = buildRenderArgs({
    width: 1080, height: 1920, fps: 30, timeline: tl,
    scenes: [{ bg: "/j/bg0.png", fg: "/j/fg0.png", bgWidth: 1210, bgHeight: 2150 }, { bg: "/j/bg1.png", fg: "/j/fg1.png", bgWidth: 1210, bgHeight: 2150 }],
    transitions: ["smoothleft"], kenBurnsZoom: 1.08, audio: "/j/final.wav",
    subtitles: { file: "/j/captions.ass", fontsDir: "/repo/assets/fonts" }, output: "/j/out.mp4", crf: 20, preset: "medium",
  });
  const graph = args[args.indexOf("-filter_complex") + 1]!;

  it("wires inputs, Ken Burns, overlay, xfade and subtitles", () => {
    expect(args.filter((a) => a === "-i")).toHaveLength(5);
    expect(graph).toContain("scale=w='trunc(1080*(1+(0.0800)");
    expect(graph).toContain("crop=1080:1920");
    expect(graph).toContain(`xfade=transition=smoothleft:duration=${tl.transitionDuration.toFixed(3)}:offset=${tl.transitionOffsets[0]!.toFixed(3)}`);
    expect(graph).toContain("subtitles=filename='/j/captions.ass':fontsdir='/repo/assets/fonts'");
    expect(graph).not.toMatch(/fade=t=out/); // vertical shorts loop: no fade to black
    expect(graph).toContain("[fg0]"); // first scene: graphics visible from frame 0
    expect(graph).not.toMatch(/\[1:v\][^;]*fade=t=in/);
    expect(graph).toMatch(/\[3:v\][^;]*fade=t=in/);
    expect(args).toContain("+faststart");
    expect(args.slice(-1)[0]).toBe("/j/out.mp4");
    expect(args[args.indexOf("-map") + 1]).toBe("[vout]");
    expect(args).toContain("4:a");
  });

  it("escapes filter paths", () => {
    expect(escapeFilterPath("C:\\a,b's[1].ass")).toBe("C\\:/a\\,b\\'s\\[1\\].ass");
  });

  it("builds ducking + two-pass loudnorm", () => {
    const mix = { narration: "n.wav", music: "m.wav", musicVolumeDb: -24, duck: true, total: 10 };
    expect(buildAudioFilter(mix)).toContain("sidechaincompress");
    expect(buildAudioFilter({ ...mix, music: undefined })).not.toContain("amix");
    const p1 = buildLoudnormArgs({ ...mix, output: "o.wav" }, { integratedLufs: -14, truePeakDb: -1.5, lra: 11 });
    expect(p1.join(" ")).toContain("loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json");
    expect(p1.slice(-3)).toEqual(["-f", "null", "-"]);
    const measured = parseLoudnormJson('noise\n{\n"input_i" : "-22.1",\n"input_tp" : "-3.0",\n"input_lra" : "4.0",\n"input_thresh" : "-32.5",\n"target_offset" : "0.2"\n}\n');
    const p2 = buildLoudnormArgs({ ...mix, output: "o.wav" }, { integratedLufs: -14, truePeakDb: -1.5, lra: 11 }, measured);
    expect(p2.join(" ")).toContain("measured_I=-22.1:measured_TP=-3.0");
    expect(p2.join(" ")).toContain("linear=true");
    expect(p2.slice(-1)[0]).toBe("o.wav");
  });
});

describe("procedural music", () => {
  it("is deterministic, stereo, and peaks at -6 dBFS", () => {
    const a = synthesizeMusic({ seconds: 3, sampleRate: 8000, seed: 3 });
    const b = synthesizeMusic({ seconds: 3, sampleRate: 8000, seed: 3 });
    expect(a.length).toBe(3 * 8000 * 2);
    expect(a).toEqual(b);
    const peak = a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak).toBeCloseTo(0.5, 2);
  });
});

describe("output QA parsing", () => {
  it("reads loudness summary and black segments", async () => {
    const { parseQa } = await import("../src/render/ffmpeg.js");
    const stderr = "[blackdetect @ 0x1] black_start:0 black_end:0.4 black_duration:0.4\n[Parsed_ebur128_0 @ 0x2] Summary:\n\n  Integrated loudness:\n    I:         -14.0 LUFS\n    Threshold: -24.1 LUFS\n\n  True peak:\n    Peak:       -1.6 dBFS\n";
    expect(parseQa(stderr)).toEqual({ integratedLufs: -14, truePeakDb: -1.6, blackSegments: [{ start: 0, end: 0.4 }] });
  });
});
