import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmChunk, LlmRequest } from "../ports/llm";
import { createFakeLlm } from "./fake-llm";

const request: LlmRequest = {
  stable: "S".repeat(400),
  turns: [{ role: "user", text: "Where does Yash work?" }],
  tail: "T".repeat(40),
  maxTokens: 8192,
};

async function collect(stream: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createFakeLlm", () => {
  it("is identified as fake", () => {
    const llm = createFakeLlm({ reply: () => "" });
    expect(llm.id).toBe("fake");
    expect(llm.model).toBe("fake");
  });

  it("emits one reasoning tick, the reply in chunks, then usage", async () => {
    const reply = "Yash works at Magenta Connect.";
    const chunks = await collect(createFakeLlm({ reply: () => reply, chunkChars: 7 }).stream(request));

    expect(chunks[0]).toEqual({ t: "reasoning" });
    const texts = chunks.filter((c) => c.t === "text").map((c) => c.text);
    expect(texts).toEqual(["Yash wo", "rks at ", "Magenta", " Connec", "t."]);
    expect(chunks.filter((c) => c.t === "reasoning")).toHaveLength(1);
    expect(chunks.at(-1)).toEqual({
      t: "usage",
      usage: {
        input: Math.ceil((400 + 40 + "Where does Yash work?".length) / 4),
        cachedInput: 0,
        reasoning: 0,
        reasoningEstimated: true,
        output: Math.ceil(reply.length / 4),
        model: "fake",
        stopReason: "end_turn",
      },
    });
  });

  it("passes the request and signal to the reply function", async () => {
    const seen: { req: LlmRequest; signal?: AbortSignal }[] = [];
    const controller = new AbortController();
    const llm = createFakeLlm({
      reply: (req, signal) => {
        seen.push({ req, signal });
        return "ok";
      },
    });
    await collect(llm.stream(request, controller.signal));
    expect(seen).toEqual([{ req: request, signal: controller.signal }]);
  });

  it("never splits an emoji across chunks", async () => {
    const chunks = await collect(createFakeLlm({ reply: () => "a👋b", chunkChars: 2 }).stream(request));
    expect(chunks.filter((c) => c.t === "text").map((c) => c.text)).toEqual(["a👋", "b"]);
  });

  it("waits reasoningMs before the reasoning tick and tokenMs before each chunk", async () => {
    vi.useFakeTimers();
    const llm = createFakeLlm({ reply: () => "abcd", chunkChars: 2, reasoningMs: 100, tokenMs: 10 });
    const iterator = llm.stream(request)[Symbol.asyncIterator]();

    let first: IteratorResult<LlmChunk> | undefined;
    void iterator.next().then((r) => (first = r));
    await vi.advanceTimersByTimeAsync(99);
    expect(first).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(first).toEqual({ done: false, value: { t: "reasoning" } });

    let second: IteratorResult<LlmChunk> | undefined;
    void iterator.next().then((r) => (second = r));
    await vi.advanceTimersByTimeAsync(9);
    expect(second).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(second).toEqual({ done: false, value: { t: "text", text: "ab" } });
  });

  it("stops with an AbortError when the signal aborts mid-stream", async () => {
    const controller = new AbortController();
    const seen: LlmChunk[] = [];
    const run = async () => {
      const llm = createFakeLlm({ reply: () => "a long reply that streams slowly", chunkChars: 2, tokenMs: 5 });
      for await (const c of llm.stream(request, controller.signal)) {
        seen.push(c);
        if (c.t === "text") controller.abort();
      }
    };
    await expect(run()).rejects.toMatchObject({ name: "AbortError" });
    expect(seen.filter((c) => c.t === "text")).toHaveLength(1);
  });

  it("aborts during a wait without waiting it out", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const result = collect(createFakeLlm({ reply: () => "x", reasoningMs: 60_000 }).stream(request, controller.signal));
    const settled = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await settled;
  });

  it("rejects straight away when the signal is already aborted", async () => {
    const llm = createFakeLlm({ reply: () => "x" });
    await expect(collect(llm.stream(request, AbortSignal.abort()))).rejects.toMatchObject({ name: "AbortError" });
  });
});
