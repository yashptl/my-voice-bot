import type { Env } from "./env";
import type { Log } from "./conversation-state";
import { refund, spend, utcDay } from "./ledger";

/** What an alert email is about. */
export type AlertKind = "canary_failed" | "slow" | "resting" | "misconfigured";

/**
 * Emails the owner, at most once per kind per UTC day. The day's claim is `alert:<kind>` with
 * ceiling 1 in the `daily` table (one atomic upsert, like a spend), taken before sending. The body
 * is the kind, the UTC time and `reason`, which must never hold visitor text. Returns "sent";
 * "already" when today's email for the kind went out; "unsent" without ALERT_TO or the ALERT_EMAIL
 * binding (a warning, and no claim, so fixing the config still gets its email); "failed" when
 * sending or the database failed (the claim is given back, so the next run tries again).
 */
export async function raiseAlert(
  env: Env,
  kind: AlertKind,
  reason: string,
  log: Log,
  now: number = Date.now(),
): Promise<"sent" | "already" | "unsent" | "failed"> {
  const to = env.ALERT_TO?.trim();
  const binding = env.ALERT_EMAIL;
  if (!to || !binding) {
    log("warn", `alert ${kind} not sent: ALERT_TO or the ALERT_EMAIL binding is missing`);
    return "unsent";
  }
  const unit = `alert:${kind}`;
  const day = utcDay(now);
  try {
    if (!(await spend(env.DB, unit, 1, 1, day)).ok) return "already";
  } catch (err) {
    log("error", `alert ${kind} not sent: ${message(err)}`);
    return "failed";
  }
  try {
    await binding.send({
      to,
      from: env.ALERT_FROM?.trim() || "assistant@yashos.dev",
      subject: `Assistant alert: ${kind}`,
      text: `Alert: ${kind}\nTime (UTC): ${new Date(now).toISOString()}\nReason: ${reason}\n`,
    });
    return "sent";
  } catch (err) {
    log("error", `alert ${kind} not sent: ${message(err)}`);
    await refund(env.DB, unit, 1, day).catch(() => {});
    return "failed";
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
