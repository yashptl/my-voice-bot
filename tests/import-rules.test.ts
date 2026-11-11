import { resolve } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: resolve(import.meta.dirname, "..") });

/** Lints `import { x } from "<from>"` as if it lived at `filePath`; returns the import-rule hits. */
async function importErrors(filePath: string, from: string): Promise<string[]> {
  const code = `import { x } from "${from}";\nexport { x };\n`;
  const [result] = await eslint.lintText(code, { filePath });
  if (!result) throw new Error(`no lint result for ${filePath}`);
  const fatal = result.messages.filter((m) => m.fatal);
  if (fatal.length > 0) throw new Error(`parse failed: ${fatal[0]?.message}`);
  return result.messages.filter((m) => m.ruleId === "no-restricted-imports").map((m) => m.message);
}

describe("import direction", () => {
  it.each([
    ["src/client/x.ts", "../core/prompt"],
    ["src/protocol/x.ts", "../ports/llm"],
    ["src/ports/x.ts", "../core/prompt"],
    ["src/core/x.ts", "../adapters/minimax-llm"],
    ["src/core/x.ts", "../knowledge/build"],
    ["src/adapters/x.ts", "../core/prompt"],
    ["src/worker/x.ts", "../client/player"],
    ["playground/x.tsx", "../src/core/prompt"],
  ])("%s may not import %s", async (filePath, from) => {
    const errors = await importErrors(filePath, from);
    expect(errors.length).toBeGreaterThan(0);
  });

  it.each([
    ["src/core/x.ts", "../protocol/refs"],
    ["src/core/x.ts", "../ports/llm"],
    ["src/core/x.ts", "../knowledge/types"],
    ["src/adapters/x.ts", "../ports/tts"],
    ["src/adapters/x.ts", "./sse"],
    ["src/client/x.ts", "../protocol/events"],
    ["playground/x.tsx", "../src/client/voice-session"],
    ["src/worker/x.ts", "../core/respond"],
    ["src/worker/x.ts", "../../knowledge/bundle.json"],
  ])("%s may import %s", async (filePath, from) => {
    expect(await importErrors(filePath, from)).toEqual([]);
  });

  it("does not apply to test files", async () => {
    expect(await importErrors("src/client/x.test.ts", "../adapters/fake-tts")).toEqual([]);
  });

  it("names the rule in its message", async () => {
    const [message] = await importErrors("src/client/x.ts", "../core/prompt");
    expect(message).toMatch(/src\/client/);
  });
});
