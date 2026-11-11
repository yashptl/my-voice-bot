import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The repo's `.dev.vars` (gitignored), the same file Wrangler reads in local dev. */
const DEV_VARS_PATH = resolve(import.meta.dirname, "../../.dev.vars");

function parseDevVars(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    const eq = line.indexOf("=");
    if (line === "" || line.startsWith("#") || eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    vars[line.slice(0, eq).trim()] = value;
  }
  return vars;
}

function readDevVars(path: string): Record<string, string> {
  try {
    return parseDevVars(readFileSync(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}

/**
 * Secrets and vars for probes: `.dev.vars` if present, then the environment on top (so CI secrets win).
 * Empty values are dropped, so a blank `MINIMAX_API_KEY=` reads as unset. Never prints anything.
 */
export function loadDevVars(o: { path?: string; env?: Record<string, string | undefined> } = {}): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const source of [readDevVars(o.path ?? DEV_VARS_PATH), o.env ?? process.env]) {
    for (const [key, value] of Object.entries(source)) {
      if (value) vars[key] = value;
    }
  }
  return vars;
}
