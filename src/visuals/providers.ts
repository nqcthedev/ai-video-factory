import { ProviderError, ProviderUnavailableError } from "../core/errors.js";
import { type FetchLike, httpBuffer, httpJson } from "../core/http.js";
import { sharedLimiter } from "../core/rateLimiter.js";
import { withRetry } from "../core/retry.js";
import type { AppConfig, AppEnv, VisualProviderName } from "../config/schema.js";
import type { Scene } from "../stages/script.js";
import { toProviderError } from "../tts/providers.js";

/** What a visual provider contributes: a photo to use as the scene background, or nothing (abstract design). */
export interface VisualAsset {
  provider: VisualProviderName;
  /** Image bytes (photo providers) — the designed provider returns none and draws everything itself. */
  image?: { data: Buffer; ext: "png" | "jpg" | "webp" };
  /** Attribution to keep in the manifest / description. */
  credit?: { author?: string; url?: string; source: string };
  /** Billable units for the cost estimate. */
  images: number;
}

export interface VisualRequest {
  scene: Scene;
  index: number;
  orientation: "portrait" | "landscape";
  /** Already-used stock ids in this video, to avoid repeating the same photo. */
  usedIds: Set<string>;
}

export interface VisualProvider {
  readonly name: VisualProviderName;
  available(): Promise<{ ok: boolean; reason?: string }>;
  fetch(req: VisualRequest): Promise<VisualAsset>;
}

interface Deps {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  retries?: number;
}

/** Always available: the scene is drawn entirely by the local HTML/CSS designer. */
export class DesignedVisuals implements VisualProvider {
  readonly name = "designed" as const;
  async available() {
    return { ok: true };
  }
  async fetch(): Promise<VisualAsset> {
    return { provider: this.name, images: 1 };
  }
}

/**
 * Gemini image generation through the OpenAI-compatible endpoint (`/images/generations`,
 * `response_format: b64_json`). Free-tier keys report `limit: 0` for image models — that is
 * detected as an exhausted quota and the chain moves on immediately instead of retrying.
 */
export class GeminiImageVisuals implements VisualProvider {
  readonly name = "gemini-image" as const;
  constructor(
    private readonly env: Pick<AppEnv, "GEMINI_API_KEY" | "GEMINI_BASE_URL">,
    private readonly cfg: AppConfig["visuals"]["geminiImage"],
    private readonly deps: Deps = {},
  ) {}

  async available() {
    return this.env.GEMINI_API_KEY ? { ok: true } : { ok: false, reason: "GEMINI_API_KEY not set" };
  }

  async fetch(req: VisualRequest): Promise<VisualAsset> {
    if (!this.env.GEMINI_API_KEY) throw new ProviderUnavailableError(this.name, "GEMINI_API_KEY not set");
    const url = new URL("images/generations", this.env.GEMINI_BASE_URL).toString();
    const prompt = `${req.scene.visual.description}. ${this.cfg.style}. ${req.orientation === "portrait" ? "Vertical 9:16 composition" : "Wide 16:9 composition"}, main subject in the upper-middle, calm negative space at the bottom.`;
    const limiter = sharedLimiter("gemini-image", { maxPerMinute: 8 });
    try {
      const res = await withRetry(
        () =>
          limiter.schedule(() =>
            httpJson<{ data?: Array<{ b64_json?: string }> }>(url, {
              method: "POST",
              fetch: this.deps.fetch,
              timeoutMs: 180_000,
              headers: { authorization: `Bearer ${this.env.GEMINI_API_KEY}` },
              body: { model: this.cfg.model, prompt, n: 1, response_format: "b64_json" },
            }),
          ),
        { retries: this.deps.retries ?? 2, baseDelayMs: 4000, sleep: this.deps.sleep },
      );
      const b64 = res.data?.[0]?.b64_json;
      if (!b64) throw new ProviderError(this.name, "no image in response", { retryable: false });
      const data = Buffer.from(b64, "base64");
      return { provider: this.name, image: { data, ext: sniffExt(data) }, credit: { source: `AI-generated (${this.cfg.model})` }, images: 1 };
    } catch (err) {
      throw toProviderError(this.name, err);
    }
  }
}

interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string;
  photographer: string;
  photographer_url: string;
  alt?: string;
  src: { original: string; large2x: string; large: string; portrait: string; landscape: string };
}

/** Pexels photo search (https://www.pexels.com/api/documentation/#photos-search). Free; attribution kept in the manifest. */
export class PexelsVisuals implements VisualProvider {
  readonly name = "pexels" as const;
  constructor(
    private readonly env: Pick<AppEnv, "PEXELS_API_KEY">,
    private readonly cfg: AppConfig["visuals"]["pexels"],
    private readonly deps: Deps & { baseUrl?: string } = {},
  ) {}

  async available() {
    return this.env.PEXELS_API_KEY ? { ok: true } : { ok: false, reason: "PEXELS_API_KEY not set" };
  }

  async fetch(req: VisualRequest): Promise<VisualAsset> {
    if (!this.env.PEXELS_API_KEY) throw new ProviderUnavailableError(this.name, "PEXELS_API_KEY not set");
    const base = this.deps.baseUrl ?? "https://api.pexels.com/";
    const q = new URLSearchParams({ query: req.scene.visual.searchQuery, orientation: req.orientation, size: "large", per_page: String(this.cfg.perPage) });
    const limiter = sharedLimiter("pexels", { maxPerMinute: 60 });
    const headers = { authorization: this.env.PEXELS_API_KEY };
    try {
      const res = await withRetry(
        () => limiter.schedule(() => httpJson<{ photos?: PexelsPhoto[] }>(new URL(`v1/search?${q}`, base).toString(), { fetch: this.deps.fetch, headers })),
        { retries: this.deps.retries ?? 3, baseDelayMs: 2000, sleep: this.deps.sleep },
      );
      const wantPortrait = req.orientation === "portrait";
      const candidates = (res.photos ?? []).filter((p) => !req.usedIds.has(`pexels:${p.id}`));
      if (!candidates.length) throw new ProviderError(this.name, `no photos for "${req.scene.visual.searchQuery}"`, { retryable: false });
      // Prefer the right orientation and the highest resolution.
      candidates.sort((a, b) => score(b, wantPortrait) - score(a, wantPortrait));
      const photo = candidates[0]!;
      req.usedIds.add(`pexels:${photo.id}`);
      const img = await withRetry(() => httpBuffer(photo.src.large2x || photo.src.original, { fetch: this.deps.fetch, timeoutMs: 120_000 }), {
        retries: this.deps.retries ?? 3,
        baseDelayMs: 2000,
        sleep: this.deps.sleep,
      });
      return {
        provider: this.name,
        image: { data: img.data, ext: sniffExt(img.data) },
        credit: { author: photo.photographer, url: photo.url, source: "Pexels" },
        images: 1,
      };
    } catch (err) {
      throw toProviderError(this.name, err);
    }
  }
}

function score(p: PexelsPhoto, wantPortrait: boolean): number {
  const isPortrait = p.height > p.width;
  return (isPortrait === wantPortrait ? 1e9 : 0) + p.width * p.height;
}

export function sniffExt(buf: Buffer): "png" | "jpg" | "webp" {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return "jpg";
}

export function createVisualProviders(cfg: AppConfig, env: AppEnv, deps: Deps = {}): VisualProvider[] {
  const list = cfg.visuals.order.map((name): VisualProvider => {
    switch (name) {
      case "gemini-image":
        return new GeminiImageVisuals(env, cfg.visuals.geminiImage, deps);
      case "pexels":
        return new PexelsVisuals(env, cfg.visuals.pexels, deps);
      case "designed":
        return new DesignedVisuals();
    }
  });
  // The designed fallback is always last-resort, even if the user removed it from the order.
  if (!list.some((p) => p.name === "designed")) list.push(new DesignedVisuals());
  return list;
}
