import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { type LoadedConfig, parseConfig } from "./config/load.js";
import type { FormatName } from "./config/schema.js";
import { estimateCost } from "./core/cost.js";
import { Job, type JobOptions, slugify } from "./core/job.js";
import type { Logger } from "./core/logger.js";
import { FORMATS } from "./formats.js";
import { createLlmClient, type LlmClient } from "./llm/client.js";
import { YouTubeUploader } from "./publish/youtube.js";
import { runCaptionsStage, captionStyle, type CaptionsStageData } from "./stages/captions.js";
import { runRenderStage, type RenderStageData } from "./stages/render.js";
import { allScenes, generateScript, type ScriptResult } from "./stages/script.js";
import { runThumbnailStage, type ThumbnailStageData } from "./stages/thumbnail.js";
import { runVisualsStage, type VisualsStageData } from "./stages/visuals.js";
import { runVoiceStage, type VoiceStageData } from "./stages/voice.js";
import { createTtsProviders } from "./tts/providers.js";
import type { TtsProvider } from "./tts/types.js";
import { HtmlRenderer } from "./visuals/designed/renderer.js";
import { createVisualProviders, type VisualProvider } from "./visuals/providers.js";
import { THEME_PRESETS } from "./visuals/themes.js";

export interface PipelineDeps {
  llm?: LlmClient;
  /** TTS chain, or a factory per format (batch mode shares providers across jobs). */
  tts?: TtsProvider[] | ((format: FormatName) => TtsProvider[]);
  visuals?: VisualProvider[];
  renderer?: HtmlRenderer;
}

export interface MakeRequest {
  topic: string;
  format: FormatName;
  options?: JobOptions;
}

export interface PipelineResult {
  job: Job;
  video?: string;
  thumbnail?: string;
  publishedUrl?: string;
}

export function createJob(loaded: LoadedConfig, req: MakeRequest, log: Logger): Job {
  return Job.create(loaded.jobsDir, { topic: req.topic, format: req.format, config: loaded.config, options: req.options }, log);
}

/** Run (or resume) every stage of a job. Completed stages are read from the manifest, not redone. */
export async function runPipeline(job: Job, loaded: LoadedConfig, deps: PipelineDeps = {}): Promise<PipelineResult> {
  // Snapshot: resume uses the settings the job started with (re-validated so options added in
  // newer versions get their defaults).
  const cfg = parseConfig(job.manifest.config, `${job.manifest.id}/manifest.json config`);
  const env = loaded.env;
  const format = FORMATS[job.manifest.format];
  const renderer = deps.renderer ?? new HtmlRenderer();
  const ownsRenderer = !deps.renderer;
  job.manifest.status = "running";
  job.save();
  try {
    // 1. Script
    const scriptRes = (await job.runStage("script", async () => {
      const llm = deps.llm ?? createLlmClient(cfg.llm, env, { logger: job.log });
      const r = await generateScript(llm, {
        topic: job.manifest.topic,
        format,
        channel: cfg.channel,
        brief: job.manifest.options.brief,
        maxAttempts: cfg.llm.maxAttempts,
        logger: job.log,
        onCompletion: (n, text) => {
          mkdirSync(job.path("llm"), { recursive: true });
          writeFileSync(job.path(`llm/script-attempt-${n}.json`), text);
        },
      });
      job.writeJson("script.json", r.script);
      return { file: "script.json", attempts: r.attempts, usage: r.usage, model: r.model, warnings: r.warnings };
    })) as Omit<ScriptResult, "script"> & { file: string };
    const script = job.readJson<ScriptResult["script"]>("script.json");
    const scenes = allScenes(script);
    const theme = THEME_PRESETS[cfg.channel.theme === "auto" ? script.theme : cfg.channel.theme];

    // 2+3. Voice and visuals are independent — run them concurrently.
    const [voice, visuals] = await Promise.all([
      job.runStage("voice", () =>
        runVoiceStage(job, scenes, resolveTts(deps.tts, job.manifest.format) ?? createTtsProviders(cfg, env, loaded.modelsDir, {}, format.speechRate), {
          gapSec: cfg.tts.sceneGapSec,
          transitionSec: cfg.render.transition.duration,
        }),
      ) as Promise<VoiceStageData>,
      job.runStage("visuals", () =>
        runVisualsStage(job, {
          scenes,
          format,
          theme,
          channel: cfg.channel,
          providers: deps.visuals ?? createVisualProviders(cfg, env),
          renderer,
          concurrency: cfg.visuals.concurrency,
        }),
      ) as Promise<VisualsStageData>,
    ]);

    // 4. Captions
    const captions = (await job.runStage(
      "captions",
      async () => runCaptionsStage(job, voice.words, captionStyle(format, cfg.render.captions, theme)),
      { skip: !cfg.render.captions.enabled },
    )) as CaptionsStageData | undefined;

    // 5. Render
    const outputName = slugify(script.title, 60);
    const render = (await job.runStage("render", () =>
      runRenderStage(job, {
        format,
        render: cfg.render,
        timeline: voice.timeline,
        visuals: visuals.scenes,
        narration: voice.narration,
        captions: captions?.ass,
        outputName,
      }),
    )) as RenderStageData;

    // 6. Thumbnail
    const thumb = (await job.runStage(
      "thumbnail",
      () => runThumbnailStage(job, { script, format, theme, channel: cfg.channel, renderer, heroPhoto: visuals.scenes[0]?.photo }),
      { skip: !cfg.render.thumbnail },
    )) as ThumbnailStageData | undefined;

    job.manifest.outputs = {
      video: render.video,
      ...(thumb ? { thumbnail: thumb.thumbnail } : {}),
      ...(thumb?.cover ? { cover: thumb.cover } : {}),
      ...(captions ? { captionsAss: captions.ass, captionsSrt: captions.srt } : {}),
      script: "script.json",
    };
    job.manifest.providers = {
      llm: scriptRes.model,
      tts: voice.provider,
      voice: voice.voice,
      wordTimings: voice.scenes.every((s) => s.timing === "provider") ? "provider" : "estimated",
      visuals: visuals.imagesByProvider,
      ttsAttempts: voice.attempts,
    };
    job.manifest.cost = estimateCost(
      {
        llm: { model: scriptRes.model, ...scriptRes.usage },
        tts: { provider: voice.provider, characters: voice.characters },
        images: visuals.imagesByProvider,
      },
      cfg.costs,
    );
    job.save();

    // 7. Publish (opt-in)
    const wantPublish = job.manifest.options.publish ?? cfg.publish.youtube.enabled;
    const pub = (await job.runStage(
      "publish",
      async () => {
        if (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_CLIENT_SECRET || !env.YOUTUBE_REFRESH_TOKEN)
          throw new Error("YouTube publish requested but YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN are not set");
        const yt = cfg.publish.youtube;
        const uploader = new YouTubeUploader(
          { clientId: env.YOUTUBE_CLIENT_ID, clientSecret: env.YOUTUBE_CLIENT_SECRET, refreshToken: env.YOUTUBE_REFRESH_TOKEN },
          { logger: job.log },
        );
        const credits = visuals.scenes.filter((s) => s.credit?.author).map((s) => `${s.credit!.author} (${s.credit!.source})`);
        const description = credits.length ? `${script.description}\n\nPhotos: ${[...new Set(credits)].join(", ")}` : script.description;
        return uploader.upload(
          job.path(render.video),
          {
            title: script.title,
            description,
            tags: script.tags,
            categoryId: yt.categoryId,
            privacyStatus: yt.privacyStatus,
            publishAt: job.manifest.options.publishAt ?? yt.publishAt,
            madeForKids: yt.madeForKids,
            containsSyntheticMedia: yt.containsSyntheticMedia,
            defaultLanguage: yt.defaultLanguage,
          },
          thumb ? job.path(thumb.thumbnail) : undefined,
        );
      },
      { skip: !wantPublish },
    )) as { url: string } | undefined;

    job.manifest.status = "done";
    job.save();
    return { job, video: job.path(render.video), thumbnail: thumb ? job.path(thumb.thumbnail) : undefined, publishedUrl: pub?.url };
  } catch (err) {
    job.manifest.status = "failed";
    job.manifest.error = (err as Error)?.message ?? String(err);
    job.save();
    throw err;
  } finally {
    if (ownsRenderer) await renderer.close();
  }
}

function resolveTts(t: PipelineDeps["tts"], format: FormatName): TtsProvider[] | undefined {
  return typeof t === "function" ? t(format) : t;
}

/** Copy the deliverables of a finished job into a folder (used for samples/). */
export function exportJob(job: Job, dest: string, name: string): string[] {
  const out: string[] = [];
  for (const [key, rel] of Object.entries(job.manifest.outputs)) {
    if (!existsSync(job.path(rel))) continue;
    const ext = rel.split(".").pop();
    const suffix = key === "video" ? "" : `.${key.replace(/^captions(Ass|Srt)$/, "captions")}`;
    const target = `${dest}/${name}${suffix}.${ext}`;
    copyFileSync(job.path(rel), target);
    out.push(target);
  }
  copyFileSync(job.path("manifest.json"), `${dest}/${name}.manifest.json`);
  out.push(`${dest}/${name}.manifest.json`);
  return out;
}
