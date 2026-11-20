import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { AppConfig } from "../config/schema.js";
import { ProviderError } from "../core/errors.js";
import type { Job } from "../core/job.js";
import { mapWithConcurrency } from "../core/pool.js";
import type { FormatSpec } from "../formats.js";
import type { HtmlRenderer } from "../visuals/designed/renderer.js";
import { backgroundHtml, foregroundHtml } from "../visuals/designed/templates.js";
import type { VisualAsset, VisualProvider } from "../visuals/providers.js";
import type { Theme } from "../visuals/themes.js";
import type { Scene } from "./script.js";

/** Background layers are rendered larger than the frame so the Ken Burns zoom never upscales. */
export const BG_OVERSCAN = 1.12;

export interface VisualScene {
  index: number;
  provider: string;
  bg: string;
  fg: string;
  bgWidth: number;
  bgHeight: number;
  photo?: string;
  credit?: VisualAsset["credit"];
}

export interface VisualsStageData {
  theme: string;
  scenes: VisualScene[];
  imagesByProvider: Record<string, number>;
}

const even = (n: number) => Math.round(n / 2) * 2;

export async function runVisualsStage(
  job: Job,
  args: {
    scenes: Scene[];
    format: FormatSpec;
    theme: Theme;
    channel: AppConfig["channel"];
    providers: VisualProvider[];
    renderer: HtmlRenderer;
    concurrency: number;
  },
): Promise<VisualsStageData> {
  mkdirSync(job.path("visuals"), { recursive: true });
  const { width: W, height: H } = args.format;
  const bgW = even(W * BG_OVERSCAN);
  const bgH = even(H * BG_OVERSCAN);
  const orientation = H > W ? "portrait" : "landscape";
  const usedIds = new Set<string>();
  // A provider that reports an exhausted quota / missing key is skipped for the rest of the job.
  const disabled = new Map<string, string>();
  for (const p of args.providers) {
    const a = await p.available();
    if (!a.ok) disabled.set(p.name, a.reason ?? "unavailable");
  }
  const counts: Record<string, number> = {};

  const results = await mapWithConcurrency(args.scenes, args.concurrency, async (scene, i): Promise<VisualScene> => {
    let asset: VisualAsset | undefined;
    for (const p of args.providers) {
      if (disabled.has(p.name)) continue;
      try {
        asset = await p.fetch({ scene, index: i, orientation, usedIds });
        break;
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        job.log.warn(`visual provider ${p.name} failed for scene ${i}`, { error: err.message.slice(0, 200) });
        if (err.exhausted || !err.retryable) {
          if (err.exhausted) disabled.set(p.name, err.message);
        }
      }
    }
    asset ??= { provider: "designed", images: 1 };
    counts[asset.provider] = (counts[asset.provider] ?? 0) + asset.images;
    const id = String(i).padStart(2, "0");
    let photo: string | undefined;
    if (asset.image) {
      photo = `visuals/scene-${id}-photo.${asset.image.ext}`;
      writeFileSync(job.path(photo), asset.image.data);
    }
    const bg = `visuals/scene-${id}-bg.png`;
    const fg = `visuals/scene-${id}-fg.png`;
    await args.renderer.render(
      backgroundHtml({ width: bgW, height: bgH, theme: args.theme, seed: i + 1, icon: scene.visual.icon, photoUrl: photo ? pathToFileURL(job.path(photo)).href : undefined }),
      job.path(bg),
      { width: bgW, height: bgH },
    );
    await args.renderer.render(
      foregroundHtml({
        width: W,
        height: H,
        theme: args.theme,
        layout: scene.visual.layout,
        keyword: scene.keyword,
        subtitle: scene.subtitle,
        points: scene.visual.points,
        icon: scene.visual.icon,
        index: i,
        total: args.scenes.length,
        channel: args.channel.name,
        onPhoto: !!photo,
      }),
      job.path(fg),
      { width: W, height: H, transparent: true },
    );
    job.log.info(`visual scene ${i + 1}/${args.scenes.length}`, { provider: asset.provider, layout: scene.visual.layout });
    return { index: i, provider: asset.provider, bg, fg, bgWidth: bgW, bgHeight: bgH, photo, credit: asset.credit };
  });
  const scenes = results.map((r) => {
    if (r.status === "rejected") throw r.reason;
    return r.value;
  });
  return { theme: args.theme.name, scenes, imagesByProvider: counts };
}
