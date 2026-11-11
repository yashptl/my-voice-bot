import { LlmError, type LlmErrorKind, type LlmPort, type LlmRequest } from "../ports/llm";

/** Deadlines for one answer's LLM stream, voice and text alike. Missing one ends the turn with a provider error. */
export const LLM_TOTAL_MS = 30_000;
/** Longest gap between LLM chunks. Reasoning arrives as a single tick, so this also caps silent thinking. */
export const LLM_IDLE_MS = 10_000;
/** The wait before the one retry after a rate limit or overload (the blueprint: one retry, then Messages). */
export const LLM_RETRY_MS = 1_000;

/** Refusals that mean "not right now" (a burst limit, a busy provider), so a second try can succeed. */
const RETRYABLE: ReadonlySet<LlmErrorKind> = new Set(["rate_limit", "overloaded"]);

export const STOPPED = Symbol("stopped");

/** `p`'s value, or STOPPED once `ms` have passed or `signal` aborts, whichever comes first. */
export async function within<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | typeof STOPPED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  const stopped = new Promise<typeof STOPPED>((resolve) => {
    stop = () => resolve(STOPPED);
    if (signal?.aborted) return stop();
    signal?.addEventListener("abort", stop, { once: true });
    timer = setTimeout(stop, Math.max(0, ms));
  });
  try {
    return await Promise.race([p, stopped]);
  } finally {
    clearTimeout(timer);
    if (stop) signal?.removeEventListener("abort", stop);
  }
}

export interface DeadlineOptions {
  now(): number;
  /** The whole answer, first request to last chunk, the retry and its wait included. */
  totalMs: number;
  /** The longest gap between two chunks. */
  idleMs: number;
  /** Called once, on the stream's first non-empty text chunk (the first answer token). */
  onFirstText(): void;
  /** Called with the refusal that is about to be retried, for the log. */
  onRetry?(err: LlmError): void;
}

const abortError = () => new DOMException("The operation was aborted.", "AbortError");

/**
 * `llm` with deadlines (`totalMs` overall, `idleMs` between chunks), raced against the caller's
 * signal so even a provider that ignores aborts cannot hold a turn: an abort ends the stream with an
 * AbortError at once, a missed deadline with an `LlmError` of kind `timeout`. Leaving early (either
 * way, or the caller stopping) aborts the provider's request.
 *
 * A rate limit or overload gets one retry, LLM_RETRY_MS later, within the same total deadline. Only
 * before any answer text: after that the caller has shown sentences, and a second answer would
 * repeat them.
 */
export function withDeadlines(llm: LlmPort, o: DeadlineOptions): LlmPort {
  return {
    id: llm.id,
    model: llm.model,
    async *stream(req, signal) {
      const endAt = o.now() + o.totalMs;
      let texted = false;
      for (let retried = false; ; retried = true) {
        try {
          for await (const chunk of attempt(llm, req, signal, endAt, o)) {
            if (!texted && chunk.t === "text" && chunk.text) {
              texted = true;
              o.onFirstText();
            }
            yield chunk;
          }
          return;
        } catch (err) {
          const retryable = err instanceof LlmError && RETRYABLE.has(err.kind);
          if (!retryable || retried || texted || endAt - o.now() <= LLM_RETRY_MS) throw err;
          o.onRetry?.(err);
          await within(new Promise<never>(() => {}), LLM_RETRY_MS, signal);
          if (signal?.aborted) throw abortError();
        }
      }
    },
  };
}

/** One provider request, held to the idle deadline and to the answer's end time `endAt`. */
async function* attempt(llm: LlmPort, req: LlmRequest, signal: AbortSignal | undefined, endAt: number, o: DeadlineOptions) {
  const deadline = new AbortController();
  const chunks = llm.stream(req, signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal)[Symbol.asyncIterator]();
  let finished = false;
  try {
    for (;;) {
      const overall = endAt - o.now() < o.idleMs;
      const next = await within(chunks.next(), overall ? endAt - o.now() : o.idleMs, signal);
      if (next === STOPPED) {
        if (signal?.aborted) throw abortError();
        throw new LlmError("timeout", overall ? `no complete answer within ${o.totalMs} ms` : `nothing for ${o.idleMs} ms`);
      }
      if (next.done) {
        finished = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!finished) {
      deadline.abort();
      void chunks.return?.()?.catch(() => {});
    }
  }
}
