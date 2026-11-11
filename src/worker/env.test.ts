import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_CEILINGS, DEFAULT_TURNS_PER_IP } from "./ledger";

/** wrangler.jsonc; its comments are whole lines, so dropping those leaves JSON. */
function wrangler(): { vars: Record<string, string>; send_email?: Record<string, unknown>[] } {
  const text = readFileSync("wrangler.jsonc", "utf8")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  return JSON.parse(text) as ReturnType<typeof wrangler>;
}
const vars = () => wrangler().vars;

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

describe("wrangler.jsonc alerts and demo mode", () => {
  it("never sets ASSISTANT_DEMO or ALERT_TO: production runs on real keys, and the address is a secret", () => {
    expect(vars()).not.toHaveProperty("ASSISTANT_DEMO");
    expect(vars()).not.toHaveProperty("ALERT_TO");
    expect(readFileSync("wrangler.jsonc", "utf8")).not.toMatch(/ASSISTANT_DEMO["']?\s*:\s*["']1/);
  });

  it("sends alerts from the yashos.dev sender through an unrestricted send_email binding named ALERT_EMAIL", () => {
    expect(vars().ALERT_FROM).toBe("assistant@yashos.dev");
    expect(wrangler().send_email).toEqual([{ name: "ALERT_EMAIL" }]);
  });

  it("the example env file runs a fresh clone keyless, in demo mode", () => {
    expect(readFileSync(".dev.vars.example", "utf8")).toMatch(/^ASSISTANT_DEMO=1$/m);
  });
});

describe("package.json scripts", () => {
  it("print the gap log from the remote and local databases", () => {
    const { scripts } = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(scripts.gaps).toMatch(/^wrangler d1 execute DB --remote --command "SELECT .* FROM gaps .*ORDER BY created_at DESC"$/);
    expect(scripts["gaps:local"]).toMatch(/^wrangler d1 execute DB --local --persist-to playground\/\.wrangler\/state --command "SELECT .* FROM gaps .*ORDER BY created_at DESC"$/);
  });
});
