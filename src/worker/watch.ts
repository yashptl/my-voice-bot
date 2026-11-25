import { raiseAlert, reportOutage } from "./alerts";
import { runCanary, type CanaryResult } from "./canary";
import { missingConfig } from "./config";
import type { Env } from "./env";
import { clearOutage } from "./outage-flag";

/** A canary slower than this, end to end, raises the `slow` alert. */
export const SLOW_MS = 10_000;

const log = (level: "info" | "warn" | "error", line: string) => console[level](line);

/** Failures that asking again cannot change: config the owner must fix, or the owner's own switch. */
const isFinal = (r: CanaryResult) => r.reason === "not configured" || r.reason === "assistant is off";

/**
 * The hourly check: runs the canary, logs its outcome (never answer text) and acts on it. A failure
 * is run once more straight away, so one bad answer is not an outage: two in a row set the outage
 * flag and email the owner (`reportOutage`, one email per outage), and a pass clears the flag. A
 * first failure that the second run passes, or that it cannot repeat because the assistant is then
 * resting or off, raises `answer_failed`. A missing config raises
 * `misconfigured` and an assistant that is off on purpose logs only, each after a single run with the
 * flag untouched; a canary skipped as resting leaves the flag as it was.
 */
export async function watch(env: Env): Promise<void> {
  let r = await runCanary(env);
  let first: CanaryResult | null = null;
  if (!r.ok && !isFinal(r)) {
    console.error(`canary failed: ${r.reason}`);
    first = r;
    r = await runCanary(env);
  }
  /** The first run's failure, when the second run could not confirm or repeat it. */
  const droppedFirst = () => (first ? raiseAlert(env, "answer_failed", `canary failed once: ${first.reason ?? "unknown"}`, log) : undefined);
  if (r.skipped === "resting") {
    console.info("canary skipped: resting");
    await raiseAlert(env, "resting", "the day's shared turns are used up", log);
    await droppedFirst();
  } else if (r.ok) {
    console.info(`canary ok in ${r.ms} ms`);
    await clearOutage(env.DB).then(
      (wasSet) => wasSet && console.info("outage cleared"),
      (err: unknown) => console.error(`outage flag not cleared: ${err instanceof Error ? err.message : String(err)}`),
    );
    await droppedFirst();
    if (r.ms > SLOW_MS) await raiseAlert(env, "slow", `took ${r.ms} ms, over ${SLOW_MS} ms`, log);
  } else {
    console.error(`canary failed: ${r.reason}`);
    if (r.reason === "not configured") {
      await raiseAlert(env, "misconfigured", `missing: ${missingConfig(env).required.join(", ")}`, log);
    } else if (r.reason === "assistant is off") {
      await droppedFirst();
    } else {
      await reportOutage(env, r.reason ?? "unknown", log);
    }
  }
}
