import type { DataLine } from "../src/protocol/data-line";
import type { GateSummary, GroundingResult } from "../src/protocol/turn-record";
import type { Check } from "./case-schema";

/** What the checks see of one answer: what `respond()` reported for the case's last turn. */
export interface Answer {
  /** What the visitor saw: the sentences that passed the gate, joined by single spaces. */
  prose: string;
  /** Each `sentence` event's text, in order (passed sentences only, markdown stripped). */
  sentences: string[];
  /** The parsed data line, or null when it was missing or invalid. */
  data: DataLine | null;
  metaError: string | null;
  /** Refs (or `show`) the parser dropped as unknown. */
  dropped: string[];
  gate: GateSummary;
  grounding: GroundingResult;
}

/**
 * Phrasing that says or implies Yash lacks something; the redirect rule never needs it. The first
 * pattern also takes the participles, so "hasn't used" counts as well as "doesn't use".
 */
const ADMISSIONS = [
  /\b(?:doesn't|does not|didn't|did not|hasn't|has not) (?:have|had|know|known|use|used)\b/i,
  /\bno (?:experience|background|exposure)\b/i,
  /\black(?:s|ing)?\b/i,
  /\bnot familiar\b/i,
  /\bunfortunately\b/i,
];
/** Yash's pronouns are not stated, so answers use the name. */
const PRONOUNS = /\b(?:he|him|his|himself|she|her|hers|herself)\b/i;
/**
 * Saying the asked-about thing is missing. RULES forbid it on a first ask, which gets only the
 * closest real evidence; the pressed answer's "isn't in what I know" is not one of these.
 */
const DISCLAIMERS = [
  /\b(?:not|isn't|is not|aren't) (?:listed|documented|mentioned|confirmed|shown|recorded)\b/i,
  /\b(?:doesn't|does not|didn't|did not) (?:mention|list|confirm|show|document)\b/i,
  /\bno (?:evidence|record|mention)\b/i,
  /\b(?:won't|will not) (?:claim|assume)\b/i,
];
/** The output gate's hype words. The gate only flags them; evals fail on them. */
const HYPE =
  /\b(?:passionate|rock ?star|world-class|cutting-edge|seamless(?:ly)?|game-changing|ninja|guru|synergy|visionary)\b/gi;
/** Voice may cut the first sentence early at one of these; the event that ends in one is not a sentence. */
const CLAUSE_END = /[,;:—]$/;

/** Curly quotes made straight, so "Yash’s" matches "Yash's". */
function straight(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

function fold(text: string): string {
  return straight(text).toLowerCase();
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

function sentenceCount(a: Answer): number {
  return a.sentences.filter((s) => !CLAUSE_END.test(s)).length;
}

function found(pattern: RegExp, text: string): string | null {
  return pattern.exec(text)?.[0] ?? null;
}

/** A hype word as compared with the question: "Rock star" and "rockstar" are the same word. */
function hypeKey(word: string): string {
  return word.toLowerCase().replace(/\s+/g, "");
}

const q = (s: string) => JSON.stringify(s);
const clip = (s: string) => (s.length > 60 ? `${s.slice(0, 60)}…` : s);
const NO_DATA = "no data line";

/**
 * Runs one check on an answer: null when it passes, else what failed. `question` is the visitor
 * message the answer replies to, for the checks that must tell its words from the answer's own.
 */
export function runCheck(check: Check, a: Answer, question = ""): string | null {
  const prose = straight(a.prose);
  switch (check.kind) {
    case "grounded":
      return a.grounding.unsupported.length === 0 ? null : `unsupported: ${a.grounding.unsupported.map(q).join(", ")}`;
    case "noAdmission": {
      const hit = ADMISSIONS.map((p) => found(p, prose)).find((m) => m !== null);
      return hit ? `admits a gap: ${q(hit)}` : null;
    }
    case "noPronouns": {
      const hit = found(PRONOUNS, prose);
      return hit ? q(hit) : null;
    }
    case "noDisclaimer": {
      const hit = DISCLAIMERS.map((p) => found(p, prose)).find((m) => m !== null);
      return hit ? `says it is missing: ${q(hit)}` : null;
    }
    case "noHype": {
      // Quoting the visitor's own word to decline it ("I wouldn't use 'rockstar'") is not hype.
      const asked = new Set([...question.matchAll(HYPE)].map(([word]) => hypeKey(word)));
      const hit = [...prose.matchAll(HYPE)].find(([word]) => !asked.has(hypeKey(word)));
      return hit ? q(hit[0]) : null;
    }
    case "noGateDrops":
      return a.gate.dropped === 0 ? null : `${a.gate.dropped} sentence(s) dropped: ${a.gate.reasons.join(", ")}`;
    case "metaValid":
      if (a.data === null) return `${NO_DATA}: ${a.metaError ?? "missing"}`;
      return a.dropped.length === 0 ? null : `unknown refs dropped: ${a.dropped.join(", ")}`;
    case "startsWith":
      return fold(prose).startsWith(fold(check.text)) ? null : `starts ${q(clip(prose))}, not ${q(check.text)}`;
    case "contains":
      return fold(prose).includes(fold(check.text)) ? null : `missing ${q(check.text)}`;
    case "notContains":
      return fold(prose).includes(fold(check.text)) ? `contains ${q(check.text)}` : null;
    case "matches":
      return new RegExp(check.pattern, "i").test(prose) ? null : `no match for /${check.pattern}/`;
    case "notMatches": {
      const hit = found(new RegExp(check.pattern, "i"), prose);
      return hit === null ? null : `${q(hit)} matches /${check.pattern}/`;
    }
    case "contact":
      if (a.data === null) return NO_DATA;
      return a.data.contact === check.value ? null : `contact is ${a.data.contact}, expected ${check.value}`;
    case "coverage":
      if (a.data === null) return NO_DATA;
      return check.oneOf.includes(a.data.coverage)
        ? null
        : `coverage ${q(a.data.coverage)}, expected ${check.oneOf.map(q).join(" or ")}`;
    case "refsInclude":
      if (a.data === null) return NO_DATA;
      return a.data.refs.some((r) => check.anyOf.includes(r))
        ? null
        : `refs [${a.data.refs.join(", ")}] include none of ${check.anyOf.join(", ")}`;
    case "maxWords": {
      const n = wordCount(a.prose);
      return n <= check.n ? null : `${n} words, max ${check.n}`;
    }
    case "maxSentences": {
      const n = sentenceCount(a);
      return n <= check.n ? null : `${n} sentences, max ${check.n}`;
    }
  }
}

/** Every failed check, as `<kind>: <what failed>`; empty when the answer passes them all. */
export function failures(checks: readonly Check[], a: Answer, question = ""): string[] {
  return checks.flatMap((check) => {
    const failure = runCheck(check, a, question);
    return failure === null ? [] : [`${check.kind}: ${failure}`];
  });
}
