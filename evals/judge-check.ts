/**
 * Judge calibration: scores every answer in evals/judge-set.json (15 good answers, and the same 15
 * with one planted defect each) and passes when the judge catches at least 95% of the planted
 * defects and flags at most 2% of the good answers. Run it after changing the judge's prompt, model
 * or effort, before trusting its scores.
 *
 *   npm run eval:judge
 *
 * A planted answer counts as caught when the judge reports any defect (the type it named is printed
 * too); a good answer counts as flagged when it reports any. A judge error counts against the judge
 * either way. Without ANTHROPIC_API_KEY it prints `skipped: no ANTHROPIC_API_KEY` and exits 0.
 */
import bundleJson from "../knowledge/bundle.json" with { type: "json" };
import { loadDevVars } from "../probes/lib/env";
import type { Bundle } from "../src/knowledge/types";
import { JUDGE_MODEL, JudgeSetSchema, judgeAnswer, type JudgeResult } from "./judge";
import judgeSetJson from "./judge-set.json" with { type: "json" };

const BUNDLE: Bundle = bundleJson;
const MIN_CAUGHT = 0.95;
const MAX_FALSE_FLAGS = 0.02;

function describe(r: JudgeResult): string {
  if (!r.ok) return `error: ${r.error}`;
  const types = r.verdict.defects.map((d) => d.type);
  return `score ${r.verdict.score}${types.length > 0 ? `, ${types.join(", ")}` : ""}`;
}

async function main(): Promise<number> {
  const apiKey = loadDevVars().ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("skipped: no ANTHROPIC_API_KEY");
    return 0;
  }
  const set = JudgeSetSchema.parse(judgeSetJson);
  console.log(`judge check: ${JUDGE_MODEL}, ${set.length} good and ${set.length} planted answers`);

  let caught = 0;
  let typed = 0;
  let falseFlags = 0;
  // One call at a time: 30 calls, and the order of the log follows the set.
  for (const e of set) {
    const ask = (answer: string, refs: readonly string[]) =>
      judgeAnswer({ apiKey, bundle: BUNDLE, question: e.question, answer, refs });
    const good = await ask(e.good, e.refs);
    const planted = await ask(e.planted.answer, e.planted.refs ?? e.refs);
    const goodFlagged = !good.ok || good.verdict.defects.length > 0;
    const plantedCaught = planted.ok && planted.verdict.defects.length > 0;
    if (goodFlagged) falseFlags++;
    if (plantedCaught) caught++;
    if (planted.ok && planted.verdict.defects.some((d) => d.type === e.planted.type)) typed++;
    console.log(
      `${e.id.padEnd(18)} good: ${goodFlagged ? "FLAGGED" : "clean"} (${describe(good)}); ` +
        `planted ${e.planted.type}: ${plantedCaught ? "caught" : "MISSED"} (${describe(planted)})`,
    );
  }

  const n = set.length;
  const caughtRate = caught / n;
  const falseFlagRate = falseFlags / n;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(`\ncaught: ${caught}/${n} (${pct(caughtRate)}, needs ≥ ${pct(MIN_CAUGHT)}); named the planted type: ${typed}/${n}`);
  console.log(`false flags: ${falseFlags}/${n} (${pct(falseFlagRate)}, needs ≤ ${pct(MAX_FALSE_FLAGS)})`);
  const passed = caughtRate >= MIN_CAUGHT && falseFlagRate <= MAX_FALSE_FLAGS;
  console.log(passed ? "judge check passed" : "judge check FAILED");
  return passed ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`judge check failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
