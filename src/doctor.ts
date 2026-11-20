import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LoadedConfig } from "./config/load.js";
import { runFfmpeg } from "./render/ffmpeg.js";
import { KOKORO_FILES } from "./tts/kokoro/engine.js";
import { createTtsProviders } from "./tts/providers.js";
import { fontsDir } from "./visuals/designed/templates.js";
import { createVisualProviders } from "./visuals/providers.js";

export interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

/** Environment health check. Offline by default; `online` adds cheap, quota-free API probes. */
export async function runDoctor(loaded: LoadedConfig, opts: { online?: boolean } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, status: Check["status"], detail: string) => checks.push({ name, status, detail });
  const { config: cfg, env } = loaded;

  const major = Number(process.versions.node.split(".")[0]);
  add("node", major >= 20 ? "ok" : "fail", `v${process.versions.node}${major >= 20 ? "" : " (need >= 20)"}`);

  try {
    const { stdout } = await runFfmpeg(["-hide_banner", "-version"]).then((r) => ({ stdout: r.stdout }));
    const v = /ffmpeg version (\S+)/.exec(stdout)?.[1] ?? "?";
    const { stdout: filters } = await runFfmpeg(["-hide_banner", "-filters"]);
    const need = ["xfade", "subtitles", "loudnorm", "sidechaincompress", "zoompan", "overlay"];
    const missing = need.filter((f) => !new RegExp(`\\s${f}\\s`).test(filters));
    const { stdout: enc } = await runFfmpeg(["-hide_banner", "-encoders"]);
    if (!/libx264/.test(enc)) missing.push("libx264");
    add("ffmpeg", missing.length ? "fail" : "ok", missing.length ? `${v}; missing: ${missing.join(", ")}` : `${v} (xfade, libass, loudnorm, libx264)`);
  } catch (e) {
    add("ffmpeg", "fail", `not found (${(e as Error).message.slice(0, 80)}) — install ffmpeg >= 5`);
  }
  try {
    await runFfmpeg(["-version"], { bin: process.env.FFPROBE_PATH ?? "ffprobe" });
    add("ffprobe", "ok", "found");
  } catch {
    add("ffprobe", "fail", "not found");
  }

  try {
    const pw = await import("playwright");
    const b = await pw.chromium.launch();
    add("chromium (playwright)", "ok", b.version());
    await b.close();
  } catch (e) {
    add("chromium (playwright)", "fail", `${(e as Error).message.split("\n")[0]} — run: npx playwright install chromium`);
  }

  const fonts = ["InterDisplay-Black.otf", "Inter-SemiBold.otf"].every((f) => existsSync(join(fontsDir(), f)));
  add("fonts", fonts ? "ok" : "fail", fonts ? fontsDir() : `missing in ${fontsDir()}`);

  for (const p of createTtsProviders({ ...cfg, tts: { ...cfg.tts, order: ["kokoro", "gemini", "openai", "elevenlabs"] } }, env, loaded.modelsDir)) {
    const a = await p.available();
    const inOrder = cfg.tts.order.includes(p.name as never);
    const label = `tts:${p.name}${inOrder ? "" : " (not in order)"}`;
    if (p.name === "kokoro" && a.ok) {
      const timed = existsSync(join(loaded.modelsDir, "kokoro", KOKORO_FILES.timedModel));
      add(label, "ok", `models in ${join(loaded.modelsDir, "kokoro")}${timed ? "" : " (timed model is created on first run)"}`);
    } else add(label, a.ok ? "ok" : inOrder ? "warn" : "warn", a.ok ? "configured" : a.reason ?? "unavailable");
  }
  for (const p of createVisualProviders({ ...cfg, visuals: { ...cfg.visuals, order: ["gemini-image", "pexels", "designed"] } }, env)) {
    const a = await p.available();
    add(`visuals:${p.name}`, a.ok ? "ok" : "warn", a.ok ? "configured" : a.reason ?? "unavailable");
  }

  const llmKey = cfg.llm.provider === "gemini" ? env.GEMINI_API_KEY : env.OPENAI_API_KEY;
  add(`llm:${cfg.llm.provider}`, llmKey ? "ok" : "fail", llmKey ? `model ${cfg.llm.model}` : `${cfg.llm.provider === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY"} not set`);
  const yt = env.YOUTUBE_CLIENT_ID && env.YOUTUBE_CLIENT_SECRET && env.YOUTUBE_REFRESH_TOKEN;
  add("publish:youtube", yt ? "ok" : "warn", yt ? "OAuth credentials present (untested live)" : "not configured (optional)");

  if (opts.online && llmKey) {
    // GET /models does not consume generation quota.
    const base = cfg.llm.baseUrl ?? (cfg.llm.provider === "gemini" ? env.GEMINI_BASE_URL : env.OPENAI_BASE_URL);
    try {
      const res = await fetch(new URL("models", base.endsWith("/") ? base : `${base}/`), { headers: { authorization: `Bearer ${llmKey}` }, signal: AbortSignal.timeout(20_000) });
      const body = (await res.json().catch(() => ({}))) as { data?: Array<{ id: string }> };
      const ids = (body.data ?? []).map((m) => m.id.replace(/^models\//, ""));
      add("llm:online", res.ok ? (ids.includes(cfg.llm.model) ? "ok" : "warn") : "fail", res.ok ? `${ids.length} models listed; ${cfg.llm.model} ${ids.includes(cfg.llm.model) ? "available" : "NOT listed"}` : `HTTP ${res.status}`);
    } catch (e) {
      add("llm:online", "fail", (e as Error).message);
    }
  }
  return checks;
}
