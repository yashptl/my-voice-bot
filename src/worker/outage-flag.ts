/** The one row of `flags` this module owns (migrations/0007_flags.sql). */
const OUTAGE = "outage";

/** The flag, or null when the assistant is not resting for an outage. Throws when the database fails. */
export async function readOutage(db: D1Database): Promise<{ reason: string; setAt: number; alerted: boolean } | null> {
  const row = await db
    .prepare("SELECT reason, set_at, alerted_at FROM flags WHERE name = ?1")
    .bind(OUTAGE)
    .first<{ reason: string; set_at: number; alerted_at: number | null }>();
  return row ? { reason: row.reason, setAt: row.set_at, alerted: row.alerted_at !== null } : null;
}

/** Records that the owner's email for this outage went out. */
export async function markOutageAlerted(db: D1Database, now: number): Promise<void> {
  await db.prepare("UPDATE flags SET alerted_at = ?2 WHERE name = ?1").bind(OUTAGE, now).run();
}

/** Sets it; true when it was not already set (the first reason is kept). */
export async function setOutage(db: D1Database, reason: string, now: number): Promise<boolean> {
  const result = await db
    .prepare("INSERT INTO flags (name, reason, set_at) VALUES (?1, ?2, ?3) ON CONFLICT (name) DO NOTHING")
    .bind(OUTAGE, reason, now)
    .run();
  return result.meta.changes > 0;
}

/** Clears it; true when it was set. */
export async function clearOutage(db: D1Database): Promise<boolean> {
  const result = await db.prepare("DELETE FROM flags WHERE name = ?1").bind(OUTAGE).run();
  return result.meta.changes > 0;
}
