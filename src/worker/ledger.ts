import type { Log } from "./conversation-state";
import type { Env } from "./env";

/** What the day's shared ceilings count. Only model turns today. */
export type LedgerUnit = "turns";

export const DEFAULT_DAILY_TURNS = 400;
/** Daily counts are kept a week (today and the 6 days before), for the review page. */
export const DAILY_RETENTION_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC calendar date, `YYYY-MM-DD`: days roll over at UTC midnight. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Adds `n` to the day's count unless that would pass `ceiling`. One statement, so it is atomic
 * however many visitors spend at once: the insert (a new day) and the update both carry the
 * ceiling check. A refused spend changes nothing and returns no row.
 */
const SPEND = `
INSERT INTO daily (day, unit, used) SELECT ?1, ?2, ?3 WHERE ?3 <= ?4
ON CONFLICT (day, unit) DO UPDATE SET used = used + excluded.used WHERE used + excluded.used <= ?4
RETURNING used`;

/** Spends `n` of `day`'s `ceiling` for `unit`: the new count, or `ok: false` when it would pass the ceiling. */
export async function spend(
  db: D1Database,
  unit: LedgerUnit,
  n: number,
  ceiling: number,
  day: string,
): Promise<{ ok: true; used: number } | { ok: false }> {
  const row = await db.prepare(SPEND).bind(day, unit, n, ceiling).first<{ used: number }>();
  return row ? { ok: true, used: row.used } : { ok: false };
}

/** `day`'s count for `unit` so far; 0 when nothing was spent. */
export async function used(db: D1Database, unit: LedgerUnit, day: string): Promise<number> {
  const row = await db.prepare("SELECT used FROM daily WHERE day = ?1 AND unit = ?2").bind(day, unit).first<{ used: number }>();
  return row?.used ?? 0;
}

/** Deletes the counts of days that began more than DAILY_RETENTION_DAYS ago; returns how many rows went. */
export async function pruneDays(db: D1Database, now: number): Promise<number> {
  const cutoff = utcDay(now - DAILY_RETENTION_DAYS * DAY_MS);
  return (await db.prepare("DELETE FROM daily WHERE day <= ?1").bind(cutoff).run()).meta.changes;
}

/**
 * Spends one of today's (UTC) shared turns. False when the day's ceiling is reached, and also when
 * the database fails: an unchecked turn could pass the ceiling, so it fails closed.
 */
export async function spendTurn(env: Env, log: Log): Promise<boolean> {
  try {
    return (await spend(env.DB, "turns", 1, dailyTurns(env), utcDay(Date.now()))).ok;
  } catch (err) {
    log("error", `ledger failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Whether today's (UTC) shared turns are used up. True when the database fails, as spendTurn fails closed. */
export async function restingToday(env: Env, log: Log): Promise<boolean> {
  try {
    return (await used(env.DB, "turns", utcDay(Date.now()))) >= dailyTurns(env);
  } catch (err) {
    log("error", `ledger failed: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}

/** `DAILY_TURNS` as a whole number; missing or invalid falls back to 400. "0" pauses the assistant. */
export function dailyTurns(env: Env): number {
  const raw = env.DAILY_TURNS?.trim() ?? "";
  return /^\d+$/.test(raw) ? Number(raw) : DEFAULT_DAILY_TURNS;
}
