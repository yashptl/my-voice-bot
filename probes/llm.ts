/**
 * LLM probe: time to the first answer token and to the first speakable clause, per provider profile,
 * prompt size and cache state, plus how long each provider's prefix cache survives idle time.
 *
 *   npm run probe:llm -- [--profiles minimax-flash,minimax-m3,anthropic-haiku] [--runs 30]
 *                        [--sizes actual,20k] [--survival 0,1,5,15,30 | none] [--label local]
 *                        [--mode voice|text] [--out probes/results]
 *
 * Cold runs put a unique `probe-nonce` line at the very top of the stable prefix, so nothing can be
 * cached; warm runs reuse one stable prefix that a first, unmeasured call has warmed. Survival warms a
 * distinct prefix per delay, waits that many idle minutes and asks again; it runs alongside the
 * latency runs, so the longest delay sets the wall time.
 *
 * Writes <out>/llm-<date>-<label>.json and prints a summary. A profile whose API key is not in
 * .dev.vars or the environment is skipped with a note; with no keys at all the probe exits 0.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import bundleJson from "../knowledge/bundle.json" with { type: "json" };
import { createAnthropicCompatibleLlm } from "../src/adapters/anthropic-compatible";
import { LLM_PROFILES, estimateCostUsd, isLlmProfileId, type LlmProfile } from "../src/adapters/llm-profiles";
import { buildStable, buildTail, promptHash, wrapVisitorMessage, type ReplyMode } from "../src/core/prompt";
import { ReplySplitter } from "../src/core/reply-splitter";
import { REPLY_MAX_TOKENS } from "../src/core/respond";
import { SentenceSplitter } from "../src/core/sentences";
import { sha256Hex } from "../src/knowledge/build";
import type { Bundle } from "../src/knowledge/types";
import { LlmError, type LlmRequest, type LlmUsage } from "../src/ports/llm";
import { parseDataLine } from "../src/protocol/data-line";
import { cacheHit, prefixTokens } from "./lib/cache";
import { loadDevVars } from "./lib/env";
import { PROBE_QUESTIONS } from "./lib/questions";
import { summarize, type Summary } from "./lib/stats";

const BUNDLE: Bundle = bundleJson;
const SIZES = ["actual", "20k"] as const;
type SizeId = (typeof SIZES)[number];
const PADDED_TOKENS = 20_000;
const MODES: readonly ReplyMode[] = ["voice", "text"];
const CALL_TIMEOUT_MS = 60_000;
const G1_FIRST_TOKEN_P50_MS = 700;
const G2_FIRST_TOKEN_P50_MS = 1_000;

// ---------- 20k padding ----------

const FILLER_WORDS = (
  "the a of to and in for with on by system latency request cache module service review release pipeline " +
  "schema index query render deploy metric trace queue worker session payload token buffer stream socket " +
  "client server handler config policy budget sprint ticket design rollout migration contract fixture signal"
).split(" ");

/** mulberry32: a tiny seeded PRNG, so padding is byte-identical on every run and machine. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fillerSection(n: number): string {
  const rand = prng(n);
  const pick = () => FILLER_WORDS[Math.floor(rand() * FILLER_WORDS.length)] ?? "the";
  const sentences = Array.from({ length: 24 }, () => {
    const s = Array.from({ length: 8 + Math.floor(rand() * 9) }, pick).join(" ");
    return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
  });
  return [
    `## doc:probe-padding-${n} — Probe padding ${n}`,
    "Filler that brings the prompt to a realistic size for the latency probe. It holds no facts about Yash.",
    sentences.join(" "),
  ].join("\n");
}

/** The bundle plus deterministic `## doc:probe-padding-N` sections, up to ~`targetTokens` estimated tokens. */
function padBundle(bundle: Bundle, targetTokens: number): Bundle {
  const sections: string[] = [];
  let chars = bundle.text.length;
  while (Math.ceil(chars / 4) < targetTokens) {
    const section = fillerSection(sections.length + 1);
    sections.push(section);
    chars += section.length + 2;
  }
  // Same layout as the bundle build: sections separated by a blank line, a trailing newline.
  const text = `${bundle.text}\n${sections.join("\n\n")}\n`;
  const hash = sha256Hex(text);
  const padding = sections.map((_, i) => `doc:probe-padding-${i + 1}`);
  return {
    ...bundle,
    version: hash.slice(0, 12),
    hash,
    text,
    refs: [...bundle.refs, ...padding].sort(),
    titles: { ...bundle.titles, ...Object.fromEntries(padding.map((ref, i) => [ref, `Probe padding ${i + 1}`])) },
    tokenEstimate: Math.ceil(text.length / 4),
  };
}

// ---------- one measured call ----------

type Target = { profile: LlmProfile; apiKey: string };

/** Milliseconds from the start of the call; null when the moment never came. */
type Marks = {
  ttfb: number | null;
  firstReasoning: number | null;
  firstAnswerToken: number | null;
  firstClause: number | null;
  done: number | null;
};

type CallResult = {
  ok: boolean;
  error: string | null;
  marks: Marks;
  usage: LlmUsage | null;
  proseChars: number;
  dataLine: "ok" | "invalid" | "missing" | null;
};

function withNonce(stable: string, purpose: string): string {
  return `probe-nonce ${crypto.randomUUID()} (${purpose})\n\n${stable}`;
}

function describeError(e: unknown): string {
  if (e instanceof LlmError) return `${e.kind}: ${e.message}`;
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "TimeoutError") return `timed out after ${CALL_TIMEOUT_MS / 1000} s`;
  return e instanceof Error ? e.message : String(e);
}

/** One reply, built as `respond` builds it, timed at each mark. Never rejects. */
async function call(
  target: Target,
  stable: string,
  question: string,
  mode: ReplyMode,
  known: ReadonlySet<string>,
): Promise<CallResult> {
  const marks: Marks = { ttfb: null, firstReasoning: null, firstAnswerToken: null, firstClause: null, done: null };
  let t0 = performance.now();
  const since = () => Math.round((performance.now() - t0) * 10) / 10;
  // The port has no headers hook, so time the fetch: it resolves when the response headers arrive.
  const timedFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    marks.ttfb ??= since();
    return res;
  };
  const llm = createAnthropicCompatibleLlm({ profile: target.profile, apiKey: target.apiKey, fetch: timedFetch });
  const boundary = crypto.randomUUID();
  const req: LlmRequest = {
    stable,
    turns: [{ role: "user", text: wrapVisitorMessage(question, boundary) }],
    tail: buildTail({ mode, language: "en", boundary }),
    maxTokens: REPLY_MAX_TOKENS,
  };
  const reply = new ReplySplitter();
  const sentences = new SentenceSplitter();
  const clause = (ready: string[]) => {
    if (ready.length > 0) marks.firstClause ??= since();
  };
  let usage: LlmUsage | null = null;
  let proseChars = 0;

  t0 = performance.now();
  try {
    for await (const chunk of llm.stream(req, AbortSignal.timeout(CALL_TIMEOUT_MS))) {
      if (chunk.t === "reasoning") {
        marks.firstReasoning ??= since();
      } else if (chunk.t === "text") {
        marks.firstAnswerToken ??= since();
        const prose = reply.push(chunk.text);
        proseChars += prose.length;
        clause(sentences.push(prose));
        // As in respond: once the data line starts, the last sentence is ready.
        if (reply.metaStarted) clause(sentences.flush());
      } else {
        usage = chunk.usage;
      }
    }
    const end = reply.end();
    proseChars += end.prose.length;
    clause([...sentences.push(end.prose), ...sentences.flush()]);
    marks.done = since();
    // As in respond: a bare <refs> list in place of the data line is "invalid", not "missing".
    const dataLine =
      end.meta === null ? (end.refs !== undefined ? "invalid" : "missing") : parseDataLine(end.meta, known).ok ? "ok" : "invalid";
    return { ok: true, error: null, marks, usage, proseChars, dataLine };
  } catch (e) {
    return { ok: false, error: describeError(e), marks, usage, proseChars, dataLine: null };
  }
}

// ---------- cache survival ----------

type SurvivalCell = Target & { size: SizeId; delayMinutes: number; stable: string; known: ReadonlySet<string> };
type CacheReading = { ok: boolean; error: string | null; input: number | null; cachedInput: number | null };
type SurvivalRecord = {
  profile: string;
  size: SizeId;
  delayMinutes: number;
  /** The stable prefix's estimated tokens: a re-query is a cache hit when at least half of them were cached. */
  stableTokens: number;
  warm: CacheReading;
  requery: CacheReading & { idleMs: number };
};

const reading = (r: CallResult): CacheReading => ({
  ok: r.ok,
  error: r.error,
  input: r.usage?.input ?? null,
  cachedInput: r.usage?.cachedInput ?? null,
});
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Warms every cell at once; each then idles for its delay and asks again with the identical request. */
function startSurvival(cells: SurvivalCell[], mode: ReplyMode): { warmed: Promise<unknown>; done: Promise<SurvivalRecord[]> } {
  const question = PROBE_QUESTIONS[0] ?? "";
  const warming = cells.map((cell) => ({ cell, warm: call(cell, cell.stable, question, mode, cell.known) }));
  const done = Promise.all(
    warming.map(async ({ cell, warm }) => {
      const warmed = await warm;
      const idleFrom = performance.now();
      await sleep(cell.delayMinutes * 60_000);
      const idleMs = Math.round(performance.now() - idleFrom);
      const again = await call(cell, cell.stable, question, mode, cell.known);
      return {
        profile: cell.profile.id,
        size: cell.size,
        delayMinutes: cell.delayMinutes,
        stableTokens: prefixTokens(cell.stable),
        warm: reading(warmed),
        requery: { ...reading(again), idleMs },
      };
    }),
  );
  return { warmed: Promise.all(warming.map((w) => w.warm)), done };
}

// ---------- summary ----------

type RunRecord = CallResult & {
  profile: string;
  size: SizeId;
  cache: "cold" | "warm";
  run: number;
  question: number;
  costUsd: number | null;
};

type CellSummary = {
  profile: string;
  size: SizeId;
  cache: "cold" | "warm";
  runs: number;
  okRuns: number;
  ttfb: Summary;
  firstReasoning: Summary;
  firstAnswerToken: Summary;
  firstClause: Summary;
  done: Summary;
  meanPromptTokens: number;
  meanCachedInput: number;
  meanReasoning: number;
  meanOutput: number;
  meanCostUsd: number;
};

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN;
}

function summarizeCell(records: RunRecord[], key: Pick<CellSummary, "profile" | "size" | "cache">): CellSummary {
  const ok = records.filter((r) => r.ok);
  const mark = (m: keyof Marks) => summarize(ok.map((r) => r.marks[m] ?? Number.NaN));
  const usages = ok.flatMap((r) => (r.usage ? [r.usage] : []));
  return {
    ...key,
    runs: records.length,
    okRuns: ok.length,
    ttfb: mark("ttfb"),
    firstReasoning: mark("firstReasoning"),
    firstAnswerToken: mark("firstAnswerToken"),
    firstClause: mark("firstClause"),
    done: mark("done"),
    meanPromptTokens: mean(usages.map((u) => u.input + u.cachedInput)),
    meanCachedInput: mean(usages.map((u) => u.cachedInput)),
    meanReasoning: mean(usages.map((u) => u.reasoning)),
    meanOutput: mean(usages.map((u) => u.output)),
    meanCostUsd: mean(ok.flatMap((r) => (r.costUsd === null ? [] : [r.costUsd]))),
  };
}

const fmt = (x: number) => (Number.isFinite(x) ? `${Math.round(x)}` : "-");
const pair = (s: Summary) => `${fmt(s.p50)} / ${fmt(s.p95)}`;
const usd = (x: number) => (Number.isFinite(x) ? `$${x.toFixed(6)}` : "-");
const verdict = (x: number, limit: number) => (Number.isFinite(x) ? (x <= limit ? "PASS" : "FAIL") : "no data");

function printReport(o: {
  label: string;
  mode: ReplyMode;
  runs: number;
  summaries: CellSummary[];
  survival: SurvivalRecord[];
  delays: number[];
}): void {
  console.log(`\nLLM probe: ${o.label}, ${o.mode} mode, ${o.runs} runs per cell (ms: p50 / p95)`);
  console.log(
    `${"profile".padEnd(16)}${"size".padEnd(8)}${"cache".padEnd(7)}${"ok".padEnd(8)}${"prompt tok".padEnd(12)}` +
      `${"firstAnswerToken".padEnd(19)}${"firstClause".padEnd(16)}${"reason tok".padEnd(11)}cost/turn`,
  );
  for (const s of o.summaries) {
    console.log(
      `${s.profile.padEnd(16)}${s.size.padEnd(8)}${s.cache.padEnd(7)}${`${s.okRuns}/${s.runs}`.padEnd(8)}` +
        `${fmt(s.meanPromptTokens).padEnd(12)}${pair(s.firstAnswerToken).padEnd(19)}${pair(s.firstClause).padEnd(16)}` +
        `${fmt(s.meanReasoning).padEnd(11)}${usd(s.meanCostUsd)}`,
    );
  }

  if (o.survival.length > 0) {
    console.log(
      "\ncache survival: cachedInput on the re-query after N idle minutes; a hit caches at least half the stable " +
        "prefix (MiniMax reports about 128 cached tokens on every call, so any count above 0 is no hit)",
    );
    console.log(`${"profile".padEnd(16)}${"size".padEnd(8)}${o.delays.map((d) => `${d}m`.padStart(9)).join("")}`);
    const cells = new Map<string, SurvivalRecord[]>();
    for (const r of o.survival) cells.set(`${r.profile}|${r.size}`, [...(cells.get(`${r.profile}|${r.size}`) ?? []), r]);
    for (const [key, rs] of cells) {
      const [profile = "", size = ""] = key.split("|");
      const values = o.delays.map((d) => {
        const r = rs.find((x) => x.delayMinutes === d);
        return (r?.requery.ok ? fmt(r.requery.cachedInput ?? Number.NaN) : "error").padStart(9);
      });
      const survived = rs.every((r) => cacheHit(r.requery.cachedInput, r.stableTokens));
      console.log(`${profile.padEnd(16)}${size.padEnd(8)}${values.join("")}   G3 ${survived ? "survives every delay" : "lost at some delay"}`);
    }
  }

  const warmActual = o.summaries.filter((s) => s.size === "actual" && s.cache === "warm");
  if (warmActual.length > 0) console.log(`\nwarm, actual size, p50 firstAnswerToken from ${o.label}:`);
  for (const s of warmActual) {
    const p50 = s.firstAnswerToken.p50;
    console.log(
      `  ${s.profile.padEnd(16)}${fmt(p50).padStart(6)} ms   G1 voice ≤ ${G1_FIRST_TOKEN_P50_MS} ms: ${verdict(p50, G1_FIRST_TOKEN_P50_MS)}` +
        `   G2 text ≤ ${G2_FIRST_TOKEN_P50_MS} ms: ${verdict(p50, G2_FIRST_TOKEN_P50_MS)}`,
    );
  }
}

// ---------- main ----------

function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function isSize(s: string): s is SizeId {
  return (SIZES as readonly string[]).includes(s);
}

function isMode(s: string): s is ReplyMode {
  return (MODES as readonly string[]).includes(s);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      profiles: { type: "string", default: "minimax-flash,minimax-m3,anthropic-haiku" },
      runs: { type: "string", default: "30" },
      sizes: { type: "string", default: "actual,20k" },
      survival: { type: "string", default: "0,1,5,15,30" },
      label: { type: "string", default: "local" },
      mode: { type: "string", default: "voice" },
      out: { type: "string", default: resolve(import.meta.dirname, "results") },
    },
  });
  const profileIds = parseList(values.profiles);
  const unknown = profileIds.filter((id) => !isLlmProfileId(id));
  if (profileIds.length === 0 || unknown.length > 0) {
    throw new Error(`--profiles: unknown "${unknown.join(", ")}"; expected some of ${Object.keys(LLM_PROFILES).join(", ")}`);
  }
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  const sizes = parseList(values.sizes);
  if (sizes.length === 0 || !sizes.every(isSize)) throw new Error(`--sizes: expected some of ${SIZES.join(", ")}`);
  const delays = values.survival.trim() === "none" ? [] : parseList(values.survival).map(Number);
  if (!delays.every((d) => Number.isFinite(d) && d >= 0)) throw new Error("--survival: expected minutes like 0,1,5,15,30, or none");
  const mode = values.mode;
  if (!isMode(mode)) throw new Error(`--mode: expected ${MODES.join(" or ")}`);
  const label = values.label.replace(/[^a-z0-9-]+/gi, "-");

  const vars = loadDevVars();
  const targets: Target[] = [];
  const skipped: Record<string, string> = {};
  for (const id of profileIds) {
    if (!isLlmProfileId(id)) continue;
    const profile = LLM_PROFILES[id];
    const apiKey = vars[profile.keyEnv]?.trim();
    if (apiKey) {
      targets.push({ profile, apiKey });
    } else {
      skipped[id] = `${profile.keyEnv} not set`;
      console.log(`${id}: ${profile.keyEnv} not set; skipped`);
    }
  }
  if (targets.length === 0) {
    console.log("no provider keys found; skipped all profiles");
    return 0;
  }

  const prompts = new Map<SizeId, { bundle: Bundle; stable: string; known: ReadonlySet<string> }>();
  for (const size of sizes) {
    const bundle = size === "actual" ? BUNDLE : padBundle(BUNDLE, PADDED_TOKENS);
    prompts.set(size, { bundle, stable: buildStable(bundle), known: new Set(bundle.refs) });
  }
  const prompt = (size: SizeId) => {
    const p = prompts.get(size);
    if (!p) throw new Error(`no prompt for size ${size}`);
    return p;
  };
  const sizeInfo: Record<string, unknown> = {};
  for (const [size, p] of prompts) {
    sizeInfo[size] = {
      tokenEstimate: p.bundle.tokenEstimate,
      bundleVersion: p.bundle.version,
      stableChars: p.stable.length,
      promptHash: await promptHash(p.stable),
    };
  }
  console.log(
    `LLM probe ${label}: ${targets.map((t) => t.profile.id).join(", ")}; sizes ${sizes
      .map((s) => `${s} (~${prompt(s).bundle.tokenEstimate} knowledge tokens)`)
      .join(", ")}; ${runs} runs; ${mode} mode`,
  );

  const startedAt = new Date().toISOString();
  const survivalCells: SurvivalCell[] = targets.flatMap((t) =>
    sizes.flatMap((size) =>
      delays.map((delayMinutes) => ({
        ...t,
        size,
        delayMinutes,
        stable: withNonce(prompt(size).stable, `survival ${delayMinutes} min`),
        known: prompt(size).known,
      })),
    ),
  );
  const survival = startSurvival(survivalCells, mode);
  await survival.warmed; // keep the warm-up burst out of the latency runs

  const records: RunRecord[] = [];
  for (const target of targets) {
    for (const size of sizes) {
      const { stable, known } = prompt(size);
      await call(target, stable, PROBE_QUESTIONS[0] ?? "", mode, known); // warms the shared prefix; not measured
      let errors = 0;
      for (let run = 1; run <= runs; run++) {
        const question = (run - 1) % PROBE_QUESTIONS.length;
        for (const cache of ["cold", "warm"] as const) {
          const result = await call(
            target,
            cache === "cold" ? withNonce(stable, "cold") : stable,
            PROBE_QUESTIONS[question] ?? "",
            mode,
            known,
          );
          if (!result.ok) errors++;
          records.push({
            profile: target.profile.id,
            size,
            cache,
            run,
            question,
            ...result,
            costUsd: estimateCostUsd(result.usage, target.profile.prices),
          });
        }
      }
      console.log(`${target.profile.id} ${size}: ${runs} cold + ${runs} warm runs, ${errors} errors`);
    }
  }

  if (survivalCells.length > 0) {
    console.log(`waiting for the cache survival re-queries (longest delay ${Math.max(...delays)} min)…`);
  }
  const survivalRecords = await survival.done;

  const summaries = targets.flatMap((t) =>
    sizes.flatMap((size) =>
      (["cold", "warm"] as const).map((cache) =>
        summarizeCell(
          records.filter((r) => r.profile === t.profile.id && r.size === size && r.cache === cache),
          { profile: t.profile.id, size, cache },
        ),
      ),
    ),
  );

  mkdirSync(values.out, { recursive: true });
  const date = startedAt.slice(0, 10);
  const resultsPath = resolve(values.out, `llm-${date}-${label}.json`);
  const results = {
    probe: "llm",
    date,
    startedAt,
    label,
    mode,
    runs,
    survivalMinutes: delays,
    questions: PROBE_QUESTIONS,
    sizes: sizeInfo,
    profiles: profileIds.map((id) => {
      const p = isLlmProfileId(id) ? LLM_PROFILES[id] : null;
      return { id, model: p?.model ?? null, prices: p?.prices ?? null, skipped: skipped[id] ?? null };
    }),
    summary: summaries,
    survival: survivalRecords,
    records,
  };
  writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);

  printReport({ label, mode, runs, summaries, survival: survivalRecords, delays });
  const shown = relative(process.cwd(), resultsPath);
  console.log(`results: ${shown.startsWith("..") ? resultsPath : shown}`);
  const failedProfiles = targets.filter((t) => !records.some((r) => r.profile === t.profile.id && r.ok));
  for (const t of failedProfiles) {
    const first = records.find((r) => r.profile === t.profile.id && r.error);
    console.error(`${t.profile.id}: no successful run (${first?.error ?? "unknown error"})`);
  }
  return failedProfiles.length > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`llm probe failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
