import { sendWeeklySummary } from "./alerts";
import type { Log } from "./conversation-state";
import type { Env } from "./env";
import { utcDay } from "./ledger";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The summary goes out on the first hourly run from this UTC hour on a Monday, so a missed hour is caught by the next. */
const FROM_HOUR_UTC = 3;

interface Counts {
  answers: number;
  text: number;
  voice: number;
  failed: number;
  listenSeconds: number;
  gaps: number;
  checksOk: number;
  checksFailed: number;
}

/**
 * Counts for the 7 days before `now`. Numbers only: nothing a visitor said ever reaches the email.
 * An interrupted answer is not a failed one.
 */
async function readCounts(db: D1Database, now: number): Promise<Counts> {
  const since = now - 7 * DAY_MS;
  const turns = await db
    .prepare(
      `SELECT
         COUNT(CASE WHEN source = 'visitor' THEN 1 END) AS answers,
         COUNT(CASE WHEN source = 'visitor' AND mode = 'text' THEN 1 END) AS text,
         COUNT(CASE WHEN source = 'visitor' AND mode = 'voice' THEN 1 END) AS voice,
         COUNT(CASE WHEN source = 'visitor' AND error IS NOT NULL AND interrupted = 0 THEN 1 END) AS failed,
         COALESCE(SUM(CASE WHEN source = 'visitor' THEN audio_in_seconds END), 0) AS listen_seconds,
         COUNT(CASE WHEN source = 'canary' AND error IS NULL THEN 1 END) AS checks_ok,
         COUNT(CASE WHEN source = 'canary' AND error IS NOT NULL THEN 1 END) AS checks_failed
       FROM turns WHERE created_at >= ?1 AND created_at <= ?2`,
    )
    .bind(since, now)
    .first<Record<string, number>>();
  const gaps = await db
    .prepare("SELECT COUNT(*) AS n FROM gaps WHERE created_at >= ?1 AND created_at <= ?2")
    .bind(since, now)
    .first<{ n: number }>();
  return {
    answers: turns?.answers ?? 0,
    text: turns?.text ?? 0,
    voice: turns?.voice ?? 0,
    failed: turns?.failed ?? 0,
    listenSeconds: turns?.listen_seconds ?? 0,
    gaps: gaps?.n ?? 0,
    checksOk: turns?.checks_ok ?? 0,
    checksFailed: turns?.checks_failed ?? 0,
  };
}

/**
 * The weekly summary email: counts for the 7 days before `now`, sent on Mondays (UTC) from 03:00.
 * It also proves the bot and its email are alive: if it stops coming, something is down. Called
 * hourly from the cron; the per-day claim in `sendWeeklySummary` lets only the first run through,
 * so a missed hour is caught by the next, and it sends even when the assistant is switched off.
 * A failed query is logged and sends nothing. Never throws.
 */
export async function weeklySummary(env: Env, log: Log, now: number = Date.now()): Promise<void> {
  const at = new Date(now);
  if (at.getUTCDay() !== 1 || at.getUTCHours() < FROM_HOUR_UTC) return;
  let c: Counts;
  try {
    c = await readCounts(env.DB, now);
  } catch (err) {
    log("error", `weekly summary failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const text =
    [
      `Week to ${utcDay(now)} (UTC)`,
      `Visitor answers: ${c.answers} (${c.text} text, ${c.voice} voice)`,
      `Failed answers: ${c.failed}`,
      `Listening: ${(c.listenSeconds / 60).toFixed(1)} minutes`,
      `Questions not fully answered: ${c.gaps}`,
      `Hourly checks: ${c.checksOk} answered, ${c.checksFailed} failed`,
    ].join("\n") + "\n";
  await sendWeeklySummary(env, text, log, now);
}
