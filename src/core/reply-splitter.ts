import { DataLineSchema } from "../protocol/data-line";

const OPEN = "<meta>";
const OPEN_RE = /<meta>/i;
const CLOSE_RE = /<\/meta>/i;
/** A bare list of refs that some replies end with instead of the data line. */
const REFS_OPEN = "<refs>";
const REFS_RE = /<refs>/i;
/** A held `<refs>` list that ends the reply, with or without its closing tag: group 1 is the list. */
const REFS_TAIL = /^<refs>\s*((?:[a-z]+:[a-z0-9-]+[\s,;]*)*)(?:<\/refs>)?\s*$/i;
/** The ref-shaped start of a held `<refs>` list, closed or not, with whatever follows left out. */
const REFS_LEAD = /^<refs>\s*((?:[a-z]+:[a-z0-9-]+[\s,;]*)*)(?:<\/refs>)?/i;
/** A `<refs>` list (closed or not) at the very end of the prose before a `<meta>` line. */
const REFS_BEFORE_META = /<refs>\s*(?:[a-z]+:[a-z0-9-]+[\s,;]*)*(?:<\/refs>)?\s*$/i;
/**
 * A held `<refs>` list that is closed and then followed by visible text that cannot start a data
 * line or a tag (`{`, a backtick or `<`): words, so the list was prose after all. The match ends
 * where those words start.
 */
const REFS_THEN_WORDS = /^<refs>[^<]*<\/refs>\s*(?=[^\s{`<])/i;
const REFS_START = /^<refs>/i;
/** The tags a held-back suffix may be the start of; both are 6 characters. */
const OPENERS = [OPEN, REFS_OPEN];

/** A line whose first visible character is one of these may be a data line written without tags. */
const CANDIDATE_START = /^[ \t]*[{`]/;
/** A line holding nothing visible yet: it may still turn into a candidate. */
const BLANK_START = /^[ \t]*$/;
/** A code fence opener left in front of a tagged data line (```json). */
const FENCE_OPENER = /```[a-z]*\s*$/i;
/** A key of the data line, quoted as JSON writes it: what makes a `{` line a data line. */
const DATA_LINE_KEY = new RegExp(`"(?:${Object.keys(DataLineSchema.shape).join("|")})"\\s*:`);

/** Length of the longest suffix of `text` that could still grow into `<meta>` or `<refs>`. */
function partialOpenLength(text: string): number {
  for (let n = Math.min(OPEN.length - 1, text.length); n > 0; n--) {
    const tail = text.slice(-n).toLowerCase();
    if (OPENERS.some((tag) => tag.startsWith(tail))) return n;
  }
  return 0;
}

/**
 * Where to start holding `text` back: the first line that starts like a data line (a candidate,
 * held to the end of the reply), or a last line with nothing visible yet (held until it shows).
 * `lineStart` says whether `text` itself begins a line.
 */
function holdPoint(text: string, lineStart: boolean): { at: number; candidate: boolean } | null {
  const starts = lineStart ? [0] : [];
  for (let nl = text.indexOf("\n"); nl !== -1; nl = text.indexOf("\n", nl + 1)) starts.push(nl + 1);
  for (const at of starts) {
    const end = text.indexOf("\n", at);
    const line = text.slice(at, end === -1 ? undefined : end);
    if (CANDIDATE_START.test(line)) return { at, candidate: true };
    if (end === -1 && BLANK_START.test(line)) return { at, candidate: false };
  }
  return null;
}

/** The JSON of a held last line when it is a data line written without tags, else null. */
function bareDataLine(held: string): string | null {
  const body = held
    .trim()
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/\s*```$/, "")
    .replace(/\s*<\/meta>$/i, "")
    .trim();
  return body.startsWith("{") && DATA_LINE_KEY.test(body) ? body : null;
}

/**
 * Separates a streamed reply into prose and the trailing `<meta>…</meta>` data line.
 *
 * `push` returns the prose that is safe to show or speak now. It holds back a trailing piece that
 * could be the start of `<meta>` (at most 5 characters), so prose such as "latency < 1 s" flows
 * straight through, and a tag split across chunks never leaks. Everything after `<meta>` is meta.
 * Tags match case-insensitively.
 *
 * Models sometimes drop the tags and end with the bare JSON, or a fenced JSON block. So a line that
 * starts with `{` or a backtick is held until the reply ends: if it is JSON with a data-line key
 * it is the data line, otherwise it is released as prose (late, but never lost). A `<meta>` tag
 * arriving after it releases it as prose straight away.
 *
 * Rarely, a model ends with a bare `<refs>role:a, role:b</refs>` list instead of the data line. It
 * is held the same way, from the `<refs>` tag on (also mid-line, and a partial `<refs` tag is held
 * back like a partial `<meta`): if nothing but whitespace follows it, `end` returns the list as
 * `refs`, never as prose, so the visitor neither sees nor hears it. If a tagless data line follows
 * it, that is the data line and the list stays hidden. If words follow its closing tag, it was
 * prose after all and is released as soon as they show.
 */
export class ReplySplitter {
  private held = "";
  /** True when `held` is a candidate, held to the end: a line that started with `{` or a backtick, or a `<refs>` list. */
  private candidate = false;
  /** True when the next pushed text starts a new line. */
  private atLineStart = true;
  private meta: string | null = null;

  /** True once `<meta>` has arrived: no more prose will come, so the last sentence can be flushed. */
  get metaStarted(): boolean {
    return this.meta !== null;
  }

  push(delta: string): string {
    if (this.meta !== null) {
      this.meta += delta;
      return "";
    }
    const text = this.held + delta;
    const lineStart = this.atLineStart;
    this.held = "";

    const open = text.search(OPEN_RE);
    if (open >= 0) {
      // A held line was prose after all; a code fence opened for the data line is not.
      this.meta = text.slice(open + OPEN.length);
      this.candidate = false;
      // A `<refs>` list held just before the data line is never prose: the data line carries the refs.
      return text.slice(0, open).replace(FENCE_OPENER, "").replace(REFS_BEFORE_META, "");
    }
    if (this.candidate) {
      const listEnd = REFS_THEN_WORDS.exec(text)?.[0].length;
      if (listEnd === undefined) {
        this.held = text;
        return "";
      }
      // Words follow the list, so it was prose after all: release it now, not when the reply ends.
      this.candidate = false;
      this.atLineStart = false;
      return text.slice(0, listEnd) + this.push(text.slice(listEnd));
    }

    // A `<refs>` list is held from its tag on, unless a candidate line before it already holds it.
    const refs = text.search(REFS_RE);
    const hold = holdPoint(refs >= 0 ? text.slice(0, refs) : text, lineStart);
    if (refs >= 0 && !hold?.candidate) {
      // Held as a candidate, which also releases it at once when words already follow it.
      this.candidate = true;
      return text.slice(0, refs) + this.push(text.slice(refs));
    }
    if (hold) {
      this.candidate = hold.candidate;
      this.held = text.slice(hold.at);
      this.atLineStart = true;
      return text.slice(0, hold.at);
    }
    const cut = text.length - partialOpenLength(text);
    this.held = text.slice(cut);
    this.atLineStart = cut === 0 ? lineStart : text[cut - 1] === "\n";
    return text.slice(0, cut);
  }

  /**
   * Ends the reply. `meta` is the trimmed text between `<meta>` and `</meta>` (or the end when the
   * closing tag is missing), or a held tagless data line, or null when no data line arrived. `refs`
   * is set only when, instead, the reply ended with a bare `<refs>` list: the trimmed list. `prose`
   * is any held-back text that turned out to be neither; append it to what `push` returned.
   */
  end(): { meta: string | null; prose: string; refs?: string } {
    const held = this.held;
    const candidate = this.candidate;
    this.held = "";
    this.candidate = false;
    if (this.meta !== null) {
      const close = this.meta.search(CLOSE_RE);
      return { meta: (close >= 0 ? this.meta.slice(0, close) : this.meta).trim(), prose: held };
    }
    if (!candidate) return { meta: null, prose: held };
    const bare = bareDataLine(held);
    if (bare !== null) return { meta: bare, prose: "" };
    // A `<refs>` list, then a tagless data line on a later line: the data line wins. The list stays
    // hidden, as it would on its own; anything else in front of the data line is prose.
    const after = REFS_START.test(held) ? holdPoint(held, false) : null;
    const data = after?.candidate ? bareDataLine(held.slice(after.at)) : null;
    if (after && data !== null) {
      const before = held.slice(0, after.at);
      return { meta: data, prose: REFS_TAIL.test(before) ? "" : before };
    }
    const refs = REFS_TAIL.exec(held)?.[1];
    if (refs !== undefined) return { meta: null, prose: "", refs: refs.trim() };
    // An unclosed list followed by sentences: the list stays hidden, the sentences are prose.
    const lead = REFS_START.test(held) ? REFS_LEAD.exec(held) : null;
    const list = lead?.[1]?.trim();
    if (lead && list) return { meta: null, prose: held.slice(lead[0].length), refs: list };
    return { meta: null, prose: held };
  }
}
