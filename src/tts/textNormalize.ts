/**
 * Spoken-form normalization shared by TTS engines: the captions keep the original words,
 * but the voice should say "1.8M" as "1.8 million" and "%" as "percent".
 */
const UNITS: Record<string, string> = { K: "thousand", M: "million", B: "billion", T: "trillion" };

export function normalizeForSpeech(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s*&\s*/g, " and ")
    .replace(/(\d)\s*%/g, "$1 percent")
    .replace(/\$(\d[\d,]*(?:\.\d+)?)\s*([KMBT])\b/g, (_, n: string, u: string) => `${n} ${UNITS[u]} dollars`)
    .replace(/\$(\d[\d,]*(?:\.\d+)?)/g, "$1 dollars")
    .replace(/(\d(?:[\d,]*\d)?(?:\.\d+)?)([KMBT])\+?(?=\W|$)/g, (_, n: string, u: string) => `${n} ${UNITS[u]}`)
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/\be\.g\./gi, "for example")
    .replace(/\bi\.e\./gi, "that is")
    .replace(/\bvs\.?(?=\s)/gi, "versus")
    .replace(/\bDr\.(?=\s)/g, "Doctor")
    .replace(/\bMr\.(?=\s)/g, "Mister")
    .replace(/\bMrs\.(?=\s)/g, "Missus")
    .replace(/\s+/g, " ")
    .trim();
}

/** A word as displayed in captions, plus the punctuation that follows it. */
export interface DisplayWord {
  /** Text shown on screen (punctuation stripped from the edges, e.g. `"brain,"` → `brain`). */
  text: string;
  /** Raw token as written in the narration. */
  raw: string;
  /** Punctuation that ends a clause after this word ("," "." "?" ...), if any. */
  breakAfter: string;
}

const LEADING = /^[\s"'“‘(\[«¿¡]+/;
const TRAILING = /[\s"'”’)\]»,.;:!?…—-]+$/;

export function splitDisplayWords(text: string): DisplayWord[] {
  const out: DisplayWord[] = [];
  for (const raw of text.replace(/—/g, " — ").split(/\s+/)) {
    if (!raw) continue;
    if (/^[—–-]+$/.test(raw)) {
      // A free-standing dash is a pause, not a word.
      const prev = out[out.length - 1];
      if (prev && !prev.breakAfter) prev.breakAfter = "—";
      continue;
    }
    const core = raw.replace(LEADING, "").replace(TRAILING, "");
    if (!core) {
      const prev = out[out.length - 1];
      if (prev && !prev.breakAfter) prev.breakAfter = punctOf(raw);
      continue;
    }
    out.push({ text: core, raw, breakAfter: punctOf(raw.slice(raw.indexOf(core) + core.length)) });
  }
  return out;
}

function punctOf(tail: string): string {
  const m = /[.!?…]|[,;:—]/.exec(tail);
  if (!m) return "";
  // Sentence enders win over commas ("wow,!" is unlikely, "really?!" → "?").
  const enders = /[.!?…]/.exec(tail);
  return enders ? enders[0] : m[0];
}

export function isSentenceEnd(p: string): boolean {
  return p === "." || p === "!" || p === "?" || p === "…";
}
