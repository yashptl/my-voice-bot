import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_CEILINGS, DEFAULT_TURNS_PER_IP } from "./ledger";

/** wrangler.jsonc's vars; its comments are whole lines, so dropping those leaves JSON. */
function vars(): Record<string, string> {
  const text = readFileSync("wrangler.jsonc", "utf8")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  return (JSON.parse(text) as { vars: Record<string, string> }).vars;
}

describe("wrangler.jsonc vars", () => {
  it("start in text mode: voice is switched on in Phase 3", () => {
    expect(vars().ASSISTANT_MODE).toBe("text");
  });

  it("set every daily ceiling to the default the code falls back to", () => {
    expect(vars()).toMatchObject({
      DAILY_TURNS: String(DEFAULT_CEILINGS.turns),
      DAILY_VOICE_SECONDS: String(DEFAULT_CEILINGS.voice_seconds),
      DAILY_TTS_CHARS: String(DEFAULT_CEILINGS.tts_chars),
      DAILY_TURNS_PER_IP: String(DEFAULT_TURNS_PER_IP),
    });
    expect(DEFAULT_CEILINGS).toEqual({ turns: 400, voice_seconds: 1800, tts_chars: 60_000 });
    expect(DEFAULT_TURNS_PER_IP).toBe(60);
  });
});
