import { openSync, readSync, closeSync, statSync, readFileSync } from "node:fs";
import { HttpError } from "../core/errors.js";
import type { FetchLike } from "../core/http.js";
import { parseRetryAfter } from "../core/http.js";
import type { Logger } from "../core/logger.js";
import { nullLogger } from "../core/logger.js";
import { backoffDelay, sleep as realSleep } from "../core/retry.js";

/**
 * YouTube Data API v3 upload: OAuth2 refresh-token flow + resumable upload protocol
 * (https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol),
 * scheduled publishing via status.publishAt, and custom thumbnail.
 *
 * Covered by unit tests against a mocked API; NOT exercised against the live API in this repo.
 */
export interface YouTubeCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface UploadMetadata {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacyStatus: "private" | "unlisted" | "public";
  publishAt?: string;
  madeForKids: boolean;
  containsSyntheticMedia: boolean;
  defaultLanguage?: string;
}

export interface UploadResult {
  videoId: string;
  url: string;
  privacyStatus: string;
  publishAt?: string;
  thumbnailSet: boolean;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_BASE = "https://www.googleapis.com/upload/youtube/v3";
const CHUNK = 8 * 1024 * 1024; // must be a multiple of 256 KiB

export function buildVideoResource(meta: UploadMetadata, now = new Date()) {
  let privacyStatus = meta.privacyStatus;
  if (meta.publishAt) {
    const at = new Date(meta.publishAt);
    if (Number.isNaN(at.getTime())) throw new Error(`invalid publishAt "${meta.publishAt}"`);
    if (at.getTime() <= now.getTime()) throw new Error(`publishAt ${meta.publishAt} is in the past`);
    privacyStatus = "private"; // YouTube only schedules private videos
  }
  return {
    snippet: {
      title: meta.title.slice(0, 100),
      description: meta.description.slice(0, 5000),
      tags: meta.tags,
      categoryId: meta.categoryId,
      ...(meta.defaultLanguage ? { defaultLanguage: meta.defaultLanguage, defaultAudioLanguage: meta.defaultLanguage } : {}),
    },
    status: {
      privacyStatus,
      ...(meta.publishAt ? { publishAt: new Date(meta.publishAt).toISOString() } : {}),
      selfDeclaredMadeForKids: meta.madeForKids,
      containsSyntheticMedia: meta.containsSyntheticMedia,
    },
  };
}

export class YouTubeUploader {
  private readonly fetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: Logger;

  constructor(
    private readonly creds: YouTubeCredentials,
    deps: { fetch?: FetchLike; sleep?: (ms: number) => Promise<void>; logger?: Logger; chunkSize?: number } = {},
  ) {
    this.fetch = deps.fetch ?? globalThis.fetch;
    this.sleep = deps.sleep ?? realSleep;
    this.log = deps.logger ?? nullLogger;
    this.chunkSize = deps.chunkSize ?? CHUNK;
  }
  private readonly chunkSize: number;

  async accessToken(): Promise<string> {
    const res = await this.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        refresh_token: this.creds.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError({ status: res.status, body: text, url: TOKEN_URL, message: `OAuth token refresh failed (${res.status}): ${text.slice(0, 200)}` });
    const json = JSON.parse(text) as { access_token?: string };
    if (!json.access_token) throw new Error("OAuth response has no access_token");
    return json.access_token;
  }

  /** Step 1: create the upload session; returns the session URI from the Location header. */
  async startSession(token: string, meta: UploadMetadata, size: number): Promise<string> {
    const url = `${UPLOAD_BASE}/videos?uploadType=resumable&part=snippet,status`;
    const res = await this.fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-length": String(size),
        "x-upload-content-type": "video/mp4",
      },
      body: JSON.stringify(buildVideoResource(meta)),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new HttpError({ status: res.status, body, url, retryAfterMs: parseRetryAfter(res.headers, body) });
    }
    const location = res.headers.get("location");
    if (!location) throw new Error("YouTube did not return an upload session URI");
    return location;
  }

  /** Ask the server how many bytes it has (after an interruption). */
  async queryOffset(token: string, session: string, size: number): Promise<number | "done"> {
    const res = await this.fetch(session, { method: "PUT", redirect: "manual", headers: { authorization: `Bearer ${token}`, "content-range": `bytes */${size}` } });
    if (res.status === 200 || res.status === 201) return "done";
    if (res.status === 308) {
      const range = res.headers.get("range");
      return range ? Number(/bytes=0-(\d+)/.exec(range)?.[1] ?? -1) + 1 : 0;
    }
    throw new HttpError({ status: res.status, body: await res.text(), url: session });
  }

  /** Step 2: send the file in chunks, resuming from the server's offset after transient failures. */
  async uploadFile(token: string, session: string, file: string, maxRetries = 6): Promise<{ id: string; status?: { privacyStatus?: string; publishAt?: string } }> {
    const size = statSync(file).size;
    const fd = openSync(file, "r");
    try {
      let offset = 0;
      let failures = 0;
      for (;;) {
        const end = Math.min(offset + this.chunkSize, size) - 1;
        const buf = Buffer.alloc(end - offset + 1);
        readSync(fd, buf, 0, buf.length, offset);
        let res: Response;
        try {
          res = await this.fetch(session, {
            method: "PUT",
            redirect: "manual",
            headers: { authorization: `Bearer ${token}`, "content-type": "video/mp4", "content-range": `bytes ${offset}-${end}/${size}` },
            body: buf,
          });
        } catch (err) {
          res = new Response(String(err), { status: 599 });
        }
        if (res.status === 200 || res.status === 201) return (await res.json()) as { id: string };
        if (res.status === 308) {
          const range = res.headers.get("range");
          offset = range ? Number(/bytes=0-(\d+)/.exec(range)?.[1]) + 1 : 0;
          failures = 0;
          this.log.info("youtube upload progress", { pct: Math.round((offset / size) * 100) });
          continue;
        }
        const body = await res.text();
        const transient = res.status >= 500 || res.status === 429 || res.status === 408;
        if (!transient || ++failures > maxRetries) throw new HttpError({ status: res.status, body, url: session });
        await this.sleep(backoffDelay(failures, { baseDelayMs: 2000, maxDelayMs: 64_000 }));
        const o = await this.queryOffset(token, session, size);
        if (o === "done") throw new Error("upload completed but the final response was lost; check YouTube Studio");
        offset = o;
      }
    } finally {
      closeSync(fd);
    }
  }

  async setThumbnail(token: string, videoId: string, png: string): Promise<boolean> {
    const url = `${UPLOAD_BASE}/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`;
    const res = await this.fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "image/png" }, body: readFileSync(png) });
    if (!res.ok) {
      // Custom thumbnails need a verified channel; don't fail the whole publish for it.
      this.log.warn("thumbnail upload failed", { status: res.status, body: (await res.text()).slice(0, 200) });
      return false;
    }
    return true;
  }

  async upload(video: string, meta: UploadMetadata, thumbnail?: string): Promise<UploadResult> {
    const token = await this.accessToken();
    const size = statSync(video).size;
    const session = await this.startSession(token, meta, size);
    const resource = await this.uploadFile(token, session, video);
    const thumbnailSet = thumbnail ? await this.setThumbnail(token, resource.id, thumbnail) : false;
    return {
      videoId: resource.id,
      url: `https://youtu.be/${resource.id}`,
      privacyStatus: resource.status?.privacyStatus ?? buildVideoResource(meta).status.privacyStatus,
      publishAt: resource.status?.publishAt ?? meta.publishAt,
      thumbnailSet,
    };
  }
}
