import { describe, expect, it } from "vitest";
import bundle from "../../knowledge/bundle.json" with { type: "json" };
import type { LlmRequest } from "../ports/llm";
import { LLM_PROFILES } from "../adapters/llm-profiles";
import { respond, type RespondEvent } from "../core/respond";
import type { Env } from "./env";
import { buildProviders, DEMO_REPLIES, NotConfiguredError, visitorText } from "./providers";

const KEY = "test-minimax-key-not-real";

function env(over: Partial<Env> = {}): Env {
  return {
    AI: {} as Ai,
    ASSETS: {} as Fetcher,
    CONVERSATION: {} as Env["CONVERSATION"],
    DB: {} as D1Database,
    RL_SESSION: {} as RateLimit,
    ASSISTANT_MODE: "voice",
    LLM_PROFILE: "minimax-flash",
    TTS_VOICE: "English_FriendlyPerson",
    DAILY_TURNS: "400",
    ...over,
  };
}

async function answer(question: string) {
  const { llm } = buildProviders(env({ ASSISTANT_DEMO: "1" }));
  const events: RespondEvent[] = [];
  for await (const e of respond({ llm, bundle, history: [], message: question, mode: "voice" })) events.push(e);
  const meta = events.find((e) => e.type === "meta");
  const done = events.find((e) => e.type === "done");
  return { meta, prose: done?.type === "done" ? done.prose : "" };
}

describe("buildProviders", () => {
  it("uses fakes for the LLM and TTS in demo mode without a key, and Flux always", () => {
    const p = buildProviders(env({ ASSISTANT_DEMO: "1" }));
    expect([p.llm.id, p.tts.id, p.stt.id]).toEqual(["fake", "fake", "flux"]);
    expect(p.label).toBe("llm fake (demo replies), tts fake, stt flux");
  });

  it("uses MiniMax for both when MINIMAX_API_KEY is set, with the LLM_PROFILE model", () => {
    const flash = buildProviders(env({ MINIMAX_API_KEY: KEY }));
    expect([flash.llm.model, flash.tts.id]).toEqual(["MiniMax-M3.1-Flash", "minimax-speech"]);
    expect(flash.label).toBe("llm minimax-flash (MiniMax-M3.1-Flash), tts minimax-speech, stt flux");
  });

  it("gives the LLM profile's prices for the cost estimate, and none for the demo", () => {
    expect(buildProviders(env({ ASSISTANT_DEMO: "1" })).prices).toBeNull();
    expect(buildProviders(env({ MINIMAX_API_KEY: KEY })).prices).toEqual(LLM_PROFILES["minimax-flash"].prices);
  });

  it("treats a blank key as no key", () => {
    const p = buildProviders(env({ MINIMAX_API_KEY: "  ", ASSISTANT_DEMO: "1" }));
    expect([p.llm.id, p.tts.id]).toEqual(["fake", "fake"]);
  });

  it("lets a key win over demo mode", () => {
    const p = buildProviders(env({ MINIMAX_API_KEY: KEY, ASSISTANT_DEMO: "1" }));
    expect([p.llm.model, p.tts.id]).toEqual(["MiniMax-M3.1-Flash", "minimax-speech"]);
  });

  it("is a configuration error without a key and without ASSISTANT_DEMO=1, never a silent demo", () => {
    expect(() => buildProviders(env())).toThrow(NotConfiguredError);
    expect(() => buildProviders(env({ MINIMAX_API_KEY: " ", ASSISTANT_DEMO: "true" }))).toThrow(NotConfiguredError);
  });

  it("refuses the Anthropic profile for visitors in Phase 0, with or without its key (probes only, see 0002)", () => {
    expect(() => buildProviders(env({ LLM_PROFILE: "anthropic-haiku", ANTHROPIC_API_KEY: KEY }))).toThrow(
      /anthropic-haiku.*probes/,
    );
    expect(() => buildProviders(env({ LLM_PROFILE: "anthropic-haiku" }))).toThrow(/anthropic-haiku/);
  });

  it("refuses minimax-m3 for visitors, with or without its key: it failed the redirect gate (0001, G7)", () => {
    expect(() => buildProviders(env({ LLM_PROFILE: "minimax-m3", MINIMAX_API_KEY: KEY }))).toThrow(/minimax-m3.*probes/);
    expect(() => buildProviders(env({ LLM_PROFILE: "minimax-m3" }))).toThrow(/minimax-m3/);
  });

  it("never puts a key in the label", () => {
    const p = buildProviders(env({ MINIMAX_API_KEY: KEY, ANTHROPIC_API_KEY: KEY }));
    expect(p.label).not.toContain(KEY);
  });

  it("fails loudly on an unknown LLM_PROFILE", () => {
    expect(() => buildProviders(env({ LLM_PROFILE: "gpt-9" }))).toThrow(/LLM_PROFILE/);
  });
});

describe("demo replies (no key)", () => {
  it("stay on topic: where Yash works", async () => {
    const { meta, prose } = await answer("Where does Yash work right now?");
    expect(prose).toContain("Magenta Connect");
    expect(meta).toMatchObject({ data: { refs: ["role:magenta"], coverage: "direct" }, dropped: [], error: null });
  });

  it("stay on topic: Amazon", async () => {
    const { meta, prose } = await answer("What did Yash do at Amazon?");
    expect(prose).toContain("Amazon");
    expect(meta).toMatchObject({ data: { refs: ["role:amazon"] }, error: null });
  });

  it("say they are scripted when asked how the assistant works", async () => {
    const { meta, prose } = await answer("How were you built?");
    expect(prose).toMatch(/demo mode/i);
    expect(meta).toMatchObject({ data: { refs: ["project:assistant"] }, error: null });
  });

  it("fall back to a scripted redirect for anything else", async () => {
    const { meta, prose } = await answer("Tell me a joke");
    expect(prose).toMatch(/demo mode/i);
    expect(meta).toMatchObject({ data: { refs: [], coverage: "none" }, error: null });
  });

  it("read only the visitor's words when the site's note follows the closing tag", () => {
    const text = '<visitor_message id="b1">hello</visitor_message>\n\n(Note from the site: mention Amazon.)';
    expect(visitorText({ turns: [{ role: "user", text }] } as LlmRequest)).toBe("hello");
  });

  it("are not fooled by the boundary wrapper around the visitor's message", async () => {
    // The wrapped message contains `visitor_message id="<uuid>"`; only the visitor's words count.
    const { meta } = await answer("hello");
    expect(meta).toMatchObject({ data: { coverage: "none" } });
  });

  it("cite only refs that exist in the real bundle, and never use he/she for Yash", () => {
    const known = new Set(bundle.refs);
    for (const r of DEMO_REPLIES) {
      for (const ref of r.refs) expect(known.has(ref), ref).toBe(true);
      expect(r.text).not.toMatch(/\b(he|him|his|himself|she|her|hers|herself)\b/i);
    }
  });
});
