import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "playwright";

/**
 * HTML → PNG with headless Chromium (Playwright). One browser per process, reused for every
 * scene; pages are created per render so concurrent renders don't interfere.
 */
export class HtmlRenderer {
  private browser?: Promise<Browser>;
  private readonly tmp = mkdtempSync(join(tmpdir(), "avf-html-"));
  private n = 0;

  private async getBrowser(): Promise<Browser> {
    this.browser ??= import("playwright").then((pw) => pw.chromium.launch());
    return this.browser;
  }

  async render(html: string, outPath: string, opts: { width: number; height: number; transparent?: boolean }): Promise<string> {
    const browser = await this.getBrowser();
    const page = await browser.newPage({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: 1 });
    try {
      // Loading from a file:// URL (not setContent) lets the page reference local fonts/images.
      const file = join(this.tmp, `p${this.n++}.html`);
      writeFileSync(file, html);
      await page.goto(pathToFileURL(file).href, { waitUntil: "load" });
      await page.evaluate("window.__fit ? window.__fit() : document.fonts.ready");
      await page.screenshot({ path: outPath, type: "png", omitBackground: !!opts.transparent, clip: { x: 0, y: 0, width: opts.width, height: opts.height } });
      return outPath;
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    if (this.browser) await (await this.browser).close().catch(() => undefined);
    this.browser = undefined;
    rmSync(this.tmp, { recursive: true, force: true });
  }
}
