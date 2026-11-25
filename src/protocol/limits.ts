/**
 * The message and body limits, in a file with no imports so the browser client (and the UI in
 * other repos) can read them at runtime without pulling in zod.
 */

/** Longest visitor message, in UTF-16 code units: room for a pasted job description. The brain enforces it again after sanitizing. */
export const MAX_MESSAGE_CHARS = 12_000;

/** The longest voice transcript sent to the model; unchanged from before the paste limit rose. */
export const MAX_TRANSCRIPT_CHARS = 4_000;

/** A message longer than this counts as LONG_MESSAGE_TURNS turns. */
export const LONG_MESSAGE_CHARS = 4_000;
export const LONG_MESSAGE_TURNS = 3;

/** Request bodies above this are refused before parsing. */
export const MAX_BODY_BYTES = 65_536;

/** How many turns `message` (as sent to the model) counts as: 1, or LONG_MESSAGE_TURNS. */
export function turnsFor(message: string): number {
  return message.length > LONG_MESSAGE_CHARS ? LONG_MESSAGE_TURNS : 1;
}
