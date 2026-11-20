import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildVideoResource, YouTubeUploader } from "../src/publish/youtube.js";
import { json, mockFetch, noSleep } from "./helpers.js";

const meta = {
  title: "Why Octopuses Are So Smart",
  description: "desc",
  tags: ["octopus"],
  categoryId: "27",
  privacyStatus: "public" as const,
  madeForKids: false,
  containsSyntheticMedia: true,
  defaultLanguage: "en",
};

describe("YouTube resource", () => {
  it("forces private when scheduling and validates dates", () => {
    const now = new Date("2026-11-20T00:00:00Z");
    const r = buildVideoResource({ ...meta, publishAt: "2026-12-01T15:00:00+07:00" }, now);
    expect(r.status).toEqual({ privacyStatus: "private", publishAt: "2026-12-01T08:00:00.000Z", selfDeclaredMadeForKids: false, containsSyntheticMedia: true });
    expect(r.snippet.defaultAudioLanguage).toBe("en");
    expect(() => buildVideoResource({ ...meta, publishAt: "2020-01-01T00:00:00Z" }, now)).toThrow(/past/);
    expect(buildVideoResource(meta, now).status.privacyStatus).toBe("public");
  });
});

describe("YouTube uploader (mocked API)", () => {
  function setup(failOnce = true) {
    const dir = mkdtempSync(join(tmpdir(), "avf-yt-"));
    const video = join(dir, "v.mp4");
    writeFileSync(video, Buffer.alloc(600 * 1024, 7)); // 600 KiB → 3 chunks of 256 KiB
    const thumb = join(dir, "t.png");
    writeFileSync(thumb, Buffer.from([0x89, 0x50]));
    let received = 0;
    let failed = !failOnce;
    const f = mockFetch([
      { match: (u) => u.startsWith("https://oauth2.googleapis.com/token"), respond: () => json({ access_token: "at", expires_in: 3600 }) },
      { match: (u, i) => u.includes("uploadType=resumable") && i?.method === "POST", respond: () => new Response(null, { status: 200, headers: { location: "https://upload.example/session/1" } }) },
      {
        match: (u) => u === "https://upload.example/session/1",
        respond: (_u, init) => {
          const range = new Headers(init!.headers).get("content-range")!;
          if (range.startsWith("bytes */")) return new Response(null, { status: 308, headers: received ? { range: `bytes=0-${received - 1}` } : {} });
          const [, a, b, total] = /bytes (\d+)-(\d+)\/(\d+)/.exec(range)!.map(Number) as number[];
          if (!failed && a! > 0) {
            failed = true;
            return new Response("backend error", { status: 503 });
          }
          received = b! + 1;
          if (received === total) return json({ id: "vid123", status: { privacyStatus: "private", publishAt: "2026-12-01T08:00:00Z" } });
          return new Response(null, { status: 308, headers: { range: `bytes=0-${b}` } });
        },
      },
      { match: (u) => u.includes("/thumbnails/set"), respond: () => json({ items: [] }) },
    ]);
    return { f, video, thumb };
  }

  it("refreshes the token, uploads in chunks, resumes after a 503 and sets the thumbnail", async () => {
    const { f, video, thumb } = setup(true);
    const up = new YouTubeUploader({ clientId: "c", clientSecret: "s", refreshToken: "r" }, { fetch: f, sleep: noSleep, chunkSize: 256 * 1024 });
    const res = await up.upload(video, { ...meta, publishAt: "2099-12-01T08:00:00Z" }, thumb);
    expect(res).toEqual({ videoId: "vid123", url: "https://youtu.be/vid123", privacyStatus: "private", publishAt: "2026-12-01T08:00:00Z", thumbnailSet: true });
    const tokenBody = String(f.calls[0]!.init!.body);
    expect(tokenBody).toContain("grant_type=refresh_token");
    expect(tokenBody).toContain("refresh_token=r");
    const session = f.calls[1]!;
    expect(new Headers(session.init!.headers).get("x-upload-content-length")).toBe(String(600 * 1024));
    expect(JSON.parse(String(session.init!.body)).status.privacyStatus).toBe("private");
    const ranges = f.calls.filter((c) => c.url.includes("session/1")).map((c) => new Headers(c.init!.headers).get("content-range"));
    expect(ranges).toEqual([
      "bytes 0-262143/614400",
      "bytes 262144-524287/614400", // 503
      "bytes */614400", // ask where to resume
      "bytes 262144-524287/614400",
      "bytes 524288-614399/614400",
    ]);
  });

  it("surfaces OAuth failures", async () => {
    const f = mockFetch([{ match: () => true, respond: () => json({ error: "invalid_grant" }, 400) }]);
    const up = new YouTubeUploader({ clientId: "c", clientSecret: "s", refreshToken: "bad" }, { fetch: f, sleep: noSleep });
    await expect(up.accessToken()).rejects.toThrow(/OAuth token refresh failed \(400\)/);
  });
});
