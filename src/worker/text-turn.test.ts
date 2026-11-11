import { describe, expect, it, vi } from "vitest";
import { createFakeLlm } from "../adapters/fake-llm";
import type { Bundle } from "../knowledge/types";
import { LlmError, type LlmPort } from "../ports/llm";
import type { ServerEvent } from "../protocol/events";
import type { TurnRecord } from "../protocol/turn-record";
import { ConversationState } from "./conversation-state";
import { sourcesOf, textTurn } from "./text-turn";

const bundle: Bundle = {
  version: "0123456789ab",
  hash: "0123456789ab".padEnd(64, "0"),
  text:
    "## role:magenta — Magenta Connect · Full Stack Developer · Aug 2025 - now\nYash builds AI agents for field teams.\n" +
    "## doc:profile\nYash ships web products.\n",
  refs: ["doc:profile", "doc:resume", "role:magenta"],
  titles: { "role:magenta": "Magenta Connect · Full Stack Developer" },
  keyterms: ["Yash", "Magenta Connect"],
  tokenEstimate: 40,
};

const S0 = "Yash works at Magenta Connect.";
const S1 = "Yash builds AI agents for field teams.";
const META = '<meta>{"refs":["role:magenta","doc:profile"],"coverage":"direct"}</meta>';
const REPLY = `${S0} ${S1}\n${META}`;
const QUESTION = "Where does Yash work?";
const PRICES = { input: 1, cachedInput: 0.1, output: 2 };

function setup(o: { reply?: string; llm?: LlmPort; prices?: typeof PRICES | null; signal?: AbortSignal } = {}) {
  const signals: AbortSignal[] = [];
  const logs: string[] = [];
  const records: TurnRecord[] = [];
  const llm =
    o.llm ??
    createFakeLlm({
      reply: (_req, signal) => {
        if (signal) signals.push(signal);
        return o.reply ?? REPLY;
      },
    });
  const state = new ConversationState({ storage: { get: async () => undefined, put: async () => {} }, now: () => Date.now() });
  const run = () =>
    textTurn({
      conversationId: "conv-1",
      llm,
      prices: o.prices === undefined ? PRICES : o.prices,
      bundle,
      promptHash: "prompthash01",
      state,
      message: QUESTION,
      signal: o.signal ?? new AbortController().signal,
      now: () => Date.now(),
      log: (level, line) => void logs.push(`${level}: ${line}`),
      onRecord: (r) => void records.push(structuredClone(r)),
    });
  return { run, state, signals, logs, records };
}

async function collect(events: AsyncIterable<ServerEvent>): Promise<ServerEvent[]> {
  const out: ServerEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const recordOf = (out: ServerEvent[]): TurnRecord | undefined => out.flatMap((e) => (e.type === "turn.end" ? [e.record] : []))[0];

describe("textTurn", () => {
  it("streams turn.start, the sentences, meta with titled sources, then turn.end", async () => {
    const h = setup();
    const out = await collect(h.run());
    expect(out.map((e) => e.type)).toEqual(["turn.start", "sentence", "sentence", "meta", "turn.end"]);
    const turnId = out[0]?.type === "turn.start" ? out[0].turnId : "";
    expect(turnId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.slice(0, 4)).toEqual([
      { type: "turn.start", turnId, question: QUESTION },
      { type: "sentence", turnId, id: 0, text: S0 },
      { type: "sentence", turnId, id: 1, text: S1 },
      {
        type: "meta",
        turnId,
        data: { refs: ["role:magenta", "doc:profile"], show: null, contact: false, coverage: "direct" },
        sources: [
          { ref: "role:magenta", title: "Magenta Connect · Full Stack Developer" },
          { ref: "doc:profile", title: "doc:profile" }, // untitled: the ref stands in
        ],
      },
    ]);
    expect(out[4]).toMatchObject({ type: "turn.end", turnId });
  });

  it("adds the question and the shown prose to the history", async () => {
    const h = setup();
    await collect(h.run());
    expect(h.state.history).toEqual([
      { role: "user", text: QUESTION },
      { role: "assistant", text: `${S0} ${S1}` },
    ]);
  });

  it("records the turn: text mode, hashes, marks, tokens, cost, gate and grounding", async () => {
    const h = setup();
    const record = recordOf(await collect(h.run()));
    expect(record).toMatchObject({
      conversationId: "conv-1",
      mode: "text",
      protocol: 1,
      model: "fake",
      promptHash: "prompthash01",
      knowledgeHash: bundle.hash,
      ttsChars: 0,
      audioInSeconds: 0,
      coverage: "direct",
      dataLine: "ok",
      gate: { dropped: 0, reasons: [], flags: [] },
      interrupted: false,
      error: null,
    });
    expect(record?.grounding).toEqual({ checked: expect.any(Number), unsupported: [], uncited: [] });
    expect(record?.droppedFrames).toBeUndefined();
    const t = record?.tokens;
    expect(t?.input).toBeGreaterThan(0);
    expect(t?.output).toBeGreaterThan(0);
    // The fake reports no cached input: input × $1 + output × $2 per million.
    expect(record?.costUsd).toBeCloseTo(((t?.input ?? 0) * 1 + (t?.output ?? 0) * 2) / 1e6, 12);
    const m = record?.marks ?? {};
    expect(m.received).toBe(0);
    for (const mark of ["firstReasoning", "firstAnswerToken", "firstSentence", "done"] as const) {
      expect(m[mark], mark).toBeGreaterThanOrEqual(0);
    }
  });

  it("sends no meta for a reply without a data line, and records the data line missing", async () => {
    const out = await collect(setup({ reply: `${S0} ${S1}` }).run());
    expect(out.map((e) => e.type)).toEqual(["turn.start", "sentence", "sentence", "turn.end"]);
    expect(recordOf(out)).toMatchObject({ dataLine: "missing", coverage: null });
  });

  it("records an unparsable data line as invalid", async () => {
    const out = await collect(setup({ reply: `${S0}\n<meta>{oops</meta>` }).run());
    expect(out.map((e) => e.type)).toEqual(["turn.start", "sentence", "turn.end"]);
    expect(recordOf(out)).toMatchObject({ dataLine: "invalid", coverage: null });
  });

  it("sends sources, but no meta, for a bare <refs> list in place of the data line, and records it invalid", async () => {
    const out = await collect(setup({ reply: `${S0} ${S1} <refs>role:magenta, role:amazon</refs>` }).run());
    expect(out.map((e) => e.type)).toEqual(["turn.start", "sentence", "sentence", "sources", "turn.end"]);
    const turnId = out[0]?.type === "turn.start" ? out[0].turnId : "";
    expect(out[3]).toEqual({
      type: "sources",
      turnId,
      sources: [{ ref: "role:magenta", title: "Magenta Connect · Full Stack Developer" }],
    });
    expect(JSON.stringify(out)).not.toContain("<refs>");
    expect(recordOf(out)).toMatchObject({ dataLine: "invalid", coverage: null });
  });

  it("sends nothing for a bare <refs> list with no known refs", async () => {
    const out = await collect(setup({ reply: `${S0} <refs>role:amazon</refs>` }).run());
    expect(out.map((e) => e.type)).toEqual(["turn.start", "sentence", "turn.end"]);
    expect(recordOf(out)?.dataLine).toBe("invalid");
  });

  it("records no cost without prices (the demo)", async () => {
    const record = recordOf(await collect(setup({ prices: null }).run()));
    expect(record?.costUsd).toBeNull();
  });

  it("never shows a sentence the gate dropped, nor keeps it in history, and counts it in the record", async () => {
    const h = setup({ reply: `${S0} See yashos.dev for more.\n${META}` });
    const out = await collect(h.run());
    expect(JSON.stringify(out.filter((e) => e.type !== "turn.end"))).not.toContain("yashos.dev");
    expect(out.flatMap((e) => (e.type === "sentence" ? [e.text] : []))).toEqual([S0]);
    expect(h.state.history[1]).toEqual({ role: "assistant", text: S0 });
    expect(recordOf(out)?.gate).toEqual({ dropped: 1, reasons: ["url"], flags: [] });
  });

  it("on abort after the first sentence: yields nothing more, aborts the LLM and keeps only that sentence", async () => {
    const c = new AbortController();
    const long = [S0, S1, "Yash also designed role-based access control.", "Yash shipped a form engine."].join(" ");
    const h = setup({ reply: `${long}\n${META}`, signal: c.signal });
    const out: ServerEvent[] = [];
    for await (const e of h.run()) {
      out.push(e);
      if (e.type === "sentence") c.abort();
    }
    expect(out.map((e) => e.type)).toEqual(["turn.start", "sentence"]);
    expect(h.signals[0]?.aborted).toBe(true);
    expect(h.state.history).toEqual([
      { role: "user", text: QUESTION },
      { role: "assistant", text: S0 },
    ]);
  });

  it("when the reader stops early, keeps what was yielded and aborts the LLM", async () => {
    const h = setup({ reply: `${S0} ${S1} ${S0}\n${META}` });
    for await (const e of h.run()) if (e.type === "sentence") break;
    expect(h.signals[0]?.aborted).toBe(true);
    expect(h.state.history[1]).toEqual({ role: "assistant", text: S0 });
  });

  it("turns an LLM failure (after its one retry) into a provider error and a record with the error", async () => {
    vi.useFakeTimers();
    try {
      const failing: LlmPort = {
        id: "failing",
        model: "failing-model",
        // eslint-disable-next-line require-yield
        async *stream() {
          throw new LlmError("overloaded", "busy", { status: 529 });
        },
      };
      const h = setup({ llm: failing });
      const done = collect(h.run());
      await vi.runAllTimersAsync();
      const out = await done;
      expect(out.map((e) => e.type)).toEqual(["turn.start", "error", "turn.end"]);
      expect(out[1]).toEqual({ type: "error", code: "provider", message: expect.any(String) });
      // The reply never finished, so there was no data line to check: null, not "missing".
      expect(recordOf(out)).toMatchObject({
        error: "llm_overloaded",
        grounding: null,
        dataLine: null,
        costUsd: null,
        model: "failing-model",
      });
      expect(h.state.history).toEqual([
        { role: "user", text: QUESTION },
        { role: "assistant", text: "" },
      ]);
      expect(h.logs).toEqual(["warn: llm overloaded, retrying once", "error: llm failed: overloaded 529"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers normally when the provider's first refusal (a rate limit) clears on the retry", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const answer = createFakeLlm({ reply: () => REPLY });
      const limited: LlmPort = {
        id: "limited",
        model: "limited-model",
        async *stream(req, signal) {
          if (calls++ === 0) throw new LlmError("rate_limit", "Token Plan rate limit reached", { status: 429 });
          yield* answer.stream(req, signal);
        },
      };
      const h = setup({ llm: limited });
      const done = collect(h.run());
      await vi.runAllTimersAsync();
      const out = await done;
      expect(out.map((e) => e.type)).toEqual(["turn.start", "sentence", "sentence", "meta", "turn.end"]);
      expect(recordOf(out)).toMatchObject({ error: null });
      expect(h.logs).toEqual(["warn: llm rate_limit, retrying once"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands the record to onRecord once, the same one turn.end carries", async () => {
    const h = setup();
    const out = await collect(h.run());
    expect(h.records).toEqual([recordOf(out)]);
  });

  it("hands an LLM failure's record to onRecord too", async () => {
    const failing: LlmPort = {
      id: "failing",
      model: "failing-model",
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new LlmError("bad_request", "nope", { status: 400 });
      },
    };
    const h = setup({ llm: failing });
    await collect(h.run());
    expect(h.records).toEqual([expect.objectContaining({ error: "llm_bad_request", interrupted: false })]);
  });

  it("when stopped, still hands onRecord a record, marked interrupted, with no done mark or grounding", async () => {
    const c = new AbortController();
    const h = setup({ reply: `${S0} ${S1} ${S0}\n${META}`, signal: c.signal });
    const out: ServerEvent[] = [];
    for await (const e of h.run()) {
      out.push(e);
      if (e.type === "sentence") c.abort();
    }
    expect(out.some((e) => e.type === "turn.end")).toBe(false);
    expect(h.records).toHaveLength(1);
    const [record] = h.records;
    const turnId = out[0]?.type === "turn.start" ? out[0].turnId : "";
    expect(record).toMatchObject({ turnId, mode: "text", interrupted: true, grounding: null, dataLine: null, error: null });
    expect(record?.marks.firstSentence).toBeGreaterThanOrEqual(0);
    expect(record?.marks.done).toBeUndefined();
  });

  it("when the reader stops early, still hands onRecord a record marked interrupted", async () => {
    const h = setup({ reply: `${S0} ${S1} ${S0}\n${META}` });
    for await (const e of h.run()) if (e.type === "sentence") break;
    expect(h.records).toEqual([expect.objectContaining({ interrupted: true, grounding: null })]);
  });

  it("stores and echoes the question sanitized", async () => {
    const h = setup();
    const events = textTurn({
      conversationId: "conv-1",
      llm: createFakeLlm({ reply: () => REPLY }),
      prices: null,
      bundle,
      promptHash: "p",
      state: h.state,
      message: "  Where​ does Yash‮ work?  ",
      signal: new AbortController().signal,
      now: () => Date.now(),
      log: () => {},
    });
    const out = await collect(events);
    expect(out[0]).toMatchObject({ type: "turn.start", question: QUESTION });
    expect(h.state.history[0]).toEqual({ role: "user", text: QUESTION });
  });
});

describe("sourcesOf", () => {
  it("pairs each ref with its bundle title, in order, the ref standing in when untitled", () => {
    expect(sourcesOf(["doc:resume", "role:magenta"], bundle)).toEqual([
      { ref: "doc:resume", title: "doc:resume" },
      { ref: "role:magenta", title: "Magenta Connect · Full Stack Developer" },
    ]);
  });
});
