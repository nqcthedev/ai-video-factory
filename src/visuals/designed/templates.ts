import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Theme } from "../themes.js";

const require = createRequire(import.meta.url);

export function fontsDir(): string {
  // src/visuals/designed → repo root/assets/fonts (also valid from dist/visuals/designed)
  return join(dirname(new URL(import.meta.url).pathname), "..", "..", "..", "assets", "fonts");
}

const iconCache = new Map<string, string>();
/** Inline Lucide SVG (ISC licence) with size/stroke overrides. */
export function iconSvg(name: string, opts: { size: number; stroke?: number; color?: string }): string {
  let raw = iconCache.get(name);
  if (raw === undefined) {
    try {
      raw = readFileSync(join(dirname(require.resolve("lucide-static/package.json")), "icons", `${name}.svg`), "utf8");
    } catch {
      raw = readFileSync(join(dirname(require.resolve("lucide-static/package.json")), "icons", "sparkles.svg"), "utf8");
    }
    raw = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
    iconCache.set(name, raw);
  }
  return raw
    .replace(/width="24"/, `width="${opts.size}"`)
    .replace(/height="24"/, `height="${opts.size}"`)
    .replace(/stroke-width="2"/, `stroke-width="${opts.stroke ?? 1.75}"`)
    .replace(/stroke="currentColor"/, `stroke="${opts.color ?? "currentColor"}"`);
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Deterministic pseudo-random numbers so a scene always renders identically. */
export function seeded(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10_000) / 10_000;
  };
}

function fontFaces(): string {
  const d = fontsDir();
  const face = (family: string, file: string, weight: number) =>
    `@font-face{font-family:"${family}";src:url("${pathToFileURL(join(d, file)).href}") format("opentype");font-weight:${weight};font-display:block}`;
  return [
    face("AVF Display", "InterDisplay-Black.otf", 900),
    face("AVF Display", "InterDisplay-ExtraBold.otf", 800),
    face("AVF Text", "Inter-Medium.otf", 500),
    face("AVF Text", "Inter-SemiBold.otf", 600),
    face("AVF Text", "Inter-Bold.otf", 700),
  ].join("\n");
}

/** Shrinks every [data-fit] element until it fits its box (max-width and max-height in px). */
const FIT_SCRIPT = `
window.__fit = async () => {
  await document.fonts.ready;
  for (const el of document.querySelectorAll('[data-fit]')) {
    const maxW = Number(el.dataset.maxw || el.parentElement.clientWidth);
    const maxH = Number(el.dataset.maxh || 99999);
    let size = parseFloat(getComputedStyle(el).fontSize);
    const min = Number(el.dataset.min || 40);
    while (size > min && (el.scrollWidth > maxW + 1 || el.offsetHeight > maxH + 1)) {
      size -= 4;
      el.style.fontSize = size + 'px';
    }
  }
  return true;
};`;

export function page(width: number, height: number, css: string, body: string, transparent = false): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFaces()}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${width}px;height:${height}px;overflow:hidden;background:${transparent ? "transparent" : "#000"}}
body{font-family:"AVF Text",sans-serif;color:#fff;-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
${css}
</style><script>${FIT_SCRIPT}</script></head><body>${body}</body></html>`;
}

// ─────────────────────────────── background layer ───────────────────────────────

export interface BgOptions {
  width: number;
  height: number;
  theme: Theme;
  seed: number;
  icon: string;
  /** Optional photo (AI or stock) used instead of the abstract background. */
  photoUrl?: string;
}

const GRAIN = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.55 0'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>`,
)}")`;

export function backgroundHtml(o: BgOptions): string {
  const r = seeded(o.seed + 7);
  const { width: W, height: H, theme: t } = o;
  const big = Math.max(W, H);
  const angle = Math.round(140 + r() * 60);
  const blob = (color: string, size: number, x: number, y: number, op: number) =>
    `<div class="blob" style="width:${size}px;height:${size}px;left:${x - size / 2}px;top:${y - size / 2}px;background:radial-gradient(circle, ${color} 0%, ${color}00 68%);opacity:${op}"></div>`;
  // Rotate which blob colour dominates and nudge the hue per scene, so consecutive scenes
  // feel distinct while staying inside the theme.
  const k = o.seed % 3;
  const c = [t.blobs[k]!, t.blobs[(k + 1) % 3]!, t.blobs[(k + 2) % 3]!];
  const hue = Math.round(((o.seed * 37) % 29) - 14);
  const blobs = o.photoUrl
    ? ""
    : [
        blob(c[0], big * (0.8 + r() * 0.25), W * (0.1 + r() * 0.8), H * (0.1 + r() * 0.3), 0.6),
        blob(c[1], big * (0.6 + r() * 0.25), W * (0.15 + r() * 0.8), H * (0.45 + r() * 0.25), 0.42),
        blob(c[2], big * (0.5 + r() * 0.2), W * (0.2 + r() * 0.6), H * (0.8 + r() * 0.15), 0.38),
      ].join("");
  const ringSize = Math.round(Math.min(W, H) * (0.9 + r() * 0.5));
  const ring =
    o.photoUrl || o.seed % 2 === 0
      ? ""
      : `<div class="ring" style="width:${ringSize}px;height:${ringSize}px;left:${Math.round(W * (r() > 0.5 ? 0.55 : -0.2))}px;top:${Math.round(H * (0.5 + r() * 0.2))}px"></div>`;
  const iconSize = Math.round(Math.min(W, H) * 1.05);
  const ix = Math.round(W * (r() > 0.5 ? 0.55 : -0.15));
  const iy = Math.round(H * (0.18 + r() * 0.35));
  const css = `
.base{position:absolute;inset:0;background:linear-gradient(${angle}deg, ${t.bg[0]} 0%, ${t.bg[1]} 55%, ${t.bg[2]} 100%)}
.blob{position:absolute;border-radius:50%;filter:blur(40px)}
.hue{position:absolute;inset:0;filter:hue-rotate(${hue}deg) saturate(1.08)}
.ring{position:absolute;border-radius:50%;border:${Math.round(Math.min(W, H) * 0.012)}px solid ${t.accent}22;box-shadow:0 0 120px ${t.accent}18, inset 0 0 120px ${t.accent}10}
.grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.045) 2px,transparent 2px),linear-gradient(90deg,rgba(255,255,255,.045) 2px,transparent 2px);background-size:${Math.round(Math.min(W, H) / 12)}px ${Math.round(Math.min(W, H) / 12)}px;-webkit-mask-image:radial-gradient(ellipse at 50% 40%, #000 0%, transparent 70%)}
.ghost{position:absolute;left:${ix}px;top:${iy}px;transform:rotate(${Math.round(-14 + r() * 28)}deg);opacity:.07;color:#fff}
.photo{position:absolute;inset:0;background-size:cover;background-position:center}
.scrim{position:absolute;inset:0;background:linear-gradient(180deg, rgba(0,0,0,.55) 0%, rgba(0,0,0,.25) 35%, rgba(0,0,0,.35) 60%, rgba(0,0,0,.75) 100%)}
.tint{position:absolute;inset:0;background:linear-gradient(${angle}deg, ${t.bg[1]}88, transparent 60%);mix-blend-mode:multiply}
.grain{position:absolute;inset:0;background-image:${GRAIN};opacity:.09;mix-blend-mode:overlay}
.vignette{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 45%, transparent 45%, rgba(0,0,0,.55) 100%)}`;
  const body = o.photoUrl
    ? `<div class="photo" style="background-image:url('${o.photoUrl}')"></div><div class="tint"></div><div class="scrim"></div><div class="grain"></div><div class="vignette"></div>`
    : `<div class="hue"><div class="base"></div>${blobs}</div>${ring}<div class="grid"></div><div class="ghost">${iconSvg(o.icon, { size: iconSize, stroke: 1.25 })}</div><div class="grain"></div><div class="vignette"></div>`;
  return page(W, H, css, body);
}

// ─────────────────────────────── foreground layer ───────────────────────────────

export interface FgOptions {
  width: number;
  height: number;
  theme: Theme;
  layout: "hero" | "stat" | "list" | "quote";
  keyword: string;
  subtitle?: string;
  points?: string[];
  icon: string;
  index: number;
  total: number;
  channel: string;
  /** Stronger text shadows when sitting on a photo. */
  onPhoto?: boolean;
}

function progress(o: FgOptions, vertical: boolean): string {
  const segs = Array.from({ length: o.total }, (_, i) => `<i class="${i <= o.index ? "on" : ""}"></i>`).join("");
  return `<div class="top ${vertical ? "v" : "h"}"><div class="progress">${segs}</div><div class="kicker">${esc(o.channel)}</div></div>`;
}

/** Highlight the number part of a stat keyword ("500M" → accent number + white suffix). */
function statMarkup(keyword: string): string {
  const m = /^(.*?)(\d[\d.,/]*(?:\s?[-–]\s?\d[\d.,/]*)?)(.*)$/.exec(keyword.trim());
  if (!m) return esc(keyword);
  return `${m[1] ? `<span class="aff">${esc(m[1].trim())}</span> ` : ""}<span class="num">${esc(m[2]!)}</span>${m[3] ? `<span class="aff">${esc(m[3])}</span>` : ""}`;
}

export function foregroundHtml(o: FgOptions): string {
  const vertical = o.height > o.width;
  const { theme: t } = o;
  const S = vertical ? 1.06 : 0.8; // type scale for 16:9
  const shadow = o.onPhoto ? "0 4px 18px rgba(0,0,0,.65), 0 2px 4px rgba(0,0,0,.5)" : "0 8px 40px rgba(0,0,0,.35)";
  const css = `
.top{position:absolute;display:flex;flex-direction:column;gap:18px}
.top.v{left:0;right:0;top:150px;align-items:center}
.top.h{left:120px;top:84px;align-items:flex-start}
.progress{display:flex;gap:10px}
.progress i{display:block;width:${vertical ? 54 : 46}px;height:8px;border-radius:8px;background:rgba(255,255,255,.22)}
.progress i.on{background:${t.accent}}
.kicker{font:700 ${Math.round(26 * (vertical ? 1 : 0.85))}px "AVF Text";letter-spacing:.32em;text-transform:uppercase;color:rgba(255,255,255,.72)}
.stage{position:absolute;display:flex;flex-direction:column;justify-content:center}
.stage.v{left:80px;right:80px;top:270px;height:870px;align-items:center;text-align:center}
.stage.h{left:120px;width:1060px;top:150px;height:720px;align-items:flex-start;text-align:left}
.badge{width:${Math.round((vertical ? 270 : 220) * S)}px;height:${Math.round((vertical ? 270 : 220) * S)}px;border-radius:50%;display:grid;place-items:center;color:${t.accent};
  background:radial-gradient(circle at 35% 30%, rgba(255,255,255,.20), rgba(255,255,255,.06) 60%);border:2px solid rgba(255,255,255,.22);
  box-shadow:0 0 0 14px rgba(255,255,255,.04), 0 0 90px ${t.accent}55, inset 0 2px 0 rgba(255,255,255,.25);margin-bottom:${Math.round(56 * S)}px}
.h .badge{display:none}
.side{position:absolute;right:150px;top:200px;width:560px;height:560px;border-radius:50%;display:grid;place-items:center;color:${t.accent};
  background:radial-gradient(circle at 35% 30%, rgba(255,255,255,.20), rgba(255,255,255,.05) 62%);border:2px solid rgba(255,255,255,.2);
  box-shadow:0 0 0 22px rgba(255,255,255,.035), 0 0 0 46px rgba(255,255,255,.02), 0 0 140px ${t.accent}44, inset 0 2px 0 rgba(255,255,255,.25)}
h1{font-family:"AVF Display";font-weight:900;font-size:${Math.round(178 * S)}px;line-height:.93;letter-spacing:-.025em;text-transform:uppercase;text-shadow:${shadow};max-width:100%}
h1 .hl{color:${t.accent}}
h1 .box{display:inline-block;color:${t.onAccent};background:${t.accent};padding:.02em .16em .06em;border-radius:.12em;text-shadow:none;transform:rotate(-2deg);box-shadow:0 18px 50px rgba(0,0,0,.35)}
.boxed .badge{width:${Math.round(300 * S)}px;height:${Math.round(300 * S)}px}
.rule{width:${Math.round(120 * S)}px;height:${Math.round(12 * S)}px;border-radius:12px;background:${t.accent};margin:${Math.round(40 * S)}px 0 ${Math.round(34 * S)}px;box-shadow:0 0 30px ${t.accent}88}
.sub{font:600 ${Math.round((vertical ? 50 : 56) * S)}px/1.22 "AVF Text";color:rgba(255,255,255,.88);text-shadow:${shadow};max-width:${vertical ? 860 : 980}px}
.stat .num{color:${t.accent};font-size:1.55em;letter-spacing:-.04em;text-shadow:0 0 60px ${t.accent}66, ${shadow}}
.stat .aff{font-size:.9em}
.stat h1{line-height:.9}
.list h1{font-size:${Math.round(124 * S)}px}
.rows{display:flex;flex-direction:column;gap:${Math.round(22 * S)}px;margin-top:${Math.round(46 * S)}px;width:${vertical ? "100%" : "960px"}}
.row{display:flex;align-items:center;gap:${Math.round(28 * S)}px;padding:${Math.round(26 * S)}px ${Math.round(34 * S)}px;border-radius:${Math.round(30 * S)}px;text-align:left;
  background:linear-gradient(135deg, rgba(255,255,255,.13), rgba(255,255,255,.05));border:2px solid rgba(255,255,255,.16);box-shadow:0 14px 40px rgba(0,0,0,.25)}
.row b{flex:none;width:${Math.round((vertical ? 76 : 84) * S)}px;height:${Math.round((vertical ? 76 : 84) * S)}px;border-radius:50%;display:grid;place-items:center;background:${t.accent};color:${t.onAccent};font:900 ${Math.round(40 * S)}px "AVF Display"}
.row span{font:700 ${Math.round((vertical ? 52 : 62) * S)}px/1.15 "AVF Text";text-shadow:${shadow}}
.quote .mark{font:900 ${Math.round(260 * S)}px/0.6 "AVF Display";color:${t.accent};height:${Math.round(120 * S)}px;text-shadow:0 0 50px ${t.accent}55}
.quote h1{font-size:${Math.round(136 * S)}px;line-height:1}
`;
  const kw = esc(o.keyword);
  const sub = o.subtitle ? `<p class="sub" data-fit data-min="30" data-maxh="${Math.round(200 * S)}">${esc(o.subtitle)}</p>` : "";
  const maxW = vertical ? 900 : 1040;
  let inner: string;
  switch (o.layout) {
    case "stat":
      inner = `<h1 data-fit data-maxw="${maxW}" data-maxh="${vertical ? 520 : 420}" data-min="60">${statMarkup(o.keyword)}</h1><div class="rule"></div>${sub}`;
      break;
    case "list": {
      const rows = (o.points ?? []).slice(0, 3).map((p, i) => `<div class="row"><b>${i + 1}</b><span>${esc(p)}</span></div>`).join("");
      inner = `<h1 data-fit data-maxw="${maxW}" data-maxh="${vertical ? 300 : 240}" data-min="60">${kw}</h1><div class="rows">${rows}</div>`;
      break;
    }
    case "quote":
      inner = `<div class="mark">“</div><h1 data-fit data-maxw="${maxW}" data-maxh="${vertical ? 440 : 380}" data-min="60">${kw}</h1><div class="rule"></div>${sub}`;
      break;
    default:
      if (o.index % 2 === 1) {
        // Variant: last word on an accent "tape" box — breaks up runs of hero scenes.
        const words = o.keyword.trim().split(/\s+/);
        const last = words.pop()!;
        const kwBoxed = `${words.length ? `${esc(words.join(" "))}<br>` : ""}<span class="box">${esc(last)}</span>`;
        inner = `<h1 data-fit data-maxw="${maxW}" data-maxh="${vertical ? 460 : 400}" data-min="60" style="line-height:1.05">${kwBoxed}</h1><div class="rule" style="opacity:0"></div>${sub}`;
        break;
      }
      inner = `<h1 data-fit data-maxw="${maxW}" data-maxh="${vertical ? 440 : 380}" data-min="60">${kw}</h1><div class="rule"></div>${sub}`;
  }
  const badge = `<div class="badge">${iconSvg(o.icon, { size: Math.round((vertical ? 138 : 112) * S), stroke: 1.75 })}</div>`;
  const side = vertical ? "" : `<div class="side">${iconSvg(o.icon, { size: 250, stroke: 1.5 })}</div>`;
  const body = `${progress(o, vertical)}<div class="stage ${vertical ? "v" : "h"} ${o.layout}${o.layout === "hero" && o.index % 2 === 1 ? " boxed" : ""}">${o.layout === "list" ? "" : badge}${inner}</div>${side}`;
  return page(o.width, o.height, css, body, true);
}

// ─────────────────────────────── thumbnail ───────────────────────────────

export function thumbnailHtml(o: { width: number; height: number; theme: Theme; text: string; icon: string; channel: string; seed: number; photoUrl?: string }): string {
  const bg = backgroundHtml({ width: o.width, height: o.height, theme: o.theme, seed: o.seed, icon: o.icon, photoUrl: o.photoUrl });
  const vertical = o.height > o.width;
  const words = o.text.trim().split(/\s+/);
  // Accent the most "important" word: the longest one, or a number if present.
  const numIdx = words.findIndex((w) => /\d/.test(w));
  const accentIdx = numIdx >= 0 ? numIdx : words.reduce((best, w, i) => (w.length > words[best]!.length ? i : best), 0);
  const title = words.map((w, i) => (i === accentIdx ? `<span class="hl">${esc(w)}</span>` : esc(w))).join(" ");
  const css = `
.fgx{position:absolute;inset:0}
.t{position:absolute;${vertical ? "left:80px;right:80px;top:520px;text-align:center" : "left:70px;top:70px;width:760px;height:560px;display:flex;align-items:center"}}
.t h1{font-family:"AVF Display";font-weight:900;font-size:${vertical ? 190 : 150}px;line-height:.92;letter-spacing:-.03em;text-transform:uppercase;color:#fff;
  text-shadow:0 10px 0 rgba(0,0,0,.25), 0 14px 50px rgba(0,0,0,.55);-webkit-text-stroke:2px rgba(0,0,0,.15)}
.t h1 .hl{color:${o.theme.onAccent};background:${o.theme.accent};padding:0 .12em;border-radius:.08em;box-decoration-break:clone;-webkit-box-decoration-break:clone;text-shadow:none}
.ic{position:absolute;${vertical ? "left:50%;top:170px;transform:translateX(-50%);width:300px;height:300px" : "right:70px;top:120px;width:420px;height:420px"};border-radius:50%;display:grid;place-items:center;color:${o.theme.accent};
  background:radial-gradient(circle at 35% 30%, rgba(255,255,255,.24), rgba(255,255,255,.06) 62%);border:3px solid rgba(255,255,255,.25);box-shadow:0 0 0 18px rgba(255,255,255,.05), 0 0 140px ${o.theme.accent}66}
.ch{position:absolute;${vertical ? "left:0;right:0;text-align:center;bottom:240px" : "left:76px;bottom:52px"};font:700 26px "AVF Text";letter-spacing:.3em;text-transform:uppercase;color:rgba(255,255,255,.75)}`;
  const fg = `<div class="fgx"><div class="ic">${iconSvg(o.icon, { size: vertical ? 160 : 220, stroke: 1.6 })}</div><div class="t"><h1 data-fit data-maxw="${vertical ? 920 : 760}" data-maxh="${vertical ? 760 : 560}" data-min="70">${title}</h1></div><div class="ch">${esc(o.channel)}</div></div>`;
  // Merge: inject fg css + markup into the background page.
  return bg.replace("</style>", `${css}</style>`).replace("</body>", `${fg}</body>`);
}
