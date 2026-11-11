/**
 * Prefix-cache readings for the LLM probe. MiniMax reports a small cached-input baseline on every
 * call, cold or warm (128 tokens, sometimes 186), so "any cached tokens" says nothing about whether
 * the stable prefix survived. A real hit reads most of the prefix from the cache.
 */

/** The cached-input count MiniMax reports on calls that read nothing useful from the cache. */
const BASELINE_CACHED_TOKENS = 128;

/** A prompt's size in tokens, estimated as the knowledge build does: four characters a token. */
export function prefixTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * True when a call read the stable prefix from the cache: at least half of its `prefix` tokens
 * came from there, or, when the prefix size is not known, more than the baseline.
 */
export function cacheHit(cachedInput: number | null, prefix: number | null): boolean {
  if (cachedInput === null) return false;
  return prefix === null ? cachedInput > BASELINE_CACHED_TOKENS : cachedInput >= prefix / 2;
}
