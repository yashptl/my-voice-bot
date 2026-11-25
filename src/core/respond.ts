import type { Bundle } from "../knowledge/types";
import { parseDataLine, parseRefsList, type DataLine, type DataLineStatus } from "../protocol/data-line";
import type { GateReason, GateSummary, GroundingResult } from "../protocol/turn-record";
import type { LlmPort, LlmRequest, LlmUsage, NeutralTurn } from "../ports/llm";
import { checkGrounding } from "./grounding";
import { EMPTY_FALLBACK, GATE_FALLBACK, GateTally, gateSentence } from "./output-gate";
import { buildReminder, buildStable, buildTail, wrapVisitorMessage, type ReplyMode } from "./prompt";
import { ReplySplitter } from "./reply-splitter";
import { PRESSED_ANSWER } from "./rules";
import { sanitizeInput } from "./sanitize";
import { SentenceSplitter } from "./sentences";

/** Output budget for every profile; thinking tokens count toward it. */
export const REPLY_MAX_TOKENS = 8192;

export type RespondEvent =
  | { type: "reasoning" }
  /** Passed the gate; ids count only passed sentences. */
  | { type: "sentence"; id: number; text: string }
  /** A sentence the gate dropped; it is never shown or spoken. */
  | { type: "gated"; reasons: GateReason[] }
  /**
   * The reply's data line: `data` when it parsed (`dataLine` "ok"), otherwise null with an `error`
   * ("missing" when the reply had none, "invalid" when it would not parse). `refs` is set only when
   * the reply ended with a bare `<refs>` list instead ("invalid"): its known refs, for sources only.
   * It is left out when a visitor turn holds a `<refs>` tag, since the list may then be an echo.
   */
  | {
      type: "meta";
      data: DataLine | null;
      dropped: string[];
      error: string | null;
      dataLine: DataLineStatus;
      refs?: string[];
    }
  | { type: "usage"; usage: LlmUsage }
  /** `prose` is what the visitor saw: the passed sentences joined by single spaces. */
  | { type: "done"; prose: string; gate: GateSummary; grounding: GroundingResult };

export interface RespondOptions {
  llm: LlmPort;
  bundle: Bundle;
  /** Earlier turns, oldest first, without the new message. Not modified; its visitor turns are untrusted too. */
  history: NeutralTurn[];
  /** The visitor's new message, untrusted. It is sanitized and wrapped here, as are history's visitor turns. */
  message: string;
  mode: ReplyMode;
  signal?: AbortSignal;
  /** Boundary id for the visitor message; a random UUID per request by default. */
  boundary?: string;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

type MetaEvent = Extract<RespondEvent, { type: "meta" }>;

/** A `<refs>` tag in visitor text, spaced or not: a visitor who writes one can get the model to echo it. */
const VISITOR_REFS = /<\s*refs/i;

/**
 * The meta event for the end of a reply. A bare `<refs>` list's refs are kept only when
 * `trustRefs`: when the visitor wrote such a tag, the list may be their words echoed back.
 */
/** True when the shown prose contains the scripted pressed answer (straight or curly apostrophes). */
function isPressedAnswer(prose: string): boolean {
  const plain = (s: string) => s.replace(/[\u2018\u2019]/g, "'").toLowerCase();
  return plain(prose).includes(plain(PRESSED_ANSWER.slice(0, PRESSED_ANSWER.indexOf(".") + 1)));
}

function metaEvent(
  end: { meta: string | null; refs?: string },
  known: ReadonlySet<string>,
  trustRefs: boolean,
  prose: string,
): MetaEvent {
  if (end.meta === null && end.refs !== undefined) {
    const error = "a <refs> list instead of the data line";
    if (!trustRefs) return { type: "meta", data: null, dropped: [], error, dataLine: "invalid" };
    const { refs, dropped } = parseRefsList(end.refs, known);
    return { type: "meta", data: null, dropped, error, dataLine: "invalid", refs };
  }
  if (end.meta === null && isPressedAnswer(prose)) {
    // The rules fix this reply's data line (contact true, coverage none), so the Messages offer still
    // appears; it is still recorded as missing, because the model left it out.
    const data: DataLine = { refs: [], show: null, contact: true, coverage: "none" };
    return { type: "meta", data, dropped: [], error: "missing data line (filled from the pressed-answer rule)", dataLine: "missing" };
  }
  if (end.meta === null) return { type: "meta", data: null, dropped: [], error: "missing data line", dataLine: "missing" };
  const parsed = parseDataLine(end.meta, known);
  return parsed.ok
    ? { type: "meta", data: parsed.value, dropped: parsed.dropped, error: null, dataLine: "ok" }
    : { type: "meta", data: null, dropped: [], error: parsed.error, dataLine: "invalid" };
}

/**
 * Answers one visitor message. Yields at most one content-free `reasoning` event, then each
 * sentence as soon as it is complete and through the output gate (ids from 0, counting only
 * sentences that passed; a dropped one is a content-free `gated` event), then `meta`, `usage`
 * (when the LLM reported it) and `done` with the shown prose, the gate summary and the grounding
 * check. When the gate dropped every sentence, GATE_FALLBACK is shown as sentence 0 before `meta`;
 * when nothing was shown for any other reason (an empty reply, or only a data line), EMPTY_FALLBACK
 * is, so the visitor never gets silence. Both modes run through here, so voice and text gate alike.
 *
 * Every visitor turn, earlier ones included, is sanitized and then wrapped in this request's
 * boundary, so RULES can say that all visitor words sit inside `<visitor_message>`. Sanitizing
 * first matters: an invisible character inside a typed `</visitor_message>` would otherwise hide
 * it from the wrapper's rewrite. The boundary goes only into the turns and the tail, never into
 * `stable`, which stays byte-identical.
 *
 * Aborting `signal` ends the iteration with an AbortError and nothing else, even between sentences
 * of one chunk. Other LLM errors (such as `LlmError`) reach the caller unchanged, after a `usage`
 * event if the LLM reported usage before failing (the tokens were spent all the same).
 */
export async function* respond(o: RespondOptions): AsyncIterable<RespondEvent> {
  const { signal } = o;
  const check = () => {
    if (signal?.aborted) throw abortError();
  };
  check();

  const boundary = o.boundary ?? crypto.randomUUID();
  const visitor = (text: string): NeutralTurn => ({ role: "user", text: wrapVisitorMessage(sanitizeInput(text), boundary) });
  const message = sanitizeInput(o.message);
  const visitorTurns = [...o.history.filter((t) => t.role === "user").map((t) => sanitizeInput(t.text)), message];
  const req: LlmRequest = {
    stable: buildStable(o.bundle),
    turns: [
      ...o.history.map((t) => (t.role === "user" ? visitor(t.text) : t)),
      { role: "user", text: `${visitor(o.message).text}\n\n${buildReminder({ language: "en" })}` },
    ],
    tail: buildTail({ mode: o.mode, language: "en", boundary }),
    maxTokens: REPLY_MAX_TOKENS,
  };

  const reply = new ReplySplitter();
  const sentences = new SentenceSplitter();
  const tally = new GateTally();
  const shown: string[] = [];
  let usage: LlmUsage | null = null;
  let reasoned = false;

  /** The event for one sentence after the gate; null for a bare list marker that strips to nothing. */
  const gate = (sentence: string): RespondEvent | null => {
    const result = gateSentence(sentence, visitorTurns.join("\n"));
    tally.add(result);
    if (result.blocked.length > 0) return { type: "gated", reasons: result.blocked };
    if (!result.text) return null;
    shown.push(result.text);
    return { type: "sentence", id: shown.length - 1, text: result.text };
  };

  try {
    for await (const chunk of o.llm.stream(req, signal)) {
      check();
      if (chunk.t === "reasoning") {
        if (reasoned) continue;
        reasoned = true;
        yield { type: "reasoning" };
      } else if (chunk.t === "text") {
        const text = reply.push(chunk.text);
        // Once the data line starts the prose is over: speak the last sentence now, not after it.
        const ready = reply.metaStarted ? [...sentences.push(text), ...sentences.flush()] : sentences.push(text);
        for (const sentence of ready) {
          check();
          const event = gate(sentence);
          if (event) yield event;
        }
      } else {
        usage = chunk.usage;
      }
    }
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (usage) yield { type: "usage", usage };
    throw error;
  }

  const end = reply.end();
  for (const sentence of [...sentences.push(end.prose), ...sentences.flush()]) {
    check();
    const event = gate(sentence);
    if (event) yield event;
  }
  const gateSummary = tally.summary();
  if (shown.length === 0) {
    const fallback = gateSummary.dropped > 0 ? GATE_FALLBACK : EMPTY_FALLBACK;
    shown.push(fallback);
    check();
    yield { type: "sentence", id: 0, text: fallback };
  }
  const visitorWroteRefs = visitorTurns.some((text) => VISITOR_REFS.test(text));
  const meta = metaEvent(end, new Set(o.bundle.refs), !visitorWroteRefs, shown.join(" "));
  check();
  yield meta;
  if (usage) {
    check();
    yield { type: "usage", usage };
  }
  const prose = shown.join(" ");
  // The visitor's own words are no invention: an answer may name the employer it is correcting.
  // A bare <refs> list is no data line, but it still names what the answer cited.
  const grounding = checkGrounding(prose, meta.data?.refs ?? meta.refs ?? [], o.bundle, message);
  check();
  yield { type: "done", prose, gate: gateSummary, grounding };
}
