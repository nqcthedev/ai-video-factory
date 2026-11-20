import type { Script } from "../src/stages/script.js";

export function sampleScript(overrides: Partial<Script> = {}): Script {
  const scene = (n: number, layout: "hero" | "stat" | "list" | "quote" = "hero") => ({
    narration: `Scene ${n} explains one clear idea with a vivid example that you can picture right away.`,
    keyword: layout === "stat" ? "500M" : `IDEA ${n}`,
    subtitle: "A short supporting line",
    visual: {
      description: "A close-up photo of an octopus on a coral reef, soft light",
      searchQuery: "octopus reef",
      icon: "brain",
      layout,
      ...(layout === "list" ? { points: ["First", "Second"] } : {}),
    },
  });
  return {
    title: "Why Octopuses Are So Smart",
    description: "Octopuses have nine brains. Here is why that matters.\n\n#shorts #octopus",
    tags: ["octopus", "science", "animals", "ocean", "brain"],
    thumbnailText: "9 BRAINS",
    theme: "ocean",
    hook: scene(0),
    scenes: [scene(1, "stat"), scene(2, "list"), scene(3, "quote"), scene(4), scene(5), scene(6)],
    ...overrides,
  };
}

/** Minimal fetch mock: route by "METHOD url-substring". */
export function mockFetch(routes: Array<{ match: (url: string, init?: RequestInit) => boolean; respond: (url: string, init?: RequestInit) => Response | Promise<Response> }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const r = routes.find((x) => x.match(url, init));
    if (!r) throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
    return r.respond(url, init);
  };
  return Object.assign(fn, { calls });
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export const noSleep = async () => undefined;
