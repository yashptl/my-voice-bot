import { describe, expect, it } from "vitest";
import type { LlmUsage } from "../ports/llm";
import { createLlmFromEnv, estimateCostUsd, LLM_PROFILES } from "./llm-profiles";

describe("LLM_PROFILES", () => {
  it("minimax-flash is MiniMax-M3.1-Flash at low effort over bearer auth", () => {
    expect(LLM_PROFILES["minimax-flash"]).toEqual({
      id: "minimax-flash",
      baseUrl: "https://api.minimax.io/anthropic",
      model: "MiniMax-M3.1-Flash",
      auth: "bearer",
      keyEnv: "MINIMAX_API_KEY",
      extraBody: { output_config: { effort: "low" } },
      prices: { input: 0.15, cachedInput: 0.015, output: 0.6 },
    });
  });

  it("minimax-m3 is MiniMax-M3 with thinking omitted (off by default)", () => {
    expect(LLM_PROFILES["minimax-m3"]).toEqual({
      id: "minimax-m3",
      baseUrl: "https://api.minimax.io/anthropic",
      model: "MiniMax-M3",
      auth: "bearer",
      keyEnv: "MINIMAX_API_KEY",
      extraBody: {},
      prices: { input: 0.3, cachedInput: 0.06, output: 1.2 },
    });
  });

  it("anthropic-haiku is claude-haiku-5-5 with thinking disabled at low effort and a system cache breakpoint", () => {
    expect(LLM_PROFILES["anthropic-haiku"]).toEqual({
      id: "anthropic-haiku",
      baseUrl: "https://api.anthropic.com",
      model: "claude-haiku-5-5",
      auth: "x-api-key",
      keyEnv: "ANTHROPIC_API_KEY",
      extraBody: { thinking: { type: "disabled" }, output_config: { effort: "low" } },
      prices: { input: 0.1, cachedInput: 0.01, output: 0.5 },
      cacheSystem: true,
    });
  });

  it("no profile sends sampling parameters, stop sequences or a MiniMax cache_control", () => {
    for (const profile of Object.values(LLM_PROFILES)) {
      const raw = JSON.stringify(profile.extraBody);
      for (const banned of ["temperature", "top_p", "top_k", "stop_sequences", "cache_control"]) {
        expect(raw, `${profile.id} ${banned}`).not.toContain(banned);
      }
    }
    expect(LLM_PROFILES["minimax-flash"].cacheSystem).toBeUndefined();
    expect(LLM_PROFILES["minimax-m3"].cacheSystem).toBeUndefined();
  });
});

describe("createLlmFromEnv", () => {
  it("returns null when the selected profile's key is missing or blank", () => {
    expect(createLlmFromEnv({ LLM_PROFILE: "minimax-m3" })).toBeNull();
    expect(createLlmFromEnv({ LLM_PROFILE: "minimax-m3", MINIMAX_API_KEY: "  " })).toBeNull();
    expect(createLlmFromEnv({ LLM_PROFILE: "anthropic-haiku", MINIMAX_API_KEY: "mm-key" })).toBeNull();
  });

  it("returns a port for the selected profile when its key is set", () => {
    const llm = createLlmFromEnv({ LLM_PROFILE: "minimax-m3", MINIMAX_API_KEY: "mm-key" });
    expect(llm?.id).toBe("minimax-m3");
    expect(llm?.model).toBe("MiniMax-M3");
    const haiku = createLlmFromEnv({ LLM_PROFILE: "anthropic-haiku", ANTHROPIC_API_KEY: "a-key" });
    expect(haiku?.model).toBe("claude-haiku-5-5");
  });

  it("defaults to minimax-flash when LLM_PROFILE is unset or empty", () => {
    expect(createLlmFromEnv({ MINIMAX_API_KEY: "mm-key" })?.id).toBe("minimax-flash");
    expect(createLlmFromEnv({ LLM_PROFILE: "", MINIMAX_API_KEY: "mm-key" })?.model).toBe("MiniMax-M3.1-Flash");
  });

  it("throws on an unknown profile name instead of silently falling back", () => {
    expect(() => createLlmFromEnv({ LLM_PROFILE: "gpt-9", MINIMAX_API_KEY: "mm-key" })).toThrow(
      /Unknown LLM_PROFILE "gpt-9".*minimax-flash, minimax-m3, anthropic-haiku/,
    );
    expect(() => createLlmFromEnv({ LLM_PROFILE: "toString", MINIMAX_API_KEY: "mm-key" })).toThrow(/Unknown LLM_PROFILE/);
  });
});

describe("estimateCostUsd", () => {
  const usage: LlmUsage = {
    input: 1_000,
    cachedInput: 5_000,
    reasoning: 300,
    reasoningEstimated: true,
    output: 200,
    model: "MiniMax-M3.1-Flash",
    stopReason: "end_turn",
  };

  it("prices input, cached input and output tokens per million, with reasoning not added on top", () => {
    // 1000 × 0.15 + 5000 × 0.015 + 200 × 0.60 = 150 + 75 + 120 = 345 per million tokens.
    expect(estimateCostUsd(usage, LLM_PROFILES["minimax-flash"].prices)).toBeCloseTo(0.000345, 12);
    expect(estimateCostUsd({ ...usage, input: 0, cachedInput: 0, output: 0 }, LLM_PROFILES["minimax-m3"].prices)).toBe(0);
  });

  it("is null when usage or prices are unknown", () => {
    expect(estimateCostUsd(null, LLM_PROFILES["minimax-flash"].prices)).toBeNull();
    expect(estimateCostUsd(usage, null)).toBeNull();
  });
});
