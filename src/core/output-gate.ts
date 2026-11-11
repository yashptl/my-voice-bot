import { GATE_FLAGS, GATE_REASONS, type GateFlag, type GateReason, type GateSummary } from "../protocol/turn-record";

/** Shown in place of an answer whose every sentence the gate dropped. It passes the gate itself. */
export const GATE_FALLBACK = "I can't share that here. Messages is the best way to reach Yash.";

/** Shown when the reply had nothing to show and the gate dropped nothing. It passes the gate itself. */
export const EMPTY_FALLBACK = "Sorry, I couldn't put an answer together. Could you ask that again?";

/** Copying this many consecutive words from the visitor means the model is repeating what it was fed. */
const COPY_WORDS = 10;
const MAX_WORDS = 60;
const MIN_PHONE_DIGITS = 10;

const URL = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|dev|io|ai|org|net|app|co|in|me)\b/i;
/** Dotted product names that look like a domain but are not links; removed before the URL rule runs. */
const PRODUCT_NAMES = /\b(?:socket\.io|asp\.net)\b(?!\.?[a-z0-9-])/gi;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
/** A digit run with separators; it is a phone number only with enough digits ("2021-2023" is not). */
const PHONE_LIKE = /\+?\d[\d\s().-]{6,}\d/g;
/** A year range at the start of a digit run, as in "2022-2023 (13 months)": its digits are not a phone's. */
const LEADING_YEAR_RANGE = /^(?:19|20)\d\d\s*-\s*(?:19|20)\d\d(?!\d)/;
const CODE = [/```/, /\b(?:function|const|let|var|def|class|import)\s+[A-Za-z_]\w*\s*[=({:]/, /=>\s*[{(]/];
const PROFANITY = /\b(?:fuck|fucking|shit|bitch|bastard|asshole|cunt)\b/i;
const HYPE =
  /\b(?:passionate|rockstar|rock\s+star|world-class|cutting-edge|seamless|seamlessly|game-changing|ninja|guru|synergy|visionary)\b/i;

/**
 * Markdown the prompt forbids but models still write. Leading markers go first, so a `*` list
 * marker is never read as the start of italics. A bare list number ("1.", which the sentence
 * splitter cuts off on its own) strips to nothing. `*x*` needs non-space inside, so "2 * 3" stays.
 */
const MARKDOWN: [RegExp, string][] = [
  // The reply's own markup is never shown or spoken, whatever the splitter let through.
  [/<refs>[^<]*<\/refs>/gi, ""],
  [/<\/?(?:refs|meta)\s*>/gi, ""],
  [/^#+(?:\s+|$)/, ""],
  [/^(?:[-*•]|\d{1,2}\.)(?:\s+|$)/, ""],
  [/\*\*(.+?)\*\*/g, "$1"],
  [/__(.+?)__/g, "$1"],
  [/`([^`]+)`/g, "$1"],
  [/\*([^*\s](?:[^*]*[^*\s])?)\*/g, "$1"],
];

/**
 * He, she and their forms, which RULES forbid for Yash but models still write. Lowercase and
 * capitalized only, so an all-caps "HE" (an acronym) is left alone.
 */
const PRONOUN = /\b(?:[Hh]e|[Hh]im|[Hh]is|[Hh]imself|[Ss]he|[Hh]er|[Hh]ers|[Hh]erself)\b/g;
const POSSESSIVE = new Set(["his", "hers"]);
/**
 * "her" is possessive before a noun ("her team") and an object before these ("ask her about it",
 * "gave her the lead"): prepositions, conjunctions and articles.
 */
const NOT_AFTER_POSSESSIVE = new Set([
  "a", "an", "the",
  "and", "or", "but", "nor", "so", "yet", "because", "although", "while", "when", "if", "as", "than", "that",
  "about", "above", "across", "after", "against", "along", "among", "around", "at", "before", "behind", "below",
  "beside", "between", "beyond", "by", "despite", "down", "during", "except", "for", "from", "in", "inside",
  "into", "like", "near", "of", "off", "on", "onto", "out", "over", "past", "since", "through", "to", "toward",
  "towards", "under", "until", "up", "upon", "with", "within", "without",
]);

/** The sentence with every he or she form replaced by Yash or Yash's. */
function namePronouns(text: string): string {
  return text.replace(PRONOUN, (word, offset: number) => {
    const lower = word.toLowerCase();
    if (POSSESSIVE.has(lower)) return "Yash's";
    if (lower !== "her") return "Yash";
    const next = /^\s+([A-Za-z]+)/.exec(text.slice(offset + word.length))?.[1];
    return next && !NOT_AFTER_POSSESSIVE.has(next.toLowerCase()) ? "Yash's" : "Yash";
  });
}

export interface GateResult {
  /** The sentence with markdown stripped and pronouns named: what is shown or spoken when nothing blocked it. */
  text: string;
  /** Why the sentence must be dropped, in GATE_REASONS order; empty when it passes. */
  blocked: GateReason[];
  /** What was noted on the way through, in GATE_FLAGS order. */
  flags: GateFlag[];
}

/** Words as the copy and length checks count them: lowercased, letters and digits only. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
}

function stripMarkdown(text: string): string {
  return MARKDOWN.reduce((s, [pattern, replacement]) => s.replace(pattern, replacement), text.trim()).trim();
}

/** Only the leading year range is set aside, so a number after one ("2019-2020 (416) 555-1234") still counts. */
function hasPhone(text: string): boolean {
  return [...text.matchAll(PHONE_LIKE)].some(
    (m) => m[0].replace(LEADING_YEAR_RANGE, "").replace(/\D/g, "").length >= MIN_PHONE_DIGITS,
  );
}

/** True when `COPY_WORDS` consecutive words of `sentence` also appear consecutively in `visitor`. */
function copies(sentence: string[], visitor: string[]): boolean {
  if (sentence.length < COPY_WORDS) return false;
  const runs = new Set<string>();
  for (let i = 0; i + COPY_WORDS <= visitor.length; i++) runs.add(visitor.slice(i, i + COPY_WORDS).join(" "));
  for (let i = 0; i + COPY_WORDS <= sentence.length; i++) {
    if (runs.has(sentence.slice(i, i + COPY_WORDS).join(" "))) return true;
  }
  return false;
}

/**
 * Checks one sentence before it is shown or spoken. Patterns run on both the raw sentence and the
 * markdown-stripped one: stripping can hide a code fence ("```"), and it can also reveal what the
 * markdown broke up ("evil**.**com" is shown as "evil.com"). Word counts run on the text the visitor
 * sees. Blocked sentences are dropped whole: a contact detail, code, profanity or the visitor's own
 * words played back (a prompt-injection tell) must never reach the visitor. Markdown, hype and
 * pronouns only flag, since dropping a good sentence for its style would cost more than it saves;
 * markdown is stripped and he or she becomes Yash, so the visitor never sees either.
 */
export function gateSentence(text: string, visitorMessage: string): GateResult {
  const clean = stripMarkdown(text);
  const shown = namePronouns(clean);
  const shownWords = words(shown);
  const visitorWords = words(visitorMessage);
  const either = (test: RegExp | ((t: string) => boolean)) => {
    const run = typeof test === "function" ? test : (t: string) => test.test(t);
    return run(text) || run(clean);
  };
  const hits: Record<GateReason, boolean> = {
    url: either((t) => URL.test(t.replace(PRODUCT_NAMES, ""))),
    email: either(EMAIL),
    phone: hasPhone(text) || hasPhone(clean),
    code: CODE.some(either),
    profanity: either(PROFANITY),
    // Naming Yash could turn a copy of "he is the best..." into a near miss, so both are checked.
    copied: copies(words(clean), visitorWords) || copies(shownWords, visitorWords),
    too_long: shownWords.length > MAX_WORDS,
  };
  const noted: Record<GateFlag, boolean> = {
    markdown: clean !== text.trim(),
    hype: HYPE.test(text),
    pronoun: shown !== clean,
  };
  return {
    text: shown,
    blocked: GATE_REASONS.filter((r) => hits[r]),
    flags: GATE_FLAGS.filter((f) => noted[f]),
  };
}

/** Adds up one answer's gate results for its TurnRecord. */
export class GateTally {
  private dropped = 0;
  private readonly reasons = new Set<GateReason>();
  private readonly flags = new Set<GateFlag>();

  add(r: GateResult): void {
    if (r.blocked.length > 0) {
      this.dropped++;
      for (const reason of r.blocked) this.reasons.add(reason);
    } else {
      // Flags describe what the visitor got; a dropped sentence's style never reached them.
      for (const flag of r.flags) this.flags.add(flag);
    }
  }

  summary(): GateSummary {
    return {
      dropped: this.dropped,
      reasons: GATE_REASONS.filter((r) => this.reasons.has(r)),
      flags: GATE_FLAGS.filter((f) => this.flags.has(f)),
    };
  }
}
