import type { Bundle } from "../knowledge/types";
import type { GroundingResult } from "../protocol/turn-record";
import { SentenceSplitter } from "./sentences";

const NUMBER = /\d[\d,]*(?:\.\d+)?%?/g;
const YEAR = /^(?:19|20)\d\d$/;
const CAPITALIZED_RUN = /\b[A-Z][\w&+.-]*(?:\s+[A-Z][\w&+.-]*)*/g;
/** A skill's line under doc:skills ("- skill:react — React (Frontend): ..."); skills have no `## ` section. */
const SKILL_LINE = /^- (skill:\S+) — .*$/gm;
/**
 * Words that say how a name was used rather than name anything ("RAG-based AI", "AI-powered").
 * A capitalized run is checked word by word without them.
 */
const CONNECTORS = new Set([
  "based", "backed", "powered", "driven", "first", "ready", "style", "native", "heavy", "focused",
]);
/** Titles that name a document, not a fact. Stop names below are never known names either (YashOS). */
const NOT_NAMES = new Set(["Profile", "Resume", "Skills"]);
const MIN_NAME_CHARS = 3;
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
/** Capitalized words that are never a claim about Yash's record (Patel is Yash's surname). */
const STOP_NAMES = new Set([
  "I", "I'm", "I'll", "I've", "Yash", "Yash's", "Patel", "YashOS", "Messages", "AI", "OK", "English",
  ...MONTHS,
  ...MONTHS.map((m) => m.slice(0, 3)),
  ...WEEKDAYS,
]);

/** A letter or digit: what may not touch a whole word. Compiled once, for every check. */
const WORD_CHAR = /[\p{L}\p{N}]/u;
const DIGIT = /\d/;

/**
 * Where `needle` first occurs in `hay` with no `inner` character right before or after it, or -1.
 * A plain string search: compiling a Unicode regex per name and number cost 60-70 ms on a cold
 * isolate (about 0.25 ms warm), which alone exceeds the 10 ms CPU of Cloudflare's free plan.
 */
function indexOfBounded(hay: string, needle: string, inner: RegExp): number {
  if (needle === "") return -1;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const before = i > 0 ? hay.charAt(i - 1) : "";
    const after = hay.charAt(i + needle.length);
    if (!(before && inner.test(before)) && !(after && inner.test(after))) return i;
  }
  return -1;
}

/** True when `word` is a whole word of `lowerHay` (already lowercased), ignoring case. */
function hasWord(lowerHay: string, word: string): boolean {
  return indexOfBounded(lowerHay, word.toLowerCase(), WORD_CHAR) >= 0;
}

/** An all-caps name such as REST or AWS: in lower case it is an ordinary word ("the rest"), not the name. */
function isAcronym(name: string): boolean {
  return !/\p{Ll}/u.test(name);
}

/** Section text by ref; the knowledge only changes on deploy, so one bundle's split is kept. */
let cached: { hash: string; sections: Map<string, string>; lowerText: string } | null = null;

function sectionsOf(bundle: Bundle): Map<string, string> {
  return indexOf(bundle).sections;
}

/** The bundle's lowercased text, kept with its sections. */
function lowerTextOf(bundle: Bundle): string {
  return indexOf(bundle).lowerText;
}

function indexOf(bundle: Bundle): { sections: Map<string, string>; lowerText: string } {
  if (cached?.hash === bundle.hash) return cached;
  const sections = new Map<string, string>();
  const add = (ref: string, text: string) => sections.set(ref, `${sections.get(ref) ?? ""}${text.toLowerCase()}\n`);
  for (const part of bundle.text.split(/^(?=## )/m)) {
    const ref = /^## (\S+)/.exec(part)?.[1];
    if (ref) add(ref, part);
  }
  // A skill ref cites its own line, which is all the knowledge says about that skill by that ref.
  for (const [line, ref] of bundle.text.matchAll(SKILL_LINE)) if (ref) add(ref, line);
  cached = { hash: bundle.hash, sections, lowerText: bundle.text.toLowerCase() };
  return cached;
}

/** Names the knowledge defines (company, role, school, project and skill titles). */
function knownNames(bundle: Bundle): Set<string> {
  const names = new Set<string>();
  for (const title of Object.values(bundle.titles)) {
    for (const part of title.split(" · ")) {
      const name = part.trim();
      if (name.length >= MIN_NAME_CHARS && !NOT_NAMES.has(name) && !STOP_NAMES.has(name)) names.add(name);
    }
  }
  return names;
}

function sentencesOf(prose: string): string[] {
  // No early first-clause cut: a name after the first comma is mid-sentence.
  const splitter = new SentenceSplitter({ firstClauseMinWords: Infinity });
  return [...splitter.push(prose), ...splitter.flush()];
}

/** How well a claim is supported, from best to worst. */
type Support = "supported" | "uncited" | "unsupported";

/**
 * The deterministic grounding check: claims in an answer that the sections it cites do not support.
 * It looks at three kinds of claim: numbers, names the knowledge defines, and other capitalized
 * names. A name the knowledge holds outside the cited sections is `uncited` (true, but cited badly,
 * as when an answer about Magenta Connect mentions Amazon). A name found nowhere in the knowledge
 * is `unsupported` (invented) unless the visitor's message holds it, since naming what the visitor
 * asked about is no invention. Numbers stay strict: one the cited sections and the visitor's message
 * lack is unsupported, as a number from another section is easily the wrong one; only a year found
 * elsewhere in the knowledge is merely uncited. A sentence's first
 * word is skipped, since any word is capitalized there. It is a cheap, explainable signal for the
 * inspector and the evals, not a verdict: a supported claim can still be wrong in context, and the
 * judge looks at that.
 */
export function checkGrounding(
  prose: string,
  refs: readonly string[],
  bundle: Bundle,
  visitorMessage = "",
): GroundingResult {
  const sections = sectionsOf(bundle);
  const cited = refs.map((ref) => sections.get(ref) ?? "").join("\n");
  const citedNumbers = cited.replace(/,/g, "");
  const visitorNumbers = visitorMessage.replace(/,/g, "");
  const lowerProse = prose.toLowerCase();
  const lowerVisitor = visitorMessage.toLowerCase();
  const lowerBundle = lowerTextOf(bundle);
  /** Each claim once, keyed case-insensitively, with how well it is supported. */
  const claims = new Map<string, { text: string; support: Support }>();
  const claim = (text: string, support: () => Support) => {
    const key = text.toLowerCase();
    if (!claims.has(key)) claims.set(key, { text, support: support() });
  };

  for (const [raw] of prose.matchAll(NUMBER)) {
    const text = raw.replace(/,+$/, "");
    const n = text.replace(/,/g, "");
    if (/^\d$/.test(n)) continue;
    const has = (hay: string) => indexOfBounded(hay, n, DIGIT) >= 0;
    claim(text, () => {
      if (has(citedNumbers) || has(visitorNumbers)) return "supported";
      // A year is hard to misattribute ("shipping since 2021"), so one from another section is only
      // uncited; percentages and counts stay strict.
      return YEAR.test(n) && has(bundle.text) ? "uncited" : "unsupported";
    });
  }

  // A known name is in the knowledge by definition, so at worst it is uncited. Its words are kept so
  // that a run inside it ("MS" in "MS in Computer Science") is not judged a second time.
  const named = new Set<string>();
  for (const name of knownNames(bundle)) {
    // An acronym must match its case ("REST", not "the rest"); other names ignore case.
    const at = isAcronym(name)
      ? indexOfBounded(prose, name, WORD_CHAR)
      : indexOfBounded(lowerProse, name.toLowerCase(), WORD_CHAR);
    if (at < 0) continue;
    // As written in the answer (lowercasing can change the length of a few rare letters).
    const written = (lowerProse.length === prose.length ? prose : lowerProse).slice(at, at + name.length);
    claim(written, () => (hasWord(cited, name) ? "supported" : "uncited"));
    for (const word of name.split(/\s+/)) named.add(word.toLowerCase());
  }

  /** Where a word of a capitalized run is found: cited sections, the rest of the knowledge, the visitor, nowhere. */
  const sourceOf = (word: string): "cited" | "uncited" | "visitor" | "unsupported" => {
    if (hasWord(cited, word)) return "cited";
    if (hasWord(lowerBundle, word)) return "uncited";
    return hasWord(lowerVisitor, word) ? "visitor" : "unsupported";
  };
  for (const sentence of sentencesOf(prose)) {
    for (const m of sentence.matchAll(CAPITALIZED_RUN)) {
      const name = m[0].replace(/[.-]+$/, "");
      const atStart = !/[\p{L}\p{N}]/u.test(sentence.slice(0, m.index));
      if (atStart || claims.has(name.toLowerCase())) continue;
      // Word by word, so "Python FastAPI" and "Full-Stack Developer" read as the names they join.
      const words = name
        .split(/[\s-]+/)
        .filter((w) => /^\p{Lu}/u.test(w) && !CONNECTORS.has(w.toLowerCase()) && !STOP_NAMES.has(w))
        .filter((w) => !named.has(w.toLowerCase()));
      const sources = words.map(sourceOf);
      if (sources.every((s) => s === "cited")) continue;
      claim(name, () => (["unsupported", "uncited"] as const).find((s) => sources.includes(s)) ?? "supported");
    }
  }

  const all = [...claims.values()];
  const listed = (support: Support) => all.filter((c) => c.support === support).map((c) => c.text);
  return { checked: all.length, unsupported: listed("unsupported"), uncited: listed("uncited") };
}
