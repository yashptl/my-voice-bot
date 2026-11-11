import { raiseAlert } from "./alerts";
import { runCanary } from "./canary";
import { missingConfig } from "./config";
import type { Env } from "./env";

/** A canary slower than this, end to end, raises the `slow` alert. */
export const SLOW_MS = 10_000;

const log = (level: "info" | "warn" | "error", line: string) => console[level](line);

/**
 * The hourly check: runs the canary, logs its outcome (never answer text) and raises the alert it
 * calls for (alerts.ts, once per kind per day). A missing config raises `misconfigured` rather than
 * `canary_failed`; an assistant that is off on purpose logs but does not alert.
 */
export async function watch(env: Env): Promise<void> {
  const r = await runCanary(env);
  if (r.skipped === "resting") {
    console.info("canary skipped: resting");
    await raiseAlert(env, "resting", "the day's shared turns are used up", log);
  } else if (r.ok) {
    console.info(`canary ok in ${r.ms} ms`);
    if (r.ms > SLOW_MS) await raiseAlert(env, "slow", `took ${r.ms} ms, over ${SLOW_MS} ms`, log);
  } else {
    console.error(`canary failed: ${r.reason}`);
    if (r.reason === "not configured") {
      await raiseAlert(env, "misconfigured", `missing: ${missingConfig(env).required.join(", ")}`, log);
    } else if (r.reason !== "assistant is off") {
      await raiseAlert(env, "canary_failed", r.reason ?? "unknown", log);
    }
  }
}
