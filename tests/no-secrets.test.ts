import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The repo is public. These checks fail before a commit could publish a key: the example env file
 * may hold only Cloudflare's published test values, and no file git would add may contain
 * something shaped like a provider key.
 */

/**
 * Public test values that are safe to commit: Cloudflare Turnstile's documented test secret, the
 * placeholder IP_HASH_KEY for local dev (production sets its own as a Worker secret), and the demo
 * flag. ALERT_TO, the owner's address, must stay empty here.
 */
const ALLOWED_VALUES = new Set(["1x0000000000000000000000000000000AA", "local-test-only-not-a-secret", "1"]);

/** MiniMax (`sk-…`, `sk-cp-…`, `sk-api-…`) and Anthropic (`sk-ant-…`) style keys. */
const KEY_SHAPE = /\bsk-(?:ant-|cp-|api-)?[A-Za-z0-9_-]{32,}/;

describe("no secrets in the repo", () => {
  it(".dev.vars.example has no values except public test values", () => {
    const lines = readFileSync(".dev.vars.example", "utf8").split("\n");
    const filled = lines
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => ({ name: l.slice(0, l.indexOf("=")), value: l.slice(l.indexOf("=") + 1).trim() }))
      .filter(({ value }) => value !== "" && !ALLOWED_VALUES.has(value));
    expect(filled.map((f) => f.name), "these keys have values in .dev.vars.example; move them to .dev.vars").toEqual([]);
  });

  it("no file git would commit contains a provider key", () => {
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
      .split("\0")
      .filter((f) => f && !/\.(png|jpe?g|gif|wav|mp3|ico|woff2?)$/i.test(f) && f !== "package-lock.json");
    const hits = files.filter((f) => {
      try {
        return KEY_SHAPE.test(readFileSync(f, "utf8"));
      } catch {
        return false; // deleted or unreadable
      }
    });
    expect(hits, "these files contain something shaped like an API key").toEqual([]);
  });
});
