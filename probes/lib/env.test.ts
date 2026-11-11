import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDevVars } from "./env";

function devVarsFile(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "dev-vars-")), ".dev.vars");
  writeFileSync(path, text);
  return path;
}

describe("loadDevVars", () => {
  it("reads KEY=value lines, skipping comments and blanks", () => {
    const path = devVarsFile("# keys\n\nMINIMAX_API_KEY=mm-test\nLLM_PROFILE = minimax-m3 \n");
    expect(loadDevVars({ path, env: {} })).toEqual({ MINIMAX_API_KEY: "mm-test", LLM_PROFILE: "minimax-m3" });
  });

  it("strips matching quotes, an export prefix and inline comments on unquoted values", () => {
    const path = devVarsFile(`export A="x # kept"\nB='y'\nC=z # note\nD=has=equals\n`);
    expect(loadDevVars({ path, env: {} })).toEqual({ A: "x # kept", B: "y", C: "z", D: "has=equals" });
  });

  it("lets process.env override the file", () => {
    const path = devVarsFile("MINIMAX_API_KEY=from-file\n");
    expect(loadDevVars({ path, env: { MINIMAX_API_KEY: "from-env" } }).MINIMAX_API_KEY).toBe("from-env");
  });

  it("drops empty values so a copied .dev.vars.example reads as unset", () => {
    const path = devVarsFile("MINIMAX_API_KEY=\nANTHROPIC_API_KEY=''\n");
    const vars = loadDevVars({ path, env: { TTS_VOICE: "" } });
    expect(vars).toEqual({});
    expect(vars.MINIMAX_API_KEY).toBeUndefined();
  });

  it("keeps the file's value when the environment variable is empty", () => {
    const path = devVarsFile("MINIMAX_API_KEY=from-file\n");
    expect(loadDevVars({ path, env: { MINIMAX_API_KEY: "" } }).MINIMAX_API_KEY).toBe("from-file");
  });

  it("falls back to the environment when the file is missing", () => {
    expect(loadDevVars({ path: join(tmpdir(), "no-such-dir-xyz", ".dev.vars"), env: { X: "1" } })).toEqual({ X: "1" });
  });

  it("defaults to the repo's .dev.vars and process.env", () => {
    expect(loadDevVars().PATH).toBe(process.env.PATH);
  });
});
