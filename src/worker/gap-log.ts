import type { DataLine } from "../protocol/data-line";

/** How long gap rows are kept: the 30 days in docs/decisions/0002-data-handling.md. */
export const GAP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** A question the knowledge only partly covered, as a turn reports it. */
export interface Gap {
  mode: "text" | "voice";
  coverage: Exclude<DataLine["coverage"], "direct">;
  /** The refs the reply cited. */
  refs: readonly string[];
  /** As the visitor sent it (text) or as transcribed (voice), unredacted. */
  question: string;
}

/**
 * Writes one row to the gap log (migrations/0006_gaps.sql). Unlike the turn log this holds visitor
 * text, by the owner's decision: callers must never log it, and a failure must not echo it.
 */
export async function recordGap(db: D1Database, g: Gap & { conversationId: string }, at: number = Date.now()): Promise<void> {
  await db
    .prepare("INSERT INTO gaps (created_at, conversation, mode, coverage, refs, question) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(at, g.conversationId.slice(0, 8), g.mode, g.coverage, JSON.stringify(g.refs), g.question)
    .run();
}

/** Deletes gaps written more than GAP_RETENTION_MS before `now`; returns how many went. */
export async function pruneGaps(db: D1Database, now: number): Promise<number> {
  return (await db.prepare("DELETE FROM gaps WHERE created_at < ?1").bind(now - GAP_RETENTION_MS).run()).meta.changes;
}
