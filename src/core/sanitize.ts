import { MAX_MESSAGE_CHARS } from "../protocol/chat";

/**
 * Longest visitor message the brain accepts, in UTF-16 code units: the protocol's limit, enforced
 * again here because voice transcripts and history never pass the chat route's schema.
 */
export const MAX_INPUT_CHARS = MAX_MESSAGE_CHARS;

/**
 * Every Unicode format character (soft hyphen, zero-width, bidi marks and tag characters among
 * them), plus the whole tag block, whose unassigned first code point is not a format character.
 */
const INVISIBLE = /[\p{Cf}\u{E0000}-\u{E007F}]/gu;

/** NFKC-normalizes `text` and strips invisible characters: what look-alike and zero-width tricks reduce to. */
export function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE, "");
}

/**
 * Cleans untrusted visitor text before it reaches the model. NFKC-normalizes first, so look-alikes
 * such as a fullwidth underscore become what they imitate, then strips invisible characters, then caps.
 */
export function sanitizeInput(text: string): string {
  const clean = normalizeText(text);
  if (clean.length <= MAX_INPUT_CHARS) return clean;
  // Never leave half of a surrogate pair at the cut.
  const last = clean.charCodeAt(MAX_INPUT_CHARS - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? MAX_INPUT_CHARS - 1 : MAX_INPUT_CHARS;
  return clean.slice(0, end);
}
