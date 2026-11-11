/**
 * Eval suite: runs every case in evals/cases.json through `respond()` (the same brain the Worker
 * uses), applies the code checks to the last answer, asks the judge to score quality cases, writes a
 * results file and prints a scorecard.
 *
 *   npm run eval -- [--fake] [--profile minimax-flash] [--only id,id] [--runs 3] [--concurrency 2]
 *
 * Safety cases run `--runs` times (default 3) and fail on any failed run; quality cases run once and
 * only report. Exits 1 on any safety failure. Without the profile's API key (and without --fake) it
 * prints `skipped: no MINIMAX_API_KEY` and exits 0, so keyless CI and forks pass. The judge runs
 * only when ANTHROPIC_API_KEY is set, and never with --fake, which calls no provider at all.
 *
 * Writes evals/results/<YYYY-MM-DDTHHMMSS>-<sha7>-<profile>[-partial].json, one file per run.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import bundleJson from "../knowledge/bundle.json" with { type: "json" };
import { loadDevVars } from "../probes/lib/env";
import { createFakeLlm } from "../src/adapters/fake-llm";
import {
  DEFAULT_LLM_PROFILE,
  LLM_PROFILES,
  createLlmFromEnv,
  estimateCostUsd,
  isLlmProfileId,
  type LlmProfile,
} from "../src/adapters/llm-profiles";
import { buildStable, promptHash, type ReplyMode } from "../src/core/prompt";
import { respond, type RespondEvent } from "../src/core/respond";
import type { Bundle } from "../src/knowledge/types";
import { LlmError, type LlmPort, type LlmUsage, type NeutralTurn } from "../src/ports/llm";
import { CasesSchema, type EvalCase } from "./case-schema";
import casesJson from "./cases.json" with { type: "json" };
import { failures, type Answer } from "./checks";
import { JUDGE_MODEL, judgeAnswer, type JudgeResult } from "./judge";

const BUNDLE: Bundle = bundleJson;
const TURN_TIMEOUT_MS = 60_000;
const RESULTS_DIR = resolve(import.meta.dirname, "results");

/** The --fake reply: on topic and well formed, so it passes some cases and fails the rest. */
const FAKE_REPLY =
  "Yash works at Magenta Connect as a Full Stack Developer, building an internal AI agent on retrieval-augmented generation. " +
  'Before that, Yash built full-stack features at Amazon.\n<meta>{"refs":["role:magenta","role:amazon"],"coverage":"direct"}</meta>';

interface RunRecord {
  run: number;
  passed: boolean;
  /** The provider error, when the run ended before an answer. */
  error: string | null;
  failures: string[];
  /** The last turn's answer; null after an error. */
  answer: Answer | null;
  ms: number;
  /** One entry per answered turn. */
  usage: LlmUsage[];
  costUsd: number | null;
  judge: JudgeResult | null;
}

interface CaseRecord {
  id: string;
  category: EvalCase["category"];
  mode: ReplyMode;
  tags: string[];
  passed: boolean;
  runs: RunRecord[];
}

interface Context {
  llm: LlmPort;
  prices: LlmProfile["prices"] | null;
  judgeKey: string | null;
}

type Done = Extract<RespondEvent, { type: "done" }>;
type Meta = Extract<RespondEvent, { type: "meta" }>;

function describeError(e: unknown): string {
  if (e instanceof LlmError) return `${e.kind}: ${e.message}`;
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") return `timed out after ${TURN_TIMEOUT_MS / 1000} s`;
  return e instanceof Error ? e.message : String(e);
}

/** One visitor turn through `respond()`, collected into what the checks see. */
async function answerTurn(
  llm: LlmPort,
  mode: ReplyMode,
  history: NeutralTurn[],
  message: string,
): Promise<{ answer: Answer; usage: LlmUsage | null }> {
  const sentences: string[] = [];
  let meta: Meta | null = null;
  let usage: LlmUsage | null = null;
  let done: Done | null = null;
  const signal = AbortSignal.timeout(TURN_TIMEOUT_MS);
  for await (const e of respond({ llm, bundle: BUNDLE, history, message, mode, signal })) {
    if (e.type === "sentence") sentences.push(e.text);
    else if (e.type === "meta") meta = e;
    else if (e.type === "usage") usage = e.usage;
    else if (e.type === "done") done = e;
  }
  if (done === null) throw new Error("respond ended without a done event");
  const answer: Answer = {
    prose: done.prose,
    sentences,
    data: meta?.data ?? null,
    metaError: meta === null ? "no meta event" : meta.error,
    dropped: meta?.dropped ?? [],
    gate: done.gate,
    grounding: done.grounding,
  };
  return { answer, usage };
}

/**
 * MiniMax throttles bursts per minute (a Token Plan key returns 429 "rate limit reached"). An
 * offline eval can wait that out, so a throttled or overloaded turn is retried after these waits;
 * any other error, or a fourth throttle, fails the run as before.
 */
const RETRY_WAITS_MS = [15_000, 30_000, 60_000];

async function answerTurnPatiently(...args: Parameters<typeof answerTurn>): ReturnType<typeof answerTurn> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await answerTurn(...args);
    } catch (e) {
      const wait = RETRY_WAITS_MS[attempt];
      const throttled = e instanceof LlmError && (e.kind === "rate_limit" || e.kind === "overloaded");
      if (!throttled || wait === undefined) throw e;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

function totalCost(usage: readonly LlmUsage[], prices: LlmProfile["prices"] | null): number | null {
  let total = 0;
  for (const u of usage) {
    const cost = estimateCostUsd(u, prices);
    if (cost === null) return null;
    total += cost;
  }
  return total;
}

/** One run of one case: earlier turns build real history, the checks and the judge see the last answer. */
async function runCase(c: EvalCase, run: number, ctx: Context): Promise<RunRecord> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const history: NeutralTurn[] = [];
  const usage: LlmUsage[] = [];
  const question = c.turns[c.turns.length - 1] ?? "";
  try {
    for (const turn of c.turns.slice(0, -1)) {
      const earlier = await answerTurnPatiently(ctx.llm, c.mode, history, turn);
      if (earlier.usage) usage.push(earlier.usage);
      history.push({ role: "user", text: turn }, { role: "assistant", text: earlier.answer.prose });
    }
    const last = await answerTurnPatiently(ctx.llm, c.mode, history, question);
    if (last.usage) usage.push(last.usage);
    const failed = failures(c.expect, last.answer, question);
    const judge =
      c.judge && ctx.judgeKey
        ? await judgeAnswer({
            apiKey: ctx.judgeKey,
            bundle: BUNDLE,
            question,
            answer: last.answer.prose,
            refs: last.answer.data?.refs ?? [],
            rubric: c.judge.rubric,
          })
        : null;
    // A judge error leaves the run unjudged; it does not fail it.
    const defects = judge?.ok ? judge.verdict.defects.length : 0;
    return {
      run,
      passed: failed.length === 0 && defects === 0,
      error: null,
      failures: failed,
      answer: last.answer,
      ms: ms(),
      usage,
      costUsd: totalCost(usage, ctx.prices),
      judge,
    };
  } catch (e) {
    const error = describeError(e);
    return { run, passed: false, error, failures: [], answer: null, ms: ms(), usage, costUsd: null, judge: null };
  }
}

/** Runs `fn` over `items`, at most `limit` at a time, keeping the order. */
async function inPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function gitSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

function positiveInt(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
  return n;
}

const round = (n: number, digits: number) => Number(n.toFixed(digits));
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

function summarize(records: readonly CaseRecord[]) {
  const of = (category: EvalCase["category"]) => records.filter((r) => r.category === category);
  const count = (rs: readonly CaseRecord[]) => ({
    passed: rs.filter((r) => r.passed).length,
    failed: rs.filter((r) => !r.passed).length,
  });
  const scores = of("quality").flatMap((r) => r.runs.flatMap((run) => (run.judge?.ok ? [run.judge.verdict.score] : [])));
  const answers = records.flatMap((r) => r.runs.flatMap((run) => (run.answer ? [run.answer] : [])));
  const rate = (n: number) => (answers.length > 0 ? round(n / answers.length, 3) : null);
  const flagged = answers.filter((a) => a.grounding.unsupported.length > 0).length;
  const uncited = answers.filter((a) => a.grounding.uncited.length > 0).length;
  return {
    safety: count(of("safety")),
    quality: {
      ...count(of("quality")),
      meanScore: scores.length > 0 ? round(scores.reduce((a, b) => a + b, 0) / scores.length, 2) : null,
    },
    /** Answers with at least one unsupported (invented) claim. Hand-check the listed claims for false positives. */
    groundingFlagRate: rate(flagged),
    /** Answers naming something the knowledge holds but the answer did not cite: a citation slip, not an invention. */
    uncitedRate: rate(uncited),
  };
}

function printScorecard(records: readonly CaseRecord[], summary: ReturnType<typeof summarize>): void {
  console.log(`\n${pad("case", 28)}${pad("category", 9)}${pad("mode", 6)}${pad("runs", 6)}${pad("result", 7)}${pad("judge", 6)}first failure`);
  for (const r of records) {
    const passedRuns = r.runs.filter((run) => run.passed).length;
    const judged = r.runs.flatMap((run) => (run.judge?.ok ? [run.judge.verdict.score] : []));
    const judgeErrors = r.runs.filter((run) => run.judge && !run.judge.ok).length;
    const judge = judged.length > 0 ? judged.join(",") : judgeErrors > 0 ? "err" : "-";
    const firstFailure = r.runs.flatMap((run) => [
      ...(run.error ? [`error: ${run.error}`] : []),
      ...run.failures,
      ...(run.judge?.ok ? run.judge.verdict.defects.map((d) => `judge ${d.type}: ${JSON.stringify(d.quote)}`) : []),
    ])[0];
    console.log(
      `${pad(r.id, 28)}${pad(r.category, 9)}${pad(r.mode, 6)}${pad(`${passedRuns}/${r.runs.length}`, 6)}${pad(
        r.passed ? "pass" : "FAIL",
        7,
      )}${pad(judge, 6)}${firstFailure ?? ""}`,
    );
  }

  const { safety, quality, groundingFlagRate, uncitedRate } = summary;
  console.log(`\nsafety: ${safety.passed} passed, ${safety.failed} failed`);
  console.log(
    `quality: ${quality.passed} passed, ${quality.failed} failed, mean judge score ${quality.meanScore ?? "n/a"}`,
  );
  const flags = records.flatMap((r) =>
    r.runs.flatMap((run) => (run.answer?.grounding.unsupported ?? []).map((claim) => `${r.id} run ${run.run}: ${JSON.stringify(claim)}`)),
  );
  const percent = (rate: number | null) => (rate === null ? "n/a" : `${round(rate * 100, 1)}%`);
  const falsePositives = flags.length > 0 ? " (check each for a false positive)" : "";
  console.log(`grounding flags: ${percent(groundingFlagRate)} of answers${falsePositives}`);
  for (const flag of flags) console.log(`  ${flag}`);
  console.log(
    `uncited claims: ${percent(uncitedRate)} of answers (in the knowledge but not in the refs cited; listed in the ` +
      "results file under answer.grounding.uncited, never a failure)",
  );
  const costs = records.flatMap((r) => r.runs.map((run) => run.costUsd));
  if (costs.length > 0 && costs.every((c) => c !== null)) {
    console.log(`estimated model cost: $${costs.reduce((a, b) => a + b, 0).toFixed(4)} (judge not included)`);
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      fake: { type: "boolean", default: false },
      profile: { type: "string" },
      only: { type: "string" },
      runs: { type: "string", default: "3" },
      concurrency: { type: "string", default: "2" },
    },
  });
  const safetyRuns = positiveInt("runs", values.runs);
  const concurrency = positiveInt("concurrency", values.concurrency);

  let cases = CasesSchema.parse(casesJson);
  if (values.only) {
    const wanted = values.only.split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = wanted.filter((id) => !cases.some((c) => c.id === id));
    if (unknown.length > 0) throw new Error(`--only: unknown case ids ${unknown.join(", ")}`);
    cases = cases.filter((c) => wanted.includes(c.id));
  }

  const vars = loadDevVars();
  let ctx: Context;
  let label: string;
  if (values.fake) {
    ctx = { llm: createFakeLlm({ reply: () => FAKE_REPLY }), prices: null, judgeKey: null };
    label = "fake";
  } else {
    const profileId = values.profile ?? vars.LLM_PROFILE ?? DEFAULT_LLM_PROFILE;
    if (!isLlmProfileId(profileId)) {
      throw new Error(`--profile: unknown "${profileId}"; expected one of ${Object.keys(LLM_PROFILES).join(", ")}`);
    }
    const profile = LLM_PROFILES[profileId];
    const llm = createLlmFromEnv({
      LLM_PROFILE: profileId,
      MINIMAX_API_KEY: vars.MINIMAX_API_KEY,
      ANTHROPIC_API_KEY: vars.ANTHROPIC_API_KEY,
    });
    if (!llm) {
      console.log(`skipped: no ${profile.keyEnv}`);
      return 0;
    }
    ctx = { llm, prices: profile.prices, judgeKey: vars.ANTHROPIC_API_KEY ?? null };
    label = profileId;
  }

  const startedAt = new Date().toISOString();
  const sha = gitSha();
  const jobs = cases.flatMap((c) =>
    Array.from({ length: c.category === "safety" ? safetyRuns : 1 }, (_, i) => ({ c, run: i + 1 })),
  );
  console.log(
    `eval: ${label} (${ctx.llm.model}), ${cases.length} cases, ${jobs.length} runs, safety ×${safetyRuns}, ` +
      `judge ${ctx.judgeKey ? JUDGE_MODEL : "off"}`,
  );
  const runs = await inPool(jobs, concurrency, ({ c, run }) => runCase(c, run, ctx));

  const records: CaseRecord[] = cases.map((c) => {
    const own = runs.filter((_, i) => jobs[i]?.c === c);
    return { id: c.id, category: c.category, mode: c.mode, tags: c.tags, passed: own.every((r) => r.passed), runs: own };
  });
  const summary = summarize(records);
  const results = {
    sha,
    promptHash: await promptHash(buildStable(BUNDLE)),
    knowledgeHash: BUNDLE.hash,
    model: ctx.llm.model,
    judgeModel: ctx.judgeKey ? JUDGE_MODEL : null,
    startedAt,
    cases: records,
    summary,
  };
  mkdirSync(RESULTS_DIR, { recursive: true });
  // One file per run, never overwritten: the UTC start time to the second, and "-partial" for --only runs.
  const stamp = startedAt.slice(0, 19).replace(/:/g, "");
  const partial = values.only ? "-partial" : "";
  const path = resolve(RESULTS_DIR, `${stamp}-${sha.slice(0, 7)}-${label}${partial}.json`);
  writeFileSync(path, `${JSON.stringify(results, null, 2)}\n`);

  printScorecard(records, summary);
  const rel = relative(process.cwd(), path);
  console.log(`results: ${rel.startsWith("..") ? path : rel}`);
  return summary.safety.failed > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`eval failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
