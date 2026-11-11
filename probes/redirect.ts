/**
 * Redirect-rule probe: runs every case in probes/redirect-questions.json through `respond` in text
 * mode, `--runs` times each, and records the prose, the data line, the auto flags and the latency.
 *
 *   npm run probe:redirect -- [--profile minimax-flash] [--runs 3] [--out probes/results]
 *
 * Writes <out>/redirect-<date>-<profile>.json and a self-contained HTML grading sheet next to it,
 * where each answer is hand-graded for "admitted a gap", "implied a yes", "false premise corrected"
 * and "on-brand" (gate G7). The profile defaults to LLM_PROFILE, then minimax-flash. Without that
 * profile's API key (in .dev.vars or the environment) it prints a note and exits 0.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import bundleJson from "../knowledge/bundle.json" with { type: "json" };
import { DEFAULT_LLM_PROFILE, LLM_PROFILES, createLlmFromEnv, isLlmProfileId } from "../src/adapters/llm-profiles";
import { respond } from "../src/core/respond";
import type { Bundle } from "../src/knowledge/types";
import { LlmError, type LlmPort, type LlmUsage } from "../src/ports/llm";
import type { DataLine } from "../src/protocol/data-line";
import { loadDevVars } from "./lib/env";
import { AUTO_FLAGS, autoFlags } from "./lib/flags";
import {
  REDIRECT_KINDS,
  RedirectCasesSchema,
  countFlags,
  renderGradingSheet,
  type RedirectCase,
  type RedirectRecord,
} from "./lib/grading-sheet";
import casesJson from "./redirect-questions.json" with { type: "json" };

const BUNDLE: Bundle = bundleJson;
const CALL_TIMEOUT_MS = 60_000;

function describeError(e: unknown): string {
  if (e instanceof LlmError) return `${e.kind}: ${e.message}`;
  // respond turns any abort into an AbortError, and only the timeout aborts here.
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") return `timed out after ${CALL_TIMEOUT_MS / 1000} s`;
  return e instanceof Error ? e.message : String(e);
}

/** One answer to one case, through the same `respond` the Worker uses. Never rejects. */
async function runCase(llm: LlmPort, c: RedirectCase, run: number): Promise<RedirectRecord> {
  const t0 = performance.now();
  const since = () => Math.round(performance.now() - t0);
  let firstSentenceMs: number | null = null;
  let doneMs: number | null = null;
  let prose = "";
  let meta: DataLine | null = null;
  let metaError: string | null = null;
  let dropped: string[] = [];
  let usage: LlmUsage | null = null;
  const base = { caseId: c.id, kind: c.kind, run };
  try {
    const events = respond({
      llm,
      bundle: BUNDLE,
      history: c.history ?? [],
      message: c.question,
      mode: "text",
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    for await (const e of events) {
      if (e.type === "sentence") {
        firstSentenceMs ??= since();
      } else if (e.type === "meta") {
        meta = e.data;
        metaError = e.error;
        dropped = e.dropped;
      } else if (e.type === "usage") {
        usage = e.usage;
      } else if (e.type === "done") {
        prose = e.prose;
        doneMs = since();
      }
    }
    const flags = autoFlags(prose, meta, metaError);
    return { ...base, ok: true, error: null, prose, meta, metaError, dropped, flags, firstSentenceMs, doneMs, usage };
  } catch (e) {
    return { ...base, ok: false, error: describeError(e), prose, meta, metaError, dropped, flags: [], firstSentenceMs, doneMs, usage };
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      profile: { type: "string" },
      runs: { type: "string", default: "3" },
      out: { type: "string", default: resolve(import.meta.dirname, "results") },
    },
  });
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  const vars = loadDevVars();
  const profileId = values.profile ?? vars.LLM_PROFILE ?? DEFAULT_LLM_PROFILE;
  if (!isLlmProfileId(profileId)) {
    throw new Error(`--profile: unknown "${profileId}"; expected one of ${Object.keys(LLM_PROFILES).join(", ")}`);
  }
  const cases = RedirectCasesSchema.parse(casesJson);

  const llm = createLlmFromEnv({
    LLM_PROFILE: profileId,
    MINIMAX_API_KEY: vars.MINIMAX_API_KEY,
    ANTHROPIC_API_KEY: vars.ANTHROPIC_API_KEY,
  });
  if (!llm) {
    console.log(`no provider key; skipped (${profileId} needs ${LLM_PROFILES[profileId].keyEnv})`);
    return 0;
  }

  const generatedAt = new Date().toISOString();
  console.log(`redirect probe: ${profileId} (${llm.model}), ${cases.length} cases × ${runs} runs, text mode`);
  const records: RedirectRecord[] = [];
  for (let run = 1; run <= runs; run++) {
    let errors = 0;
    for (const c of cases) {
      const record = await runCase(llm, c, run);
      if (!record.ok) errors++;
      records.push(record);
    }
    console.log(`run ${run}/${runs}: ${cases.length} answers, ${errors} errors`);
  }

  const counts = countFlags(records);
  const answered = records.filter((r) => r.ok);
  const validDataLines = answered.filter((r) => !r.flags.includes("meta_invalid")).length;
  const date = generatedAt.slice(0, 10);
  const sheet = {
    profile: profileId,
    model: llm.model,
    date,
    generatedAt,
    runs,
    bundleVersion: BUNDLE.version,
    cases,
    records,
  };
  mkdirSync(values.out, { recursive: true });
  const jsonPath = resolve(values.out, `redirect-${date}-${profileId}.json`);
  const htmlPath = resolve(values.out, `redirect-${date}-${profileId}.html`);
  const results = { probe: "redirect", ...sheet, summary: { validDataLines, answered: answered.length, byKind: counts } };
  writeFileSync(jsonPath, `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(htmlPath, renderGradingSheet(sheet));

  console.log(`\n${"kind".padEnd(15)}${"runs".padStart(5)}${"errors".padStart(8)}${AUTO_FLAGS.map((f) => f.padStart(14)).join("")}`);
  for (const kind of REDIRECT_KINDS) {
    const c = counts[kind];
    if (c.runs === 0) continue;
    console.log(
      `${kind.padEnd(15)}${String(c.runs).padStart(5)}${String(c.errors).padStart(8)}${AUTO_FLAGS.map((f) =>
        String(c.flags[f]).padStart(14),
      ).join("")}`,
    );
  }
  console.log(`valid data lines: ${validDataLines}/${answered.length} answers (G7 needs all of them)`);
  const shown = (p: string) => {
    const rel = relative(process.cwd(), p);
    return rel.startsWith("..") ? p : rel;
  };
  console.log(`results: ${shown(jsonPath)}`);
  console.log(`hand-grade: ${shown(htmlPath)}`);
  return answered.length > 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`redirect probe failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
