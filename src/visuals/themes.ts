import type { ThemeName } from "../config/schema.js";

export interface Theme {
  name: ThemeName;
  /** Background gradient stops, dark → lighter. */
  bg: [string, string, string];
  /** Soft colour blobs behind the content. */
  blobs: [string, string, string];
  /** Accent: highlighted caption word, numbers, icon glow. Must stay readable next to white. */
  accent: string;
  /** Text on top of the accent colour. */
  onAccent: string;
}

export const THEME_PRESETS: Record<ThemeName, Theme> = {
  midnight: { name: "midnight", bg: ["#070A1F", "#141A45", "#2B1660"], blobs: ["#5B3CFF", "#00B3FF", "#C13CFF"], accent: "#FFD23F", onAccent: "#141A45" },
  ocean: { name: "ocean", bg: ["#021526", "#04345A", "#06627A"], blobs: ["#00C2FF", "#00E0B8", "#3157FF"], accent: "#FFD23F", onAccent: "#04345A" },
  sunset: { name: "sunset", bg: ["#1A0B24", "#4A1340", "#8A2A3B"], blobs: ["#FF5E62", "#FF9A3C", "#C8336E"], accent: "#FFD23F", onAccent: "#4A1340" },
  forest: { name: "forest", bg: ["#04140E", "#0B3324", "#145238"], blobs: ["#25C27A", "#9BE15D", "#0FA3A3"], accent: "#C6F45E", onAccent: "#0B3324" },
  ember: { name: "ember", bg: ["#140806", "#3A1208", "#6B1F0A"], blobs: ["#FF6A00", "#FF2E2E", "#FFB000"], accent: "#FFC93C", onAccent: "#3A1208" },
  mono: { name: "mono", bg: ["#0A0A0B", "#18181B", "#27272A"], blobs: ["#52525B", "#3F3F46", "#71717A"], accent: "#FFE14D", onAccent: "#18181B" },
};
