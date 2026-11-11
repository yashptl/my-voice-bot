const TERMINATORS = ".!?…";
const CLOSERS = "\"')]”’»";
const CLAUSE_BREAKS = ",;:—";
const OPENERS = /^["'([“‘«]+/;
const WHITESPACE = /\s/;
const LOWERCASE = /\p{Ll}/u;
const DIGIT = /\d/;
const LETTER = /\p{L}/u;
const WORDLIKE = /[\p{L}\p{N}]/u;

/** Words that end in a period mid-sentence (lowercase, without the period). */
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "approx", "dept", "est", "fig", "vol",
  "inc", "ltd", "co", "corp",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

/** Dotted initialisms and degrees: "U.S.", "e.g.", "i.e.", "a.m.", "Ph.D.", "B.Sc.", "M.Tech." */
const INITIALISM = /^\p{L}{1,2}\.(?:\p{L}{1,4}\.)+$/u;
/** A single capital initial, as in a name: "K." */
const INITIAL = /^\p{Lu}\.$/u;

/** True when the period at `dot` closes an abbreviation rather than a sentence. */
function isAbbreviation(text: string, dot: number): boolean {
  let start = dot;
  while (start > 0 && !WHITESPACE.test(text.charAt(start - 1))) start--;
  const token = text.slice(start, dot + 1).replace(OPENERS, "");
  return INITIALISM.test(token) || INITIAL.test(token) || ABBREVIATIONS.has(token.slice(0, -1).toLowerCase());
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => WORDLIKE.test(w)).length;
}

/** Fewer words than this after a clause break end the sentence too soon to be worth a cut ("Ahmedabad, India."). */
const MIN_TAIL_WORDS = 3;

/**
 * Whether the words after a clause break run on long enough to be spoken on their own: true or
 * false once the text settles it, null while it cannot yet. A terminator or newline within the next
 * MIN_TAIL_WORDS words ends the sentence (or might: "Node.js"), so the tail is short; MIN_TAIL_WORDS
 * complete words with none of them settle it long.
 */
function longTail(tail: string): boolean | null {
  const end = tail.search(/[.!?…\n]/);
  if (end >= 0) return wordCount(tail.slice(0, end)) >= MIN_TAIL_WORDS;
  const words = wordCount(tail);
  const complete = WHITESPACE.test(tail.charAt(tail.length - 1)) ? words : words - 1;
  return complete >= MIN_TAIL_WORDS ? true : null;
}

/**
 * Turns streamed prose into sentences for captions and speech.
 *
 * A sentence ends at a newline, or at `.`, `!`, `?` or `…` (plus any closing quotes or brackets)
 * followed by whitespace and then a character that is not a lowercase letter. A period between two numbers ("416. 555.") does not end one. A lone period after an
 * abbreviation ("e.g.", "U.S.", "Dr.") never ends one, and a period inside a token ("1.5",
 * "Node.js") is never followed by whitespace. A piece with no letters ("416.", "555.", "1234") is
 * never a sentence of its own: it is joined to the sentence after it (or flushed at the end), so a
 * number split at its periods reaches the output gate whole. Nothing is decided until the character that settles it
 * has arrived, so the output is the same however the text is chunked.
 *
 * To start speaking sooner, the first sentence of a reply may be cut early at a comma, semicolon,
 * colon or dash followed by whitespace, once at least `firstClauseMinWords` words come before it
 * and at least MIN_TAIL_WORDS words follow it in the same sentence, so a short tail such as the
 * "India." of "Ahmedabad, India." is never spoken as a sentence of its own.
 */
export class SentenceSplitter {
  private readonly firstClauseMinWords: number;
  private buffer = "";
  private first = true;
  /** Letterless pieces waiting for the sentence they belong to. */
  private pending = "";

  constructor(o: { firstClauseMinWords?: number } = {}) {
    this.firstClauseMinWords = o.firstClauseMinWords ?? 6;
  }

  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    for (let cut = this.findCut(); cut; cut = this.findCut()) {
      const sentence = this.buffer.slice(0, cut.end).trim();
      this.buffer = this.buffer.slice(cut.next);
      if (!sentence) continue;
      if (!LETTER.test(sentence)) {
        this.pending += `${sentence} `;
        continue;
      }
      out.push(this.pending + sentence);
      this.pending = "";
      this.first = false;
    }
    return out;
  }

  /** Ends the reply: returns whatever is left as the last sentence and resets the splitter. */
  flush(): string[] {
    const rest = (this.pending + this.buffer.trim()).trim();
    this.buffer = "";
    this.pending = "";
    this.first = true;
    return rest ? [rest] : [];
  }

  /** The first place the buffer can be cut, or null when there is none yet. */
  private findCut(): { end: number; next: number } | null {
    const s = this.buffer;
    for (let i = 0; i < s.length; i++) {
      const c = s.charAt(i);
      if (c === "\n") return { end: i, next: i + 1 };

      if (TERMINATORS.includes(c)) {
        let j = i + 1;
        while (j < s.length && TERMINATORS.includes(s.charAt(j))) j++;
        const run = s.slice(i, j);
        while (j < s.length && CLOSERS.includes(s.charAt(j))) j++;
        if (j === s.length) return null; // undecided until the next character arrives
        if (!WHITESPACE.test(s.charAt(j))) {
          i = j - 1; // "1.5", "Node.js", "?!)" mid-token
          continue;
        }
        let k = j;
        while (k < s.length && (s.charAt(k) === " " || s.charAt(k) === "\t")) k++;
        if (k === s.length) return null; // undecided until the next word starts
        // A lowercase next word means the thought goes on: "approx. two", 'asked "why?" and'.
        // A number's period before another number ("416. 555. 1234") is a separator, not a sentence end.
        const numberRun = run === "." && DIGIT.test(s.charAt(i - 1)) && DIGIT.test(s.charAt(k));
        if ((run === "." && isAbbreviation(s, i)) || numberRun || LOWERCASE.test(s.charAt(k))) {
          i = j - 1;
          continue;
        }
        return { end: j, next: j };
      }

      if (this.first && CLAUSE_BREAKS.includes(c)) {
        if (i + 1 === s.length) return null;
        if (WHITESPACE.test(s.charAt(i + 1)) && wordCount(s.slice(0, i + 1)) >= this.firstClauseMinWords) {
          const long = longTail(s.slice(i + 1));
          if (long === null) return null; // undecided until enough of the tail arrives
          if (long) return { end: i + 1, next: i + 1 };
        }
      }
    }
    return null;
  }
}
