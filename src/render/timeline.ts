/**
 * Timeline maths shared by audio stitching, captions and the ffmpeg graph.
 *
 * Narration for scene i plays at [audioStart_i, audioStart_i + duration_i]. Visual cuts sit in
 * the middle of the silence between scenes, and each xfade transition is centred on its cut,
 * so pictures change exactly between sentences, never mid-word.
 */
export interface TimelineScene {
  index: number;
  audioStart: number;
  audioDuration: number;
  /** Visual clip length fed to ffmpeg (includes transition overlap). */
  clipDuration: number;
  /** Output time where this scene's picture becomes the main one (cut point). */
  cutIn: number;
}

export interface Timeline {
  scenes: TimelineScene[];
  /** xfade offsets (output time when each transition starts). */
  transitionOffsets: number[];
  transitionDuration: number;
  total: number;
  leadIn: number;
  tail: number;
}

export function buildTimeline(
  audioDurations: number[],
  opts: { gapSec: number; transitionSec: number; leadInSec?: number; tailSec?: number },
): Timeline {
  if (!audioDurations.length) throw new Error("timeline needs at least one scene");
  const leadIn = opts.leadInSec ?? 0.25;
  const tail = opts.tailSec ?? 1.0;
  const starts: number[] = [];
  let t = leadIn;
  for (const d of audioDurations) {
    starts.push(t);
    t += d + opts.gapSec;
  }
  const total = starts[starts.length - 1]! + audioDurations[audioDurations.length - 1]! + tail;
  // Cut points: midway through the gap before each scene (scene 0 starts at 0).
  const cuts = starts.map((s, i) => (i === 0 ? 0 : s - opts.gapSec / 2));
  // Transitions can't be longer than the shortest neighbouring scene allows.
  const minSpan = Math.min(...cuts.map((c, i) => (i < cuts.length - 1 ? cuts[i + 1]! : total) - c));
  const T = Math.max(0, Math.min(opts.transitionSec, minSpan * 0.45));
  const n = audioDurations.length;
  const scenes: TimelineScene[] = audioDurations.map((d, i) => {
    const start = cuts[i]!;
    const end = i < n - 1 ? cuts[i + 1]! : total;
    const clip = end - start + (i > 0 ? T / 2 : 0) + (i < n - 1 ? T / 2 : 0);
    return { index: i, audioStart: starts[i]!, audioDuration: d, clipDuration: clip, cutIn: start };
  });
  const transitionOffsets = cuts.slice(1).map((c) => c - T / 2);
  return { scenes, transitionOffsets, transitionDuration: T, total, leadIn, tail };
}
