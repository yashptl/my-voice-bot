import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmError, type LlmChunk, type LlmPort, type LlmRequest } from "../ports/llm";
import { LLM_RETRY_MS, STOPPED, within, withDeadlines } from "./deadlines";

const REQ: LlmRequest = { stable: "", turns: [{ role: "user", text: "hi" }], tail: "", maxTokens: 10 };
const never = () => new Promise<never>(() => {});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An LLM from a script; records the signal it was given. */
function scripted(run: () => AsyncIterable<LlmChunk>) {
  const signals: AbortSignal[] = [];
  const llm: LlmPort = {
    id: "scripted",
    model: "scripted-model",
    stream(_req, signal) {
      if (signal) signals.push(signal);
      return run();
    },
  };
  return { llm, signals };
}

function guard(llm: LlmPort, onFirstText = () => {}) {
  return withDeadlines(llm, { now: () => Date.now(), totalMs: 30_000, idleMs: 10_000, onFirstText });
}

/** Collects the chunks, or the error the stream ended with. */
async function drain(port: LlmPort, signal?: AbortSignal) {
  const chunks: LlmChunk[] = [];
  try {
    for await (const c of port.stream(REQ, signal)) chunks.push(c);
    return { chunks, error: null };
  } catch (error) {
    return { chunks, error };
  }
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("within", () => {
  it("resolves with the value, or STOPPED on timeout or abort", async () => {
    expect(await within(Promise.resolve(7), 100)).toBe(7);
    const late = within(never(), 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await late).toBe(STOPPED);
    const c = new AbortController();
    const aborted = within(never(), 10_000, c.signal);
    c.abort();
    expect(await aborted).toBe(STOPPED);
  });
});

describe("withDeadlines", () => {
  it("passes chunks through and keeps the LLM's id and model", async () => {
    const { llm } = scripted(async function* () {
      yield { t: "reasoning" };
      yield { t: "text", text: "Hi" };
    });
    const port = guard(llm);
    expect([port.id, port.model]).toEqual(["scripted", "scripted-model"]);
    expect((await drain(port)).chunks).toEqual([{ t: "reasoning" }, { t: "text", text: "Hi" }]);
  });

  it("times out after idleMs without a chunk, aborting the provider request even if it ignores the signal", async () => {
    const { llm, signals } = scripted(async function* () {
      yield { t: "text", text: "Yash " };
      await never();
    });
    const result = drain(guard(llm));
    await vi.advanceTimersByTimeAsync(9_900);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    const { chunks, error } = await result;
    expect(chunks).toEqual([{ t: "text", text: "Yash " }]);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).kind).toBe("timeout");
    expect((error as LlmError).message).toMatch(/nothing for 10000 ms/);
    expect(signals[0]?.aborted).toBe(true);
  });

  it("times out after totalMs though chunks keep coming", async () => {
    const { llm, signals } = scripted(async function* () {
      for (;;) {
        await sleep(5_000);
        yield { t: "text", text: "Yash " };
      }
    });
    const result = drain(guard(llm));
    await vi.advanceTimersByTimeAsync(29_900);
    await vi.advanceTimersByTimeAsync(200);
    const { chunks, error } = await result;
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    expect((error as LlmError).kind).toBe("timeout");
    expect((error as LlmError).message).toMatch(/within 30000 ms/);
    expect(signals[0]?.aborted).toBe(true);
  });

  it("ends with an AbortError as soon as the caller aborts, without waiting for the provider", async () => {
    // eslint-disable-next-line require-yield
    const { llm, signals } = scripted(async function* () {
      await never();
    });
    const c = new AbortController();
    const result = drain(guard(llm), c.signal);
    await vi.advanceTimersByTimeAsync(100);
    c.abort();
    const { error } = await result;
    expect((error as DOMException).name).toBe("AbortError");
    expect(signals[0]?.aborted).toBe(true);
  });

  it("calls onFirstText once, on the first non-empty text chunk", async () => {
    const onFirstText = vi.fn();
    const seenBefore: number[] = [];
    const { llm } = scripted(async function* () {
      yield { t: "reasoning" };
      seenBefore.push(onFirstText.mock.calls.length);
      yield { t: "text", text: "" };
      seenBefore.push(onFirstText.mock.calls.length);
      yield { t: "text", text: "Yash" };
      yield { t: "text", text: " works" };
    });
    await drain(guard(llm, onFirstText));
    expect(seenBefore).toEqual([0, 0]);
    expect(onFirstText).toHaveBeenCalledTimes(1);
  });

  it("does not abort the provider when the stream finishes on its own", async () => {
    const { llm, signals } = scripted(async function* () {
      yield { t: "text", text: "Done." };
    });
    await drain(guard(llm));
    expect(signals[0]?.aborted).toBe(false);
  });
});

describe("withDeadlines retry", () => {
  /** Attempt n (from 0) runs `failures[n]` after its reasoning tick, which throws; the others answer. */
  function flaky(failures: Record<number, () => Promise<void>>) {
    const startedAt: number[] = [];
    const { llm, signals } = scripted(async function* () {
      const n = startedAt.push(Date.now()) - 1;
      yield { t: "reasoning" };
      await failures[n]?.();
      yield { t: "text", text: "Yash works at Magenta Connect." };
    });
    return { llm, signals, startedAt };
  }
  const refuse = (kind: LlmError["kind"]) => async () => {
    throw new LlmError(kind, `provider said ${kind}`, { status: 429 });
  };

  it("retries once, after LLM_RETRY_MS, when the provider rate-limits or is overloaded before any text", async () => {
    for (const kind of ["rate_limit", "overloaded"] as const) {
      const onRetry = vi.fn();
      const h = flaky({ 0: refuse(kind) });
      const result = drain(withDeadlines(h.llm, { now: () => Date.now(), totalMs: 30_000, idleMs: 10_000, onFirstText: () => {}, onRetry }));
      await vi.advanceTimersByTimeAsync(LLM_RETRY_MS);
      const { chunks, error } = await result;
      expect(error).toBeNull();
      expect(chunks).toEqual([{ t: "reasoning" }, { t: "reasoning" }, { t: "text", text: "Yash works at Magenta Connect." }]);
      expect(h.startedAt.length).toBe(2);
      expect((h.startedAt[1] ?? 0) - (h.startedAt[0] ?? 0)).toBe(LLM_RETRY_MS);
      expect(h.signals[0]?.aborted).toBe(true);
      expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ kind }));
    }
  });

  it("gives up after the one retry", async () => {
    const h = flaky({ 0: refuse("rate_limit"), 1: refuse("rate_limit") });
    const result = drain(guard(h.llm));
    await vi.advanceTimersByTimeAsync(LLM_RETRY_MS);
    const { error } = await result;
    expect((error as LlmError).kind).toBe("rate_limit");
    expect(h.startedAt.length).toBe(2);
  });

  it("never retries once answer text has been yielded, so no sentence is repeated", async () => {
    const { llm, signals } = scripted(async function* () {
      yield { t: "text", text: "Yash works " };
      throw new LlmError("overloaded", "overloaded mid-stream");
    });
    const { chunks, error } = await drain(guard(llm));
    expect(chunks).toEqual([{ t: "text", text: "Yash works " }]);
    expect((error as LlmError).kind).toBe("overloaded");
    expect(signals.length).toBe(1);
  });

  it("does not retry other failures", async () => {
    for (const kind of ["auth", "bad_request", "network", "empty", "unknown"] as const) {
      const h = flaky({ 0: refuse(kind) });
      const { error } = await drain(guard(h.llm));
      expect((error as LlmError).kind).toBe(kind);
      expect(h.startedAt.length).toBe(1);
    }
  });

  it("ends with an AbortError, without retrying, when the caller aborts during the wait", async () => {
    const h = flaky({ 0: refuse("rate_limit") });
    const c = new AbortController();
    const result = drain(guard(h.llm), c.signal);
    await vi.advanceTimersByTimeAsync(LLM_RETRY_MS / 2);
    c.abort();
    const { error } = await result;
    expect((error as DOMException).name).toBe("AbortError");
    await vi.advanceTimersByTimeAsync(LLM_RETRY_MS);
    expect(h.startedAt.length).toBe(1);
  });

  it("keeps the total deadline across the retry, and skips a retry the deadline leaves no time for", async () => {
    // The retry starts at 1 s and keeps sending reasoning: the total deadline still ends it at 30 s.
    const slow = scripted(async function* () {
      if (slow.signals.length === 1) throw new LlmError("rate_limit", "slow down");
      for (;;) {
        await sleep(5_000);
        yield { t: "reasoning" };
      }
    });
    const result = drain(guard(slow.llm));
    await vi.advanceTimersByTimeAsync(29_900);
    expect(slow.signals.length).toBe(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(((await result).error as LlmError).message).toMatch(/within 30000 ms/);

    // Refused at 29.5 s, with less than the retry wait left: the refusal stands.
    const late = scripted(async function* () {
      for (let i = 0; i < 5; i++) {
        await sleep(5_000);
        yield { t: "reasoning" };
      }
      await sleep(4_500);
      throw new LlmError("overloaded", "busy");
    });
    const lateResult = drain(guard(late.llm));
    await vi.advanceTimersByTimeAsync(29_500);
    expect(((await lateResult).error as LlmError).kind).toBe("overloaded");
    expect(late.signals.length).toBe(1);
  });
});
