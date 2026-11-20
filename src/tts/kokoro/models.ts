import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Logger } from "../../core/logger.js";
import { KOKORO_FILES, KokoroEngine } from "./engine.js";

/**
 * Kokoro-82M v1.0 ONNX weights (Apache-2.0) as published by the kokoro-onnx project on GitHub
 * releases. Checksums pin the exact files this repo was tested with.
 */
export const KOKORO_DOWNLOADS = [
  {
    file: KOKORO_FILES.model,
    url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx",
    sha256: "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5",
    bytes: 325_532_387,
  },
  {
    file: KOKORO_FILES.voices,
    url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
    sha256: "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
    bytes: 28_214_398,
  },
] as const;

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export async function downloadKokoro(modelsDir: string, log: Logger, opts: { force?: boolean } = {}): Promise<string> {
  const dir = join(modelsDir, "kokoro");
  mkdirSync(dir, { recursive: true });
  for (const d of KOKORO_DOWNLOADS) {
    const target = join(dir, d.file);
    if (!opts.force && existsSync(target) && statSync(target).size === d.bytes) {
      log.info(`${d.file}: already present`);
      continue;
    }
    log.info(`downloading ${d.file} (${(d.bytes / 1e6).toFixed(0)} MB)`, { url: d.url });
    const res = await fetch(d.url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${d.url}`);
    const tmp = `${target}.part`;
    let got = 0;
    let lastPct = -10;
    const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
    body.on("data", (c: Buffer) => {
      got += c.length;
      const pct = Math.floor((got / d.bytes) * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        log.info(`  ${d.file} ${pct}%`);
      }
    });
    await pipeline(body, createWriteStream(tmp));
    const hash = sha256File(tmp);
    if (hash !== d.sha256) throw new Error(`checksum mismatch for ${d.file}: got ${hash}`);
    renameSync(tmp, target);
  }
  KokoroEngine.ensureTimedModel(dir);
  log.info("kokoro ready", { dir });
  return dir;
}
