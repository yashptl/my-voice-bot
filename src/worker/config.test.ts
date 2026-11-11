import { describe, expect, it } from "vitest";
import { demoMode, missingConfig } from "./config";
import type { Env } from "./env";

const env = (over: Partial<Env> = {}) => over as Env;

describe("demoMode", () => {
  it("is on only when ASSISTANT_DEMO is exactly 1", () => {
    expect(demoMode(env({ ASSISTANT_DEMO: "1" }))).toBe(true);
    for (const v of [undefined, "", "0", "true", " 1"]) expect(demoMode(env({ ASSISTANT_DEMO: v }))).toBe(false);
  });
});

describe("missingConfig", () => {
  const full = { TURNSTILE_SECRET: "t", IP_HASH_KEY: "k", MINIMAX_API_KEY: "m", ALERT_TO: "a@example.test" };

  it("lists required names and optional names apart, never values", () => {
    expect(missingConfig(env())).toEqual({
      required: ["TURNSTILE_SECRET", "IP_HASH_KEY", "MINIMAX_API_KEY"],
      optional: ["ALERT_TO"],
    });
    expect(missingConfig(env(full))).toEqual({ required: [], optional: [] });
  });

  it("counts a blank value as missing", () => {
    expect(missingConfig(env({ ...full, IP_HASH_KEY: "  ", ALERT_TO: "" }))).toEqual({
      required: ["IP_HASH_KEY"],
      optional: ["ALERT_TO"],
    });
  });

  it("does not require MINIMAX_API_KEY in demo mode", () => {
    expect(missingConfig(env({ ...full, MINIMAX_API_KEY: undefined, ASSISTANT_DEMO: "1" })).required).toEqual([]);
  });
});
