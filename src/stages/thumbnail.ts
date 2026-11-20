import { pathToFileURL } from "node:url";
import type { AppConfig } from "../config/schema.js";
import type { Job } from "../core/job.js";
import type { FormatSpec } from "../formats.js";
import type { HtmlRenderer } from "../visuals/designed/renderer.js";
import { thumbnailHtml } from "../visuals/designed/templates.js";
import type { Theme } from "../visuals/themes.js";
import type { Script } from "./script.js";

export interface ThumbnailStageData {
  thumbnail: string;
  cover?: string;
}

/** 1280×720 YouTube thumbnail (+ a 1080×1920 cover for Shorts/Reels/TikTok). */
export async function runThumbnailStage(
  job: Job,
  args: { script: Script; format: FormatSpec; theme: Theme; channel: AppConfig["channel"]; renderer: HtmlRenderer; heroPhoto?: string },
): Promise<ThumbnailStageData> {
  const common = {
    theme: args.theme,
    text: args.script.thumbnailText,
    icon: args.script.hook.visual.icon,
    channel: args.channel.name,
    seed: 11,
    photoUrl: args.heroPhoto ? pathToFileURL(job.path(args.heroPhoto)).href : undefined,
  };
  await args.renderer.render(thumbnailHtml({ ...common, width: 1280, height: 720 }), job.path("output/thumbnail.png"), { width: 1280, height: 720 });
  const out: ThumbnailStageData = { thumbnail: "output/thumbnail.png" };
  if (args.format.height > args.format.width) {
    await args.renderer.render(thumbnailHtml({ ...common, width: 1080, height: 1920 }), job.path("output/cover.png"), { width: 1080, height: 1920 });
    out.cover = "output/cover.png";
  }
  return out;
}
