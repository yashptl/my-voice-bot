import type { Env } from "./env";
import type { Log } from "./conversation-state";
import { refund, spend, utcDay, voiceUsedUp } from "./ledger";
import { markOutageAlerted, readOutage, setOutage } from "./outage-flag";

/**
 * What an alert email is about: `outage` the provider failing for good (the assistant rests),
 * `answer_failed` an answer a visitor or the canary saw fail, `voice_failed` speech that broke,
 * `slow` a slow canary, `resting` the day's turns used up, `misconfigured` missing config,
 * `voice_resting` the day's listening seconds or spoken characters used up, `visitors_blocked`
 * Turnstile itself failing so every visitor is refused, and `weekly` the weekly summary (counts
 * only, which also shows the bot and its email are alive).
 */
export type AlertKind =
  | "outage"
  | "answer_failed"
  | "voice_failed"
  | "slow"
  | "resting"
  | "misconfigured"
  | "voice_resting"
  | "visitors_blocked"
  | "weekly";

/**
 * Emails the owner, at most once per kind per UTC day. The day's claim is `alert:<kind>` with
 * ceiling 1 in the `daily` table (one atomic upsert, like a spend), taken before sending. The body
 * is the kind, the UTC time and `reason`, which must never hold visitor text. Returns "sent";
 * "already" when today's email for the kind went out; "unsent" without ALERT_TO or the ALERT_EMAIL
 * binding (a warning, and no claim, so fixing the config still gets its email); "failed" when
 * sending failed (the claim is given back, so the next run tries again). If the claim itself fails with a
 * database error, the email is sent anyway and the failure logged: an outage must not silence the alert.
 */
export async function raiseAlert(
  env: Env,
  kind: AlertKind,
  reason: string,
  log: Log,
  now: number = Date.now(),
): Promise<"sent" | "already" | "unsent" | "failed"> {
  return sendClaimed(
    env,
    kind,
    `Assistant alert: ${kind}`,
    `Alert: ${kind}\nTime (UTC): ${new Date(now).toISOString()}\nReason: ${reason}\n`,
    log,
    now,
  );
}

/** Emails the weekly summary (weekly.ts), once per UTC day, under the same claim and refund rules as an alert. */
export function sendWeeklySummary(env: Env, text: string, log: Log, now: number): Promise<"sent" | "already" | "unsent" | "failed"> {
  return sendClaimed(env, "weekly", "Assistant weekly summary", text, log, now);
}

/** Raises `voice_resting` when the day's shared listening seconds or spoken characters are used up. Never throws. */
export async function reportVoiceUsedUp(env: Env, log: Log, now: number = Date.now()): Promise<void> {
  try {
    const unit = await voiceUsedUp(env, log);
    if (unit === null) return;
    const what = unit === "voice_seconds" ? "listening seconds" : "spoken characters";
    await raiseAlert(env, "voice_resting", `the day's ${what} are used up`, log, now);
  } catch (err) {
    log("error", `voice alert failed: ${message(err)}`);
  }
}

/**
 * Claims `alert:<kind>` for the UTC day, then sends one email with `subject` and `text`. What
 * `raiseAlert` documents about claiming, refunding and logging applies to every kind.
 */
async function sendClaimed(
  env: Env,
  kind: AlertKind,
  subject: string,
  text: string,
  log: Log,
  now: number,
): Promise<"sent" | "already" | "unsent" | "failed"> {
  const to = env.ALERT_TO?.trim();
  const binding = env.ALERT_EMAIL;
  if (!to || !binding) {
    log("warn", `alert ${kind} not sent: ALERT_TO or the ALERT_EMAIL binding is missing`);
    return "unsent";
  }
  const unit = `alert:${kind}`;
  const day = utcDay(now);
  let claimed = true;
  try {
    if (!(await spend(env.DB, unit, 1, 1, day)).ok) return "already";
  } catch (err) {
    // A database that is down is the very outage to report: send unclaimed. That is at most hourly from the cron, but an alert raised from a visitor's turn can also send unclaimed when its claim fails.
    log("error", `alert ${kind} claim failed, sending anyway: ${message(err)}`);
    claimed = false;
  }
  try {
    await binding.send({
      to,
      from: env.ALERT_FROM?.trim() || "assistant@yashos.dev",
      subject,
      text,
    });
    return "sent";
  } catch (err) {
    log("error", `alert ${kind} not sent: ${message(err)}`);
    if (claimed) await refund(env.DB, unit, 1, day).catch(() => {});
    return "failed";
  }
}

/**
 * Sets the outage flag (keeping an earlier reason) and, unless this outage's email already went
 * out, raises the "outage" alert; "sent" or "already" marks the flag alerted, "failed" or "unsent"
 * leaves it for the next call. If the flag cannot be read or written, the alert is raised anyway.
 * Never throws.
 */
export async function reportOutage(env: Env, reason: string, log: Log, now: number = Date.now()): Promise<void> {
  let flag: { reason: string; alerted: boolean } | null = null;
  try {
    await setOutage(env.DB, reason, now);
    flag = await readOutage(env.DB);
  } catch (err) {
    log("error", `outage flag failed: ${message(err)}`);
  }
  if (flag?.alerted) return;
  const result = await raiseAlert(env, "outage", flag?.reason ?? reason, log, now);
  if (flag && (result === "sent" || result === "already")) {
    await markOutageAlerted(env.DB, now).catch((err: unknown) => log("error", `outage flag failed: ${message(err)}`));
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
