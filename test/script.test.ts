import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config/schema.js";
import { FORMATS } from "../src/formats.js";
import type { ChatMessage, LlmClient } from "../src/llm/client.js";
import { buildPrompt, extractJson, generateScript, normalizeScript, ScriptSchema, validateScript } from "../src/stages/script.js";
import { sampleScript } from "./helpers.js";

const channel = ConfigSchema.parse({}).channel;

function fakeLlm(replies: string[]): LlmClient & { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  return {
    model: "fake-model",
    seen,
    async chat(messages) {
      seen.push(messages.map((m) => ({ ...m })));
      const text = replies.shift();
      if (text === undefined) throw new Error("no more replies");
      return { text, model: "fake-model", usage: { promptTokens: 100, completionTokens: 50 } };
    },
  };
}

/** A script whose word count fits the short format budget. */
function validShort() {
  const s = sampleScript();
  const words = "Octopuses can open jars, escape tanks and recognise faces, and scientists are still working out exactly how they manage it".split(" ");
  const narr = (n: number) => words.slice(0, n).join(" ") + ".";
  return { ...s, hook: { ...s.hook, narration: narr(16) }, scenes: s.scenes.map((sc) => ({ ...sc, narration: narr(16) })) };
}

describe("script schema & validation", () => {
  it("accepts a well-formed script", () => {
    expect(ScriptSchema.safeParse(sampleScript()).success).toBe(true);
    expect(validateScript(validShort(), FORMATS.short)).toEqual([]);
  });

  it("rejects bad shapes", () => {
    const bad = { ...sampleScript(), theme: "neon" };
    expect(ScriptSchema.safeParse(bad).success).toBe(false);
    const noScenes = { ...sampleScript(), scenes: [] };
    expect(ScriptSchema.safeParse(noScenes).success).toBe(false);
  });

  it("flags editorial problems the schema cannot express", () => {
    const s = validShort();
    s.scenes[0]!.visual.layout = "stat";
    s.scenes[0]!.keyword = "BIG IDEA";
    s.scenes[1]!.visual.points = undefined;
    s.hook.keyword = "far too many words here";
    s.title = "x".repeat(80);
    const problems = validateScript(s, FORMATS.short).join("\n");
    expect(problems).toMatch(/layout "stat" needs a number/);
    expect(problems).toMatch(/layout "list" needs 2-3/);
    expect(problems).toMatch(/1-3 words/);
    expect(problems).toMatch(/Title must be at most 70/);
  });

  it("flags word budget violations", () => {
    const short = sampleScript();
    expect(validateScript(short, FORMATS.long).join()).toMatch(/too short/);
  });

  it("normalizes tags and unknown icons", () => {
    const s = sampleScript({ tags: ["#octopus", "octopus", " ocean "] });
    s.hook.visual.icon = "definitely-not-an-icon";
    const n = normalizeScript(s);
    expect(n.tags).toEqual(["octopus", "ocean"]);
    expect(n.hook.visual.icon).toBe("sparkles");
  });

  it("extracts JSON from fenced or chatty completions", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here it is: {"a":{"b":2}} hope it helps')).toEqual({ a: { b: 2 } });
    expect(() => extractJson("no json")).toThrow();
  });

  it("puts the format budget and channel voice in the prompt", () => {
    const [sys, user] = buildPrompt("Why octopuses are so smart", FORMATS.short, channel, "mention camouflage");
    expect(sys!.content).toContain(channel.name);
    expect(user!.content).toContain(`${FORMATS.short.words[0]}-${FORMATS.short.words[1]} spoken words`);
    expect(user!.content).toContain("mention camouflage");
    expect(user!.content).toContain("#shorts");
  });
});

describe("generateScript retry loop", () => {
  it("retries on invalid JSON and schema errors, feeding problems back", async () => {
    const llm = fakeLlm(["not json at all", JSON.stringify({ title: "x" }), JSON.stringify(validShort())]);
    const r = await generateScript(llm, { topic: "octopus", format: FORMATS.short, channel, maxAttempts: 3 });
    expect(r.attempts).toBe(3);
    expect(r.warnings).toEqual([]);
    expect(r.usage).toEqual({ promptTokens: 300, completionTokens: 150 });
    const secondCall = llm.seen[1]!;
    expect(secondCall[secondCall.length - 1]!.content).toMatch(/not valid JSON/);
    const thirdCall = llm.seen[2]!;
    expect(thirdCall[thirdCall.length - 1]!.content).toMatch(/does not match the required shape/);
  });

  it("accepts the best soft-invalid script after the last attempt", async () => {
    const tooShort = sampleScript();
    const llm = fakeLlm([JSON.stringify(tooShort), JSON.stringify(tooShort)]);
    const r = await generateScript(llm, { topic: "octopus", format: FORMATS.long, channel, maxAttempts: 2 });
    expect(r.warnings.join()).toMatch(/too short/);
  });

  it("fails when no attempt is even schema-valid", async () => {
    const llm = fakeLlm(["{}", "{}"]);
    await expect(generateScript(llm, { topic: "x", format: FORMATS.short, channel, maxAttempts: 2 })).rejects.toThrow(/valid script/);
  });
});
