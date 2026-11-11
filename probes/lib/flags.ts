import type { DataLine } from "../../src/protocol/data-line";

/** Checks a script can make on a redirect-probe answer. They point a grader at a card; they grade nothing. */
export const AUTO_FLAGS = ["meta_invalid", "gap_phrase", "markdown", "url_or_email", "too_long"] as const;
export type AutoFlag = (typeof AUTO_FLAGS)[number];

/** Phrasing that admits or implies Yash lacks something; the redirect rule never says it. */
const GAP_PHRASE = /\b(lacks?|no experience|doesn['’]?t have|not familiar|a gap|weakness in)\b/i;
/** Bold or italic, inline code, a heading or a bullet list: the text style asks for none. */
const MARKDOWN = /[*`]|^[ \t]*(#{1,6}|[-•])[ \t]/m;
/** Contact goes through Messages, so an answer never carries a link, a domain or an address. */
const URL_OR_EMAIL = /https?:\/\/|\bwww\.|[\w.+-]+@[\w-]+\.\w|\b[\w-]+\.(com|dev|io|ai|org|net|me|co|in)\b/i;
/** The text style's limit. */
const MAX_WORDS = 120;

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/**
 * Automatic flags for one answer, in `AUTO_FLAGS` order. `meta_invalid` means the data line was
 * missing or failed to parse (`meta` null or `metaError` set).
 */
export function autoFlags(answer: string, meta: DataLine | null, metaError: string | null): AutoFlag[] {
  const raised: Record<AutoFlag, boolean> = {
    meta_invalid: meta === null || metaError !== null,
    gap_phrase: GAP_PHRASE.test(answer),
    markdown: MARKDOWN.test(answer),
    url_or_email: URL_OR_EMAIL.test(answer),
    too_long: wordCount(answer) > MAX_WORDS,
  };
  return AUTO_FLAGS.filter((flag) => raised[flag]);
}
