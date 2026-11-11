import type { LlmChunk, LlmPort, LlmRequest } from "../ports/llm";

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Waits `ms` (skipped when 0) and throws an AbortError if the signal has fired. */
async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms > 0) await sleep(ms, signal);
  if (signal?.aborted) throw abortError();
}

/**
 * A keyless LLM for tests and the demo. Each stream emits one reasoning tick after `reasoningMs`,
 * then the reply in chunks of `chunkChars` characters, `tokenMs` apart, then usage estimated at four
 * characters per token. Aborting the signal stops the stream with an AbortError.
 */
export function createFakeLlm(o: {
  /** Builds the reply text, data line included. Receives the signal so tests can watch it. */
  reply: (req: LlmRequest, signal?: AbortSignal) => string;
  chunkChars?: number;
  reasoningMs?: number;
  tokenMs?: number;
}): LlmPort {
  const chunkChars = Math.max(1, o.chunkChars ?? 12);
  const reasoningMs = o.reasoningMs ?? 0;
  const tokenMs = o.tokenMs ?? 0;

  return {
    id: "fake",
    model: "fake",
    async *stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmChunk> {
      await pause(0, signal);
      const reply = o.reply(req, signal);
      await pause(reasoningMs, signal);
      yield { t: "reasoning" };

      const chars = Array.from(reply); // code points, so no chunk splits a surrogate pair
      for (let i = 0; i < chars.length; i += chunkChars) {
        await pause(tokenMs, signal);
        yield { t: "text", text: chars.slice(i, i + chunkChars).join("") };
      }

      await pause(0, signal);
      const inputChars = req.stable.length + req.tail.length + req.turns.reduce((n, t) => n + t.text.length, 0);
      yield {
        t: "usage",
        usage: {
          input: Math.ceil(inputChars / 4),
          cachedInput: 0,
          reasoning: 0,
          reasoningEstimated: true,
          output: Math.ceil(reply.length / 4),
          model: "fake",
          stopReason: "end_turn",
        },
      };
    },
  };
}
