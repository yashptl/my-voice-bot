import type { Log } from "./conversation-state";
import type { Env } from "./env";
import { visitorKey } from "./visitor";

/** What the day's shared ceilings count: model turns, mic seconds sent to Flux, characters sent to MiniMax speech. */
export type LedgerUnit = "turns" | "voice_seconds" | "tts_chars";
/** The units voice reserves ahead of use, giving back what it did not use. */
export type VoiceUnit = Exclude<LedgerUnit, "turns">;

/** Each unit's daily ceiling when its var is missing; wrangler.jsonc sets the same values. */
export const DEFAULT_CEILINGS: Readonly<Record<LedgerUnit, number>> = { turns: 400, voice_seconds: 1800, tts_chars: 60_000 };
/** Model turns per visitor (client IP) per day when DAILY_TURNS_PER_IP is missing. */
export const DEFAULT_TURNS_PER_IP = 60;

const CEILING_VARS = {
  turns: "DAILY_TURNS",
  voice_seconds: "DAILY_VOICE_SECONDS",
  tts_chars: "DAILY_TTS_CHARS",
} as const satisfies Record<LedgerUnit, keyof Env>;
type CountVar = (typeof CEILING_VARS)[LedgerUnit] | "DAILY_TURNS_PER_IP";

/** Mic audio is reserved from `voice_seconds` this many seconds at a time (voice-loop.ts). */
export const AUDIO_BLOCK_SECONDS = 15;
/** The most one voice reply speaks; reserved from `tts_chars` as each voice turn starts. The rest shows as text. */
export const MAX_SPOKEN_CHARS = 500;
/** What one reservation of each voice unit takes: voice rests for the day once either no longer fits. */
const RESERVATION: Readonly<Record<VoiceUnit, number>> = { voice_seconds: AUDIO_BLOCK_SECONDS, tts_chars: MAX_SPOKEN_CHARS };

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

/** Only that day's row, which a refund never creates or takes below 0. */
const REFUND = "UPDATE daily SET used = MAX(0, used - ?3) WHERE day = ?1 AND unit = ?2";

/** SPEND for one visitor's model turns: one at a time, up to `?3`. */
const SPEND_VISITOR = `
INSERT INTO daily_ip (day, ip_hash, used) SELECT ?1, ?2, 1 WHERE 1 <= ?3
ON CONFLICT (day, ip_hash) DO UPDATE SET used = used + 1 WHERE used + 1 <= ?3
RETURNING used`;

const REFUND_VISITOR = "UPDATE daily_ip SET used = MAX(0, used - 1) WHERE day = ?1 AND ip_hash = ?2";

type Spent = { ok: true; used: number } | { ok: false };

/** Spends `n` of `day`'s `ceiling` for `unit`: the new count, or `ok: false` when it would pass the ceiling. */
export async function spend(db: D1Database, unit: LedgerUnit, n: number, ceiling: number, day: string): Promise<Spent> {
  const row = await db.prepare(SPEND).bind(day, unit, n, ceiling).first<{ used: number }>();
  return row ? { ok: true, used: row.used } : { ok: false };
}

/**
 * Gives `n` of `unit` back to `day`. The caller passes the day it spent from, so a refund that runs
 * after UTC midnight cannot credit the new day.
 */
export async function refund(db: D1Database, unit: LedgerUnit, n: number, day: string): Promise<void> {
  await db.prepare(REFUND).bind(day, unit, n).run();
}

/** `day`'s count for `unit` so far; 0 when nothing was spent. */
export async function used(db: D1Database, unit: LedgerUnit, day: string): Promise<number> {
  const row = await db.prepare("SELECT used FROM daily WHERE day = ?1 AND unit = ?2").bind(day, unit).first<{ used: number }>();
  return row?.used ?? 0;
}

/** Spends one of the visitor's (`key`, from visitorKey) model turns for `day`, up to `ceiling`. */
export async function spendVisitor(db: D1Database, key: string, ceiling: number, day: string): Promise<Spent> {
  const row = await db.prepare(SPEND_VISITOR).bind(day, key, ceiling).first<{ used: number }>();
  return row ? { ok: true, used: row.used } : { ok: false };
}

export async function refundVisitor(db: D1Database, key: string, day: string): Promise<void> {
  await db.prepare(REFUND_VISITOR).bind(day, key).run();
}

/** Deletes the counts of days that began more than DAILY_RETENTION_DAYS ago; returns how many rows went. */
export async function pruneDays(db: D1Database, now: number): Promise<number> {
  const cutoff = utcDay(now - DAILY_RETENTION_DAYS * DAY_MS);
  return (await db.prepare("DELETE FROM daily WHERE day <= ?1").bind(cutoff).run()).meta.changes;
}

/** Deletes the per-visitor counts of every day that is over (UTC); returns how many rows went. */
export async function pruneVisitors(db: D1Database, now: number): Promise<number> {
  return (await db.prepare("DELETE FROM daily_ip WHERE day < ?1").bind(utcDay(now)).run()).meta.changes;
}

/** `unit`'s daily ceiling, from its var (see wholeVar). */
export function ceiling(env: Env, unit: LedgerUnit, log: Log): number {
  return wholeVar(env, CEILING_VARS[unit], DEFAULT_CEILINGS[unit], log);
}

/** Model turns per visitor per day, from DAILY_TURNS_PER_IP (see wholeVar). */
export function turnsPerIp(env: Env, log: Log): number {
  return wholeVar(env, "DAILY_TURNS_PER_IP", DEFAULT_TURNS_PER_IP, log);
}

/**
 * A count var as a whole number. Missing: `fallback`. Set to anything else: 0, which pauses what
 * it counts, and an error in the log, so a typo fails closed instead of quietly meaning the default.
 */
function wholeVar(env: Env, name: CountVar, fallback: number, log: Log): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = raw.trim();
  if (/^\d+$/.test(value)) return Number(value);
  log("error", `${name} is not a whole number; counting it as 0 (paused) until it is fixed`);
  return 0;
}

export type TurnSpend = "ok" | "limit" | "resting";

/**
 * Spends one model turn today (UTC): one of the visitor's (DAILY_TURNS_PER_IP, keyed by visitorKey)
 * and one of everyone's (DAILY_TURNS). The two run concurrently, so a turn waits one D1 round trip.
 * If either is refused or fails, the other is given back, so a refused turn costs nothing.
 *
 * "limit": only the visitor's day is used. "resting": everyone's is, or the database or IP_HASH_KEY
 * is missing: an unchecked turn could pass a ceiling, so it fails closed.
 */
export async function spendTurn(env: Env, ip: string, log: Log): Promise<TurnSpend> {
  const day = utcDay(Date.now());
  const key = keyFor(env, day, ip);
  const [visitor, everyone] = await Promise.all([
    outcome(
      key.then((k) => spendVisitor(env.DB, k, turnsPerIp(env, log), day)),
      log,
    ),
    outcome(spend(env.DB, "turns", 1, ceiling(env, "turns", log), day), log),
  ]);
  if (visitor === "ok" && everyone === "ok") return "ok";
  await Promise.all([
    visitor === "ok" && quietly(key.then((k) => refundVisitor(env.DB, k, day)), log),
    everyone === "ok" && quietly(refund(env.DB, "turns", 1, day), log),
  ]);
  return visitor === "refused" && everyone === "ok" ? "limit" : "resting";
}

async function keyFor(env: Env, day: string, ip: string): Promise<string> {
  const secret = env.IP_HASH_KEY?.trim();
  if (!secret) throw new Error("IP_HASH_KEY is not set");
  return visitorKey(secret, day, ip);
}

/**
 * Takes `n` of today's (UTC) `unit` ahead of use. The day it came from, for `release`; null when it
 * would pass the ceiling, and when the database fails (fails closed).
 */
export async function reserve(env: Env, unit: VoiceUnit, n: number, log: Log): Promise<string | null> {
  const day = utcDay(Date.now());
  return (await outcome(spend(env.DB, unit, n, ceiling(env, unit, log), day), log)) === "ok" ? day : null;
}

/** Gives back `n` of what `reserve` took on `day`. A failure is logged: the reservation then stands. */
export function release(env: Env, unit: VoiceUnit, n: number, day: string, log: Log): Promise<void> {
  return quietly(refund(env.DB, unit, n, day), log);
}

/** Whether today's (UTC) shared turns are used up. True when the database fails, as spendTurn fails closed. */
export async function restingToday(env: Env, log: Log): Promise<boolean> {
  try {
    return (await used(env.DB, "turns", utcDay(Date.now()))) >= ceiling(env, "turns", log);
  } catch (err) {
    logFailure(log, err);
    return true;
  }
}

/**
 * Whether `unit` has less than one reservation (a 15 s audio block, or one reply's 500 characters)
 * left today (UTC). True when the database fails.
 */
export async function voiceUnitResting(env: Env, unit: VoiceUnit, log: Log): Promise<boolean> {
  try {
    return (await used(env.DB, unit, utcDay(Date.now()))) + RESERVATION[unit] > ceiling(env, unit, log);
  } catch (err) {
    logFailure(log, err);
    return true;
  }
}

/** Whether voice rests today: its next audio block or its next reply's speech would pass a ceiling. */
export async function voiceRestingToday(env: Env, log: Log): Promise<boolean> {
  const resting = await Promise.all([voiceUnitResting(env, "voice_seconds", log), voiceUnitResting(env, "tts_chars", log)]);
  return resting.some(Boolean);
}

/** "ok", "refused" (it would pass the ceiling), or "failed" (logged). */
async function outcome(spent: Promise<Spent>, log: Log): Promise<"ok" | "refused" | "failed"> {
  try {
    return (await spent).ok ? "ok" : "refused";
  } catch (err) {
    logFailure(log, err);
    return "failed";
  }
}

/** A refund whose failure is logged, never thrown: the spend then stands, which is the safe direction. */
async function quietly(refunding: Promise<void>, log: Log): Promise<void> {
  try {
    await refunding;
  } catch (err) {
    logFailure(log, err);
  }
}

function logFailure(log: Log, err: unknown): void {
  log("error", `ledger failed: ${err instanceof Error ? err.message : String(err)}`);
}
