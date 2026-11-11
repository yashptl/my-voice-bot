import { estimateCostUsd, type LlmProfile } from "../adapters/llm-profiles";
import { GateTally } from "../core/output-gate";
import { respond, type RespondEvent } from "../core/respond";
import { sanitizeInput } from "../core/sanitize";
import type { Bundle } from "../knowledge/types";
import { LlmError, type LlmPort, type LlmUsage } from "../ports/llm";
import type { DataLine, DataLineStatus } from "../protocol/data-line";
import type { ServerEvent, Source } from "../protocol/events";
import type { Mark, TurnRecord } from "../protocol/turn-record";
import { PROTOCOL_VERSION } from "../protocol/version";
import type { ConversationState, Log } from "./conversation-state";
import { LLM_IDLE_MS, LLM_TOTAL_MS, withDeadlines } from "./deadlines";

export interface TextTurnOptions {
  conversationId: string;
  llm: LlmPort;
  /** The LLM profile's prices, for `costUsd`; null for the demo. */
  prices: LlmProfile["prices"] | null;
  bundle: Bundle;
  promptHash: string;
  /** The conversation's history; the exchange is added to it however the turn ends. */
  state: ConversationState;
  /** The visitor's message, untrusted; sanitized here before it is echoed or stored. */
  message: string;
  /** Aborted when the visitor stops the answer or goes away. */
  signal: AbortSignal;
  now(): number;
  /** Provider events only, never visitor text. */
  log: Log;
  /**
   * Called once with the turn's record however it ends, for the turn log: the record `turn.end`
   * carries, or, when the turn is stopped (and sends nothing more), one marked interrupted.
   */
  onRecord?(record: TurnRecord): void;
}

/** The cited refs in order, each with the title its chip shows (the ref itself when untitled). */
export function sourcesOf(refs: readonly string[], bundle: Bundle): Source[] {
  return refs.map((ref) => ({ ref, title: bundle.titles[ref] ?? ref }));
}

/**
 * One text answer as ServerEvents: `turn.start`, each `sentence` that passed the output gate, `meta`
 * (when the data line parsed; `sources` instead when the reply ended with a bare list of known refs),
 * then `turn.end` with the record; after an LLM failure, an `error` (`provider`) before `turn.end`. The exchange goes into history either way: the shown prose, or
 * after a failure the sentences shown before it.
 *
 * Stopping (the signal aborts, or the reader stops iterating) ends the turn at once: nothing more
 * is yielded, the LLM stream is aborted so it stops costing, and history keeps only the sentences
 * already yielded. `onRecord` still gets the turn's record, marked interrupted.
 */
export async function* textTurn(o: TextTurnOptions): AsyncIterable<ServerEvent> {
  const receivedAt = o.now();
  const marks: TurnRecord["marks"] = { received: 0 };
  const mark = (m: Mark) => {
    marks[m] ??= o.now() - receivedAt;
  };
  const turnId = crypto.randomUUID();
  // Stored in history and sent to the LLM again on later turns, so cleaned once here.
  const question = sanitizeInput(o.message).trim();
  // Aborted on every way out, so leaving early cannot leave a paid stream running.
  const stop = new AbortController();
  const signal = AbortSignal.any([o.signal, stop.signal]);
  const shown: string[] = [];
  const gate = new GateTally();
  let coverage: DataLine["coverage"] | null = null;
  let dataLine: DataLineStatus | null = null;
  let usage: LlmUsage | null = null;
  let done: Extract<RespondEvent, { type: "done" }> | null = null;
  let error: string | null = null;
  let stored = false;
  const store = (answer: string) => {
    stored = true;
    o.state.addExchange(question, answer);
  };
  /** Set once the turn finished or failed; a turn stopped before that gets one marked interrupted. */
  let record: TurnRecord | null = null;
  const recordOf = (interrupted: boolean): TurnRecord => ({
    turnId,
    conversationId: o.conversationId,
    mode: "text",
    protocol: PROTOCOL_VERSION,
    model: o.llm.model,
    promptHash: o.promptHash,
    knowledgeHash: o.bundle.hash,
    marks,
    tokens: {
      input: usage?.input ?? 0,
      cachedInput: usage?.cachedInput ?? 0,
      reasoning: usage?.reasoning ?? 0,
      reasoningEstimated: usage?.reasoningEstimated ?? false,
      output: usage?.output ?? 0,
    },
    ttsChars: 0,
    audioInSeconds: 0,
    costUsd: estimateCostUsd(usage, o.prices),
    coverage,
    dataLine,
    gate: done?.gate ?? gate.summary(),
    grounding: interrupted ? null : (done?.grounding ?? null),
    interrupted,
    error,
  });

  try {
    yield { type: "turn.start", turnId, question };
    try {
      const events = respond({
        llm: withDeadlines(o.llm, {
          now: o.now,
          totalMs: LLM_TOTAL_MS,
          idleMs: LLM_IDLE_MS,
          onFirstText: () => mark("firstAnswerToken"),
          onRetry: (err) => o.log("warn", `llm ${err.kind}, retrying once`),
        }),
        bundle: o.bundle,
        history: [...o.state.history],
        message: question,
        mode: "text",
        signal,
      });
      for await (const ev of events) {
        switch (ev.type) {
          case "reasoning":
            mark("firstReasoning");
            break;
          case "sentence":
            mark("firstSentence");
            shown.push(ev.text);
            yield { type: "sentence", turnId, id: ev.id, text: ev.text };
            break;
          case "gated":
            gate.add({ text: "", blocked: ev.reasons, flags: [] });
            break;
          case "meta":
            dataLine = ev.dataLine;
            if (ev.data) {
              coverage = ev.data.coverage;
              yield { type: "meta", turnId, data: ev.data, sources: sourcesOf(ev.data.refs, o.bundle) };
            } else if (ev.refs?.length) {
              yield { type: "sources", turnId, sources: sourcesOf(ev.refs, o.bundle) };
            }
            break;
          case "usage":
            usage = ev.usage;
            break;
          case "done":
            mark("done");
            done = ev;
            break;
        }
      }
    } catch (err) {
      if (!signal.aborted) {
        error = err instanceof LlmError ? `llm_${err.kind}` : "llm_failed";
        o.log("error", `llm failed: ${err instanceof LlmError ? `${err.kind} ${err.status ?? ""}`.trim() : "unexpected error"}`);
        yield { type: "error", code: "provider", message: "The assistant could not finish that answer. Please try again." };
      }
    }
    if (signal.aborted) return; // stopped: the finally below keeps what was shown
    store(done?.prose ?? shown.join(" "));
    record = recordOf(false);
    yield { type: "turn.end", turnId, record };
  } finally {
    stop.abort();
    if (!stored) store(shown.join(" "));
    o.onRecord?.(record ?? recordOf(true));
  }
}
