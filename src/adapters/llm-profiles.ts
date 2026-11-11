import type { LlmPort, LlmUsage } from "../ports/llm";
import { createAnthropicCompatibleLlm } from "./anthropic-compatible";

export type LlmProfileId = "minimax-flash" | "minimax-m3" | "anthropic-haiku";

export interface LlmProfile {
  id: string;
  /** Origin plus path prefix; the adapter appends `/v1/messages`. */
  baseUrl: string;
  model: string;
  auth: "bearer" | "x-api-key";
  keyEnv: "MINIMAX_API_KEY" | "ANTHROPIC_API_KEY";
  /** Merged into every request body (thinking and effort settings). */
  extraBody: Record<string, unknown>;
  /** USD per 1M tokens. */
  prices: { input: number; cachedInput: number; output: number };
  /**
   * Send `system` as one text block with `cache_control: { type: "ephemeral" }`. Anthropic caches only at
   * explicit breakpoints, and a breakpoint on the stable prefix is what lets every conversation share it.
   * Leave unset for MiniMax: it caches prefixes automatically and does not support `cache_control`.
   */
  cacheSystem?: boolean;
}

const MINIMAX_BASE_URL = "https://api.minimax.io/anthropic";

/**
 * Provider profiles. `max_tokens` (8192 for all; thinking counts toward it) comes from the request.
 * MiniMax facts: docs/research/vendor-apis.md ("MiniMax text").
 */
export const LLM_PROFILES: Record<LlmProfileId, LlmProfile> = {
  // Thinking is always on for Flash (disabling it is a 400, code 2013) and effort defaults to max: pin it low.
  "minimax-flash": {
    id: "minimax-flash",
    baseUrl: MINIMAX_BASE_URL,
    model: "MiniMax-M3.1-Flash",
    auth: "bearer",
    keyEnv: "MINIMAX_API_KEY",
    extraBody: { output_config: { effort: "low" } },
    prices: { input: 0.15, cachedInput: 0.015, output: 0.6 },
  },
  // M3 thinks only when asked (`thinking: { type: "adaptive" }`), so omitting `thinking` keeps it off.
  "minimax-m3": {
    id: "minimax-m3",
    baseUrl: MINIMAX_BASE_URL,
    model: "MiniMax-M3",
    auth: "bearer",
    keyEnv: "MINIMAX_API_KEY",
    extraBody: {},
    prices: { input: 0.3, cachedInput: 0.06, output: 1.2 },
  },
  // Source: the claude-api skill (Claude Code bundled skill 2.1.317), "Current Models" table and
  // shared/model-migration.md > "Migrating to Claude Haiku 5.5":
  // - Model id `claude-haiku-5-5`, exactly (no date suffix, no alias).
  // - Thinking is adaptive and on by default; `thinking: { type: "disabled" }` is accepted at effort
  //   low/medium/high and is a 400 at xhigh/max. `budget_tokens` is a 400.
  // - Effort applies: `output_config.effort` low|medium|high|xhigh|max, default medium. Pinned to low here
  //   (the skill's level for chat; also matches minimax-flash).
  // - Omit temperature/top_p/top_k (non-default values are a 400); no assistant prefill.
  // - Prices for prompts up to 100K tokens: $0.10 in / $0.50 out per 1M ($0.50 / $2.50 above);
  //   cache reads 0.1x input. 5-minute cache writes cost 1.25x input, which `prices` does not model.
  // - Minimum cacheable prefix 512 tokens, so the stable prefix caches with an explicit breakpoint.
  "anthropic-haiku": {
    id: "anthropic-haiku",
    baseUrl: "https://api.anthropic.com",
    model: "claude-haiku-5-5",
    auth: "x-api-key",
    keyEnv: "ANTHROPIC_API_KEY",
    extraBody: { thinking: { type: "disabled" }, output_config: { effort: "low" } },
    prices: { input: 0.1, cachedInput: 0.01, output: 0.5 },
    cacheSystem: true,
  },
};

export const DEFAULT_LLM_PROFILE: LlmProfileId = "minimax-flash";

/**
 * Estimated USD for one reply: input, cached input and output tokens at the profile's per-million
 * prices. Reasoning is not priced on its own: the adapter only estimates it, and Anthropic counts
 * thinking inside `output_tokens` (MiniMax's Anthropic-compatible usage is assumed to match). Cache
 * writes are not modelled. Null when usage or prices are unknown, as with the fake LLM.
 */
export function estimateCostUsd(usage: LlmUsage | null, prices: LlmProfile["prices"] | null): number | null {
  if (!usage || !prices) return null;
  return (usage.input * prices.input + usage.cachedInput * prices.cachedInput + usage.output * prices.output) / 1e6;
}

export function isLlmProfileId(name: string): name is LlmProfileId {
  return Object.hasOwn(LLM_PROFILES, name);
}

/**
 * The LLM selected by `LLM_PROFILE` (default `minimax-flash`), or null when that profile's API key is
 * not set (callers then use the fake). An unknown profile name is a configuration error and throws.
 */
export function createLlmFromEnv(env: {
  LLM_PROFILE?: string;
  MINIMAX_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}): LlmPort | null {
  const name = env.LLM_PROFILE?.trim() || DEFAULT_LLM_PROFILE;
  if (!isLlmProfileId(name)) {
    throw new Error(`Unknown LLM_PROFILE "${name}"; expected one of ${Object.keys(LLM_PROFILES).join(", ")}`);
  }
  const profile = LLM_PROFILES[name];
  const apiKey = env[profile.keyEnv]?.trim();
  return apiKey ? createAnthropicCompatibleLlm({ profile, apiKey }) : null;
}
