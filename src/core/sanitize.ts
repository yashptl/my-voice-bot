import { MAX_MESSAGE_CHARS } from "../protocol/chat";

/**
 * Longest visitor message the brain accepts, in UTF-16 code units: the protocol's limit, enforced
 * again here because voice transcripts and history never pass the chat route's schema.
 */
export const MAX_INPUT_CHARS = MAX_MESSAGE_CHARS;

/**
 * Invisible characters that can hide instructions from a human reader: Unicode tag characters,
 * zero-width characters, and bidi marks, embeddings, overrides and isolates.
 */
const INVISIBLE = /[\u{E0000}-\u{E007F}\u200B-\u200F\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/gu;

/** Cleans untrusted visitor text before it reaches the model. Strips first, then caps. */
export function sanitizeInput(text: string): string {
  const clean = text.replace(INVISIBLE, "");
  if (clean.length <= MAX_INPUT_CHARS) return clean;
  // Never leave half of a surrogate pair at the cut.
  const last = clean.charCodeAt(MAX_INPUT_CHARS - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? MAX_INPUT_CHARS - 1 : MAX_INPUT_CHARS;
  return clean.slice(0, end);
}
