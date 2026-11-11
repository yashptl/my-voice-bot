import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeLlm } from "../adapters/fake-llm";
import { createFakeStt } from "../adapters/fake-stt";
import { createFakeTts } from "../adapters/fake-tts";
import { buildStable, promptHash } from "../core/prompt";
import type { Bundle } from "../knowledge/types";
import { LlmError, type LlmPort } from "../ports/llm";
import type { TtsPort } from "../ports/tts";
import { decodeAudioFrame, VOICE_FORMAT } from "../protocol/audio";
import type { ServerEvent } from "../protocol/events";
import type { TurnRecord } from "../protocol/turn-record";
import { ConversationState } from "./conversation-state";
import { VoiceLoop } from "./voice-loop";

const bundle: Bundle = {
  version: "0123456789ab",
  hash: "0123456789ab".padEnd(64, "0"),
  text: "## role:magenta — Magenta Connect · Full Stack Developer · Aug 2025 - now\nYash builds AI agents for field teams.\n",
  refs: ["doc:profile", "doc:resume", "role:magenta"],
  titles: { "role:magenta": "Magenta Connect · Full Stack Developer" },
  keyterms: ["Yash", "Magenta Connect"],
  tokenEstimate: 30,
};

const S0 = "Yash works at Magenta Connect.";
const S1 = "Yash built an AI agent for field teams.";
const S2 = "Want to hear more?";
const META = '<meta>{"refs":["role:magenta"],"coverage":"direct"}</meta>';
const REPLY = `${S0} ${S1} ${S2}\n${META}`;
const PROSE = `${S0} ${S1} ${S2}`;
const QUESTION = "Where does Yash work?";
const BYTES_PER_CHAR = 60 * 48; // fake TTS: 60 ms of 24 kHz s16le per character

type Out = ServerEvent | { type: "audio"; sentenceId: number; bytes: number };

function setup(
  o: {
    reply?: string;
    tokenMs?: number;
    maxTurns?: number;
    llm?: LlmPort;
    tts?: TtsPort;
    maxSeconds?: number;
    prices?: { input: number; cachedInput: number; output: number } | null;
    spendTurn?: () => Promise<boolean>;
    idleCloseMs?: number;
  } = {},
) {
  const out: Out[] = [];
  const logs: string[] = [];
  const signals: AbortSignal[] = [];
  const closes: { code: number; reason: string }[] = [];
  const logged: TurnRecord[] = [];
  const stt = createFakeStt();
  const llm =
    o.llm ??
    createFakeLlm({
      reply: (_req, signal) => {
        if (signal) signals.push(signal);
        return o.reply ?? REPLY;
      },
      tokenMs: o.tokenMs ?? 0,
    });
  const state = new ConversationState({
    storage: { get: async () => undefined, put: async () => {} },
    now: () => Date.now(),
    maxTurns: o.maxTurns,
    maxAudioSeconds: o.maxSeconds,
  });
  const ttsCalls: string[] = [];
  const inner = o.tts ?? createFakeTts();
  const tts: TtsPort = {
    id: inner.id,
    format: inner.format,
    async open(cb) {
      const s = await inner.open(cb);
      return {
        speak: (id, text) => (ttsCalls.push(`speak ${id}`), s.speak(id, text)),
        finish: () => (ttsCalls.push("finish"), s.finish()),
        cancel: () => (ttsCalls.push("cancel"), s.cancel()),
      };
    },
  };
  const loop = new VoiceLoop({
    conversationId: "conv-1",
    stt,
    llm,
    tts,
    bundle,
    send(e) {
      if (e instanceof ArrayBuffer) {
        const { sentenceId, pcm } = decodeAudioFrame(e);
        out.push({ type: "audio", sentenceId, bytes: pcm.byteLength });
      } else {
        out.push(structuredClone(e));
      }
    },
    now: () => Date.now(),
    state,
    prices: o.prices,
    spendTurn: o.spendTurn,
    idleCloseMs: o.idleCloseMs,
    closeSocket: (code, reason) => void closes.push({ code, reason }),
    log: (level, line) => void logs.push(`${level}: ${line}`),
    onRecord: (r) => void logged.push(structuredClone(r)),
  });
  return { out, signals, closes, stt, loop, state, ttsCalls, logs, logged };
}

type H = ReturnType<typeof setup>;

const kinds = (out: Out[]) =>
  out.map((e) => {
    switch (e.type) {
      case "state":
        return `state:${e.state}`;
      case "sentence":
        return `sentence:${e.id}`;
      case "audio":
        return `audio:${e.sentenceId}`;
      case "transcript":
        return `transcript:${e.final ? "final" : "partial"}`;
      case "error":
        return `error:${e.code}`;
      default:
        return e.type;
    }
  });

const of = <T extends Out["type"]>(out: Out[], type: T) => out.filter((e): e is Extract<Out, { type: T }> => e.type === type);
const records = (out: Out[]): TurnRecord[] => of(out, "turn.end").map((e) => e.record);

async function ask(h: H, text: string, turnIndex = 0): Promise<void> {
  h.stt.emit({ type: "end", transcript: text, turnIndex });
  await vi.advanceTimersByTimeAsync(0);
}

/** Advances fake time until `pred` holds (fails after 10 s of fake time). */
async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !pred(); i++) await vi.advanceTimersByTimeAsync(10);
  expect(pred()).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("VoiceLoop start", () => {
  it("opens STT with the bundle's keyterms, then sends ready and listening", async () => {
    const h = setup();
    await h.loop.start();
    expect(h.stt.keyterms).toEqual(bundle.keyterms);
    expect(h.out).toEqual([
      { type: "ready", protocol: 1, mode: "voice", audio: VOICE_FORMAT },
      { type: "state", state: "listening" },
    ]);
  });

  it("buffers mic frames that arrive before STT is open, then forwards them unchanged", async () => {
    const h = setup();
    const a = new ArrayBuffer(2560);
    const b = new ArrayBuffer(2560);
    const started = h.loop.start();
    h.loop.onAudio(a);
    await started;
    h.loop.onAudio(b);
    expect(h.stt.frames).toHaveLength(2);
    expect(h.stt.frames[0]).toBe(a);
    expect(h.stt.frames[1]).toBe(b);
  });

  it("when Flux closes an idle socket, reopens it on the next frame and keeps the conversation", async () => {
    const h = setup();
    await h.loop.start();
    expect(h.stt.opens).toBe(1);
    h.stt.drop(); // Flux closes after ~5 s without audio
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.stt.opens).toBe(1); // nothing reopens until the visitor talks again
    const frame = new ArrayBuffer(2560);
    h.loop.onAudio(frame);
    h.loop.onAudio(new ArrayBuffer(2560));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.stt.opens).toBe(2);
    expect(h.stt.frames).toHaveLength(2);
    expect(h.stt.frames[0]).toBe(frame);
    await ask(h, QUESTION);
    await vi.runAllTimersAsync();
    expect(of(h.out, "turn.end")).toHaveLength(1);
    expect(kinds(h.out).filter((k) => k === "ready" || k.startsWith("error"))).toEqual(["ready"]);
    expect(h.closes).toEqual([]);
  });

  it("ignores events from a Flux session that has been replaced", async () => {
    const h = setup();
    await h.loop.start();
    const stale = h.stt.current;
    h.stt.drop();
    h.loop.onAudio(new ArrayBuffer(2560));
    await vi.advanceTimersByTimeAsync(0);
    stale?.onEvent({ type: "end", transcript: "ghost", turnIndex: 0 });
    stale?.onClose();
    expect(of(h.out, "transcript")).toEqual([]);
    expect(h.stt.opens).toBe(2);
  });

  it("failing to open STT ends the conversation with a provider error and no ready", async () => {
    const h = setup();
    h.stt.failOpens = new Error("Flux WebSocket upgrade failed: HTTP 429");
    await h.loop.start();
    expect(kinds(h.out)).toEqual(["error:provider"]);
    expect(h.closes).toEqual([{ code: 1011, reason: "speech recognition failed" }]);
    expect(h.logs).toEqual([expect.stringMatching(/^error: stt failed: .*HTTP 429/)]);
  });

  it("failing to reopen STT ends the conversation too", async () => {
    const h = setup();
    await h.loop.start();
    h.stt.drop();
    h.stt.failOpens = new Error("Flux WebSocket upgrade failed: HTTP 429");
    h.loop.onAudio(new ArrayBuffer(2560));
    await vi.advanceTimersByTimeAsync(0);
    expect(kinds(h.out).slice(-1)).toEqual(["error:provider"]);
    expect(h.closes).toHaveLength(1);
  });

  it("a Flux error on an open session (e.g. its idle KeepAlive error) only drops the session", async () => {
    // Seen live: after ~5 s without audio, Workers AI sends Flux a `KeepAlive` that Flux rejects with a
    // fatal UNPARSABLE_CLIENT_MESSAGE error, then closes.
    const h = setup();
    await h.loop.start();
    h.stt.fail(new Error("Flux error UNPARSABLE_CLIENT_MESSAGE: unknown variant `KeepAlive`"));
    h.stt.drop();
    expect(h.stt.closed).toBe(true);
    h.loop.onAudio(new ArrayBuffer(2560));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.stt.opens).toBe(2);
    expect(h.stt.frames).toHaveLength(1);
    expect(kinds(h.out)).toEqual(["ready", "state:listening", "stt", "stt"]);
    expect(h.closes).toEqual([]);
    // Known Workers AI behaviour, so info that says so, not an error.
    expect(h.logs).toEqual([expect.stringMatching(/^info: stt session 1 closed by Workers AI after/)]);
  });

  describe("logging the Workers AI KeepAlive close", () => {
    // The error as Flux sent it in Yash's first real voice session (flux-stt.ts formats it).
    const KEEPALIVE =
      "Flux error UNPARSABLE_CLIENT_MESSAGE: Could not deserialize last text message: unknown variant `KeepAlive`, " +
      "expected `CloseStream` or `Configure` at line 1 column 19";

    it("says Workers AI closed it after so long without audio, at info, when no audio was ever sent", async () => {
      const h = setup();
      await h.loop.start();
      await vi.advanceTimersByTimeAsync(4924);
      h.stt.fail(new Error(KEEPALIVE));
      expect(h.logs).toEqual([
        "info: stt session 1 closed by Workers AI after 4.9 s without audio (known KeepAlive behaviour); " +
          "it reopens on the next audio frame",
      ]);
    });

    it("counts the time without audio from the last frame when there was one", async () => {
      const h = setup();
      await h.loop.start();
      h.loop.onAudio(new ArrayBuffer(2560));
      await vi.advanceTimersByTimeAsync(3000);
      h.loop.onAudio(new ArrayBuffer(2560));
      await vi.advanceTimersByTimeAsync(5160);
      h.stt.fail(new Error(KEEPALIVE));
      expect(h.logs).toEqual([expect.stringMatching(/^info: stt session 1 closed by Workers AI after 5\.2 s without audio \(known/)]);
      // The client still gets the raw numbers.
      expect(of(h.out, "stt")).toEqual([{ type: "stt", status: "closed", session: 1, openForMs: 8160, idleMs: 5160 }]);
    });

    it("still warns about any other Flux error on an open session", async () => {
      const h = setup();
      await h.loop.start();
      await vi.advanceTimersByTimeAsync(1200);
      h.stt.fail(new Error("Flux error INTERNAL: something broke"));
      expect(h.logs).toEqual([
        "warn: stt session 1 ended (Flux error INTERNAL: something broke) after 1200 ms, with no audio sent; " +
          "it reopens on the next audio frame",
      ]);
    });
  });

  it("tells the client when Flux closes the session and when a new one opens, for G6", async () => {
    const h = setup();
    await h.loop.start();
    h.loop.onAudio(new ArrayBuffer(2560));
    await vi.advanceTimersByTimeAsync(3000);
    h.loop.onAudio(new ArrayBuffer(2560));
    await vi.advanceTimersByTimeAsync(5200);
    h.stt.drop(); // Flux gave up 5.2 s after the last frame, 8.2 s after it opened
    expect(of(h.out, "stt")).toEqual([{ type: "stt", status: "closed", session: 1, openForMs: 8200, idleMs: 5200 }]);
    h.loop.onAudio(new ArrayBuffer(2560));
    await vi.advanceTimersByTimeAsync(0);
    expect(of(h.out, "stt").at(-1)).toEqual({ type: "stt", status: "reopened", session: 2 });
    // The routine idle close is info, not an error.
    expect(h.logs).toEqual([expect.stringMatching(/^info: stt session 1 ended \(closed\)/)]);
  });

  it("reports idleMs null when the closed session never got audio", async () => {
    const h = setup();
    await h.loop.start();
    await vi.advanceTimersByTimeAsync(5000);
    h.stt.drop();
    expect(of(h.out, "stt")).toEqual([{ type: "stt", status: "closed", session: 1, openForMs: 5000, idleMs: null }]);
  });

  it("gives up after 60 STT sessions, so a failing provider cannot loop forever", async () => {
    const h = setup();
    await h.loop.start();
    for (let i = 0; i < 60; i++) {
      h.stt.drop();
      h.loop.onAudio(new ArrayBuffer(2560));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(h.stt.opens).toBe(60);
    expect(of(h.out, "error").map((e) => e.code)).toEqual(["provider"]);
    expect(h.closes).toHaveLength(1);
  });
});

describe("VoiceLoop turn", () => {
  it("answers an end-of-turn in order: thinking, turn.start, sentences with audio, meta, turn.end, listening", async () => {
    const h = setup();
    await h.loop.start();
    h.stt.emit({ type: "start", transcript: "Where", turnIndex: 0 });
    h.stt.emit({ type: "update", transcript: "Where does", turnIndex: 0 });
    h.stt.emit({ type: "eager", transcript: QUESTION, turnIndex: 0 });
    await vi.advanceTimersByTimeAsync(120);
    await ask(h, QUESTION);
    await vi.runAllTimersAsync();

    const k = kinds(h.out);
    const at = (s: string) => k.indexOf(s);
    expect(k.slice(2, 5)).toEqual(["transcript:partial", "transcript:partial", "transcript:final"]);
    expect(of(h.out, "transcript").map((t) => t.text)).toEqual(["Where", "Where does", QUESTION]);
    expect(at("state:thinking")).toBeGreaterThan(at("transcript:final"));
    expect(at("turn.start")).toBe(at("state:thinking") + 1);
    expect(at("sentence:0")).toBeGreaterThan(at("turn.start"));
    expect(at("audio:0")).toBeGreaterThan(at("sentence:0"));
    expect(at("state:speaking")).toBe(at("audio:0") - 1);
    expect(at("audio:1")).toBeGreaterThan(at("audio:0"));
    expect(at("audio:2")).toBeGreaterThan(at("audio:1"));
    expect(at("meta")).toBeGreaterThan(at("sentence:2"));
    expect(at("turn.end")).toBeGreaterThan(k.lastIndexOf("audio:2"));
    expect(k.slice(-2)).toEqual(["turn.end", "state:listening"]);

    const turnId = of(h.out, "turn.start")[0]?.turnId;
    expect(of(h.out, "turn.start")[0]).toEqual({ type: "turn.start", turnId, question: QUESTION });
    expect(of(h.out, "sentence")).toEqual([
      { type: "sentence", turnId, id: 0, text: S0 },
      { type: "sentence", turnId, id: 1, text: S1 },
      { type: "sentence", turnId, id: 2, text: S2 },
    ]);
    expect(of(h.out, "meta")[0]).toEqual({
      type: "meta",
      turnId,
      data: { refs: ["role:magenta"], show: null, contact: false, coverage: "direct" },
      sources: [{ ref: "role:magenta", title: "Magenta Connect · Full Stack Developer" }],
    });
    const bytes = (id: number) =>
      of(h.out, "audio")
        .filter((a) => a.sentenceId === id)
        .reduce((n, a) => n + a.bytes, 0);
    expect([bytes(0), bytes(1), bytes(2)]).toEqual([S0, S1, S2].map((s) => s.length * BYTES_PER_CHAR));

    expect(h.loop.history).toEqual([
      { role: "user", text: QUESTION },
      { role: "assistant", text: PROSE },
    ]);
  });

  it("records the turn: marks, hashes, tokens, characters spoken and audio heard", async () => {
    const h = setup({ tokenMs: 5 });
    await h.loop.start();
    for (let i = 0; i < 25; i++) {
      h.loop.onAudio(new ArrayBuffer(2560));
      await vi.advanceTimersByTimeAsync(80);
    }
    h.stt.emit({ type: "eager", transcript: QUESTION, turnIndex: 0 });
    await vi.advanceTimersByTimeAsync(200);
    await ask(h, QUESTION);
    await vi.runAllTimersAsync();

    const [record] = records(h.out);
    const turnId = of(h.out, "turn.start")[0]?.turnId;
    expect(record).toMatchObject({
      turnId,
      conversationId: "conv-1",
      mode: "voice",
      protocol: 1,
      model: "fake",
      promptHash: await promptHash(buildStable(bundle)),
      knowledgeHash: bundle.hash,
      ttsChars: S0.length + S1.length + S2.length,
      audioInSeconds: 2,
      droppedFrames: 0,
      coverage: "direct",
      dataLine: "ok",
      interrupted: false,
      error: null,
    });
    expect(record?.tokens.output).toBeGreaterThan(0);
    expect(record?.tokens.input).toBeGreaterThan(0);
    const m = record?.marks ?? {};
    expect(m.received).toBe(0);
    expect(m.endOfTurn).toBe(0);
    expect(m.eagerEndOfTurn).toBe(-200);
    for (const mark of ["firstReasoning", "firstAnswerToken", "firstSentence", "firstAudio", "done"] as const) {
      expect(m[mark], mark).toBeGreaterThanOrEqual(0);
    }
    expect(m.firstAnswerToken).toBeLessThan(m.firstSentence ?? -1);
    expect(m.firstSentence).toBeLessThan(m.firstAudio ?? -1);
  });

  it("sends a partial transcript only when its text changes (Flux repeats Update every ~0.25 s)", async () => {
    const h = setup();
    await h.loop.start();
    for (const text of ["", "", "Where", "Where", "Where does", "Where does"]) {
      h.stt.emit({ type: "update", transcript: text, turnIndex: 0 });
    }
    await ask(h, QUESTION);
    await vi.runAllTimersAsync();
    h.stt.emit({ type: "update", transcript: "", turnIndex: 1 });
    h.stt.emit({ type: "start", transcript: "Where", turnIndex: 1 });
    expect(of(h.out, "transcript").map((t) => `${t.turnIndex}:${t.final ? "final" : "partial"}:${t.text}`)).toEqual([
      "0:partial:Where",
      "0:partial:Where does",
      `0:final:${QUESTION}`,
      "1:partial:Where",
    ]);
  });

  it("drops the eager mark when Flux resumes the turn", async () => {
    const h = setup();
    await h.loop.start();
    h.stt.emit({ type: "eager", transcript: "Where does", turnIndex: 0 });
    h.stt.emit({ type: "resumed", transcript: "Where does", turnIndex: 0 });
    await ask(h, QUESTION);
    await vi.runAllTimersAsync();
    expect(records(h.out)[0]?.marks.eagerEndOfTurn).toBeUndefined();
  });

  it("ignores an end-of-turn with no words", async () => {
    const h = setup();
    await h.loop.start();
    await ask(h, "   ");
    await vi.runAllTimersAsync();
    expect(kinds(h.out)).toEqual(["ready", "state:listening", "transcript:final"]);
    expect(h.loop.history).toEqual([]);
  });

  it("records client marks that arrive while the turn runs", async () => {
    const h = setup({ tokenMs: 20 });
    await h.loop.start();
    await ask(h, QUESTION);
    const turnId = of(h.out, "turn.start")[0]?.turnId ?? "";
    await vi.advanceTimersByTimeAsync(30);
    h.loop.onMessage({ type: "mark", turnId, mark: "clientTurnEnd", at: 123 });
    h.loop.onMessage({ type: "mark", turnId: "someone-else", mark: "clientFirstAudioPlayed", at: 456 });
    await vi.runAllTimersAsync();
    const marks = records(h.out)[0]?.marks ?? {};
    expect(marks.clientTurnEnd).toBe(30);
    expect(marks.clientFirstAudioPlayed).toBeUndefined();
  });

  it("turns an LLM failure into a provider error and keeps listening for the next turn", async () => {
    let calls = 0;
    const flaky: LlmPort = {
      id: "flaky",
      model: "flaky-model",
      async *stream(req, signal) {
        // Overloaded twice: the first question's call and its one retry.
        if (calls++ < 2) throw new LlmError("overloaded", "busy", { status: 529 });
        yield* createFakeLlm({ reply: () => REPLY }).stream(req, signal);
      },
    };
    const h = setup({ llm: flaky });
    await h.loop.start();
    await ask(h, QUESTION);
    await vi.runAllTimersAsync();
    expect(kinds(h.out).slice(-4)).toEqual(["turn.start", "error:provider", "turn.end", "state:listening"]);
    expect(records(h.out)[0]).toMatchObject({ error: "llm_overloaded", interrupted: false });
    expect(h.closes).toEqual([]);

    await ask(h, "And before that?", 1);
    await vi.runAllTimersAsync();
    expect(records(h.out)[1]).toMatchObject({ error: null });
    expect(h.loop.history.map((t) => t.text)).toEqual([QUESTION, "", "And before that?", PROSE]);
  });

  it("keeps the captions going when speech fails, with one provider error", async () => {
    const brokenTts: TtsPort = {
      id: "broken",
      format: VOICE_FORMAT,
      open: async () => {
        throw new Error("MiniMax TTS failed (status 1004): auth");
      },
    };
    const h = setup({ tts: brokenTts });
    await h.loop.start();
    await ask(h, QUESTION);
    await vi.runAllTimersAsync();
    expect(of(h.out, "error")).toEqual([{ type: "error", code: "provider", message: expect.any(String) }]);
    expect(of(h.out, "sentence")).toHaveLength(3);
    expect(of(h.out, "audio")).toHaveLength(0);
    expect(records(h.out)[0]).toMatchObject({ error: "tts_failed", interrupted: false });
    expect(h.loop.history[1]?.text).toBe(PROSE);
  });

  it("passes earlier turns to the LLM as history", async () => {
    const seen: string[][] = [];
    const llm = createFakeLlm({
      reply: (req) => {
        seen.push(req.turns.map((t) => `${t.role}:${t.text.includes("visitor_message") ? "<wrapped>" : t.text}`));
        return REPLY;
      },
    });
    const h = setup({ llm });
    await h.loop.start();
    await ask(h, QUESTION);
    await vi.runAllTimersAsync();
    await ask(h, "What else?", 1);
    await vi.runAllTimersAsync();
    expect(seen).toEqual([["user:<wrapped>"], ["user:<wrapped>", `assistant:${PROSE}`, "user:<wrapped>"]]);
  });

  it("stores and echoes the question sanitized", async () => {
    const h = setup();
    await h.loop.start();
    await ask(h, "Where\u200B does Yash\u202E work?");
    await vi.runAllTimersAsync();
    expect(of(h.out, "turn.start")[0]?.question).toBe("Where does Yash work?");
    expect(h.loop.history[0]).toEqual({ role: "user", text: "Where does Yash work?" });
  });
});

describe("VoiceLoop interrupt", () => {
  // Fast tokens and a long reply: when sentence 0's audio arrives, sentence 1 is already queued in
  // TTS and the LLM is still streaming, so the interrupt has later audio and a live stream to stop.
  const LONG = [
    S0,
    S1,
    S2,
    "Yash also designed hierarchical RBAC with action-level permissions.",
    "Yash shipped a dynamic form engine for field sales reporting.",
    "Yash moved the platform to Module Federation micro-frontends.",
  ].join(" ");

  async function interruptAfterFirstAudio(lastHeardSentenceId: number | null) {
    const h = setup({ tokenMs: 5, reply: `${LONG}\n${META}` });
    await h.loop.start();
    await ask(h, QUESTION);
    await until(() => kinds(h.out).includes("audio:0"));
    expect(kinds(h.out)).toContain("sentence:1"); // handed to TTS, not yet synthesized
    expect(kinds(h.out)).not.toContain("audio:1");
    const turnId = of(h.out, "turn.start")[0]?.turnId ?? "";
    const cut = h.out.length;
    h.loop.onMessage({ type: "interrupt", turnId, lastHeardSentenceId });
    await vi.runAllTimersAsync();
    return { h, after: h.out.slice(cut) };
  }

  it("stops later audio, aborts the LLM and keeps only the heard sentences", async () => {
    const { h, after } = await interruptAfterFirstAudio(0);
    expect(of(after, "audio")).toEqual([]);
    expect(h.signals).toHaveLength(1);
    expect(h.signals[0]?.aborted).toBe(true);
    expect(of(h.out, "meta")).toEqual([]); // the stream never reached its data line
    expect(of(h.out, "sentence").some((s) => s.id === 5)).toBe(false);
    expect(kinds(after)).toEqual(["turn.end", "state:listening"]);
    expect(h.ttsCalls.filter((c) => c === "cancel")).toHaveLength(1); // stops synthesis (and billing) too
    expect(h.ttsCalls).not.toContain("finish");
    expect(records(h.out)[0]).toMatchObject({ interrupted: true, error: null, dataLine: null });
    expect(h.loop.history).toEqual([
      { role: "user", text: QUESTION },
      { role: "assistant", text: S0 },
    ]);
  });

  it("keeps no assistant text when nothing was heard", async () => {
    const { h } = await interruptAfterFirstAudio(null);
    expect(h.loop.history).toEqual([
      { role: "user", text: QUESTION },
      { role: "assistant", text: "" },
    ]);
  });

  it("trims history and marks the record when the interrupt arrives after turn.end (audio still playing)", async () => {
    // The usual case with real TTS, which synthesizes faster than real time.
    const h = setup();
    await h.loop.start();
    await ask(h, QUESTION);
    await vi.runAllTimersAsync();
    const turnId = of(h.out, "turn.start")[0]?.turnId ?? "";
    const [ended] = records(h.out);
    const cut = h.out.length;
    h.loop.onMessage({ type: "interrupt", turnId, lastHeardSentenceId: 1 });
    expect(h.loop.history[1]).toEqual({ role: "assistant", text: `${S0} ${S1}` });
    expect(h.out.slice(cut)).toEqual([
      { type: "turn.interrupted", turnId, lastHeardSentenceId: 1, record: { ...ended, interrupted: true } },
    ]);
    // A repeat or a later interrupt for the same turn cannot widen it again, and sends nothing.
    h.loop.onMessage({ type: "interrupt", turnId, lastHeardSentenceId: 2 });
    expect(h.loop.history[1]?.text).toBe(`${S0} ${S1}`);
    expect(h.out.slice(cut)).toHaveLength(1);
  });

  it("marks the ended turn interrupted even when the last sentence had started (history kept whole)", async () => {
    const h = setup();
    await h.loop.start();
    await ask(h, QUESTION);
    await vi.runAllTimersAsync();
    const turnId = of(h.out, "turn.start")[0]?.turnId ?? "";
    h.loop.onMessage({ type: "interrupt", turnId, lastHeardSentenceId: 2 });
    expect(h.loop.history[1]?.text).toBe(PROSE);
    expect(of(h.out, "turn.interrupted")).toMatchObject([{ turnId, lastHeardSentenceId: 2, record: { interrupted: true } }]);
  });

  it("ignores an interrupt for a turn that is not the latest", async () => {
    const h = setup();
    await h.loop.start();
    await ask(h, QUESTION);
    await vi.runAllTimersAsync();
    const first = of(h.out, "turn.start")[0]?.turnId ?? "";
    await ask(h, "What else?", 1);
    await vi.runAllTimersAsync();
    h.loop.onMessage({ type: "interrupt", turnId: first, lastHeardSentenceId: null });
    expect(h.loop.history.map((t) => t.text)).toEqual([QUESTION, PROSE, "What else?", PROSE]);
  });

  it("a second end-of-turn interrupts the running turn, then answers the new one", async () => {
    const h = setup({ tokenMs: 50 });
    await h.loop.start();
    await ask(h, QUESTION);
    await until(() => kinds(h.out).includes("audio:0"));
    const cut = h.out.length;
    await ask(h, "And at Amazon?", 1);
    await vi.runAllTimersAsync();

    const [first, second] = of(h.out, "turn.start").map((t) => t.turnId);
    expect(first).not.toBe(second);
    expect(h.signals[0]?.aborted).toBe(true);
    const after = kinds(h.out.slice(cut));
    expect(after.slice(0, 3)).toEqual(["transcript:final", "turn.end", "state:listening"]);
    expect(after.slice(3, 5)).toEqual(["state:thinking", "turn.start"]);
    // No audio from the first turn after the second began: every frame after it belongs to the new reply.
    const audioAfter = of(h.out.slice(h.out.findIndex((e) => e.type === "turn.start" && e.turnId === second)), "audio");
    expect(audioAfter.reduce((n, a) => n + a.bytes, 0)).toBe((S0.length + S1.length + S2.length) * BYTES_PER_CHAR);
    expect(records(h.out).map((r) => r.interrupted)).toEqual([true, false]);
    expect(h.loop.history.map((t) => t.text)).toEqual([QUESTION, "", "And at Amazon?", PROSE]);
  });
});

describe("VoiceLoop deadlines", () => {
  const never = () => new Promise<never>(() => {});
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** The turn ended with a provider error and this record error, and the loop is listening again. */
  function expectTimedOut(h: H, error: string) {
    expect(kinds(h.out).slice(-3)).toEqual(["error:provider", "turn.end", "state:listening"]);
    expect(records(h.out)).toMatchObject([{ error, interrupted: false }]);
    expect(h.closes).toEqual([]);
  }

  it("gives up on an LLM that sends nothing for 10 s, even one that ignores its abort signal", async () => {
    const signals: AbortSignal[] = [];
    const stalled: LlmPort = {
      id: "stalled",
      model: "stalled",
      // eslint-disable-next-line require-yield
      async *stream(_req, signal) {
        if (signal) signals.push(signal);
        await never();
      },
    };
    const h = setup({ llm: stalled });
    await h.loop.start();
    await ask(h, QUESTION);
    await vi.advanceTimersByTimeAsync(9_900);
    expect(of(h.out, "turn.end")).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expectTimedOut(h, "llm_timeout");
    expect(signals[0]?.aborted).toBe(true); // the provider request is cancelled too
    expect(h.logs).toContainEqual(expect.stringMatching(/^error: llm failed: timeout/));
  });

  it("gives up on an LLM still streaming after 30 s, though chunks keep coming", async () => {
    const trickle: LlmPort = {
      id: "trickle",
      model: "trickle",
      async *stream() {
        for (;;) {
          await sleep(5_000);
          yield { t: "text", text: "Yash " };
        }
      },
    };
    const h = setup({ llm: trickle });
    await h.loop.start();
    await ask(h, QUESTION);
    await vi.advanceTimersByTimeAsync(29_900);
    expect(of(h.out, "turn.end")).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expectTimedOut(h, "llm_timeout");
  });

  it("keeps the captions when speech does not open within 5 s, and cancels it if it opens later", async () => {
    let lateCancelled = false;
    const slow: TtsPort = {
      id: "slow",
      format: VOICE_FORMAT,
      open: async () => {
        await sleep(60_000);
        return { speak() {}, finish: async () => {}, cancel: () => void (lateCancelled = true) };
      },
    };
    const h = setup({ tts: slow });
    await h.loop.start();
    await ask(h, QUESTION);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(of(h.out, "turn.end")).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(of(h.out, "sentence")).toHaveLength(3);
    expectTimedOut(h, "tts_timeout");
    await vi.runAllTimersAsync();
    expect(lateCancelled).toBe(true);
    expect(of(h.out, "audio")).toEqual([]);
  });

  it("gives up on a TTS finish that does not resolve within 15 s, and cancels the speech", async () => {
    const inner = createFakeTts();
    const stuck: TtsPort = {
      id: "stuck",
      format: VOICE_FORMAT,
      async open(cb) {
        const s = await inner.open(cb);
        return { speak: (id, text) => s.speak(id, text), finish: never, cancel: () => s.cancel() };
      },
    };
    const h = setup({ tts: stuck });
    await h.loop.start();
    await ask(h, QUESTION);
    await vi.advanceTimersByTimeAsync(14_900);
    expect(of(h.out, "turn.end")).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expectTimedOut(h, "tts_timeout");
    expect(h.ttsCalls.slice(-2)).toEqual(["finish", "cancel"]);
  });

  it("lets an interrupt end a turn whose LLM is stalled at once, without waiting for the deadline", async () => {
    const stalled: LlmPort = {
      id: "stalled",
      model: "stalled",
      // eslint-disable-next-line require-yield
      async *stream() {
        await never();
      },
    };
    const h = setup({ llm: stalled });
    await h.loop.start();
    await ask(h, QUESTION);
    const turnId = of(h.out, "turn.start")[0]?.turnId ?? "";
    h.loop.onMessage({ type: "interrupt", turnId, lastHeardSentenceId: null });
    expect(kinds(h.out).slice(-2)).toEqual(["turn.end", "state:listening"]);
    await vi.runAllTimersAsync();
    expect(of(h.out, "error")).toEqual([]);
    expect(records(h.out)).toMatchObject([{ interrupted: true, error: null }]);
  });
});

describe("VoiceLoop limits", () => {
  it("refuses a turn past maxTurns with a limit error and ends the conversation", async () => {
    const h = setup({ maxTurns: 1 });
    await h.loop.start();
    await ask(h, QUESTION);
    await vi.runAllTimersAsync();
    await ask(h, "One more?", 1);
    await vi.runAllTimersAsync();
    expect(of(h.out, "turn.start")).toHaveLength(1);
    expect(kinds(h.out).slice(-1)).toEqual(["error:limit"]);
    expect(h.closes).toHaveLength(1);
    expect(h.stt.closed).toBe(true);
  });

  it("defaults maxTurns to 30", async () => {
    const h = setup();
    await h.loop.start();
    for (let i = 0; i < 31; i++) {
      await ask(h, `Question ${i}?`, i);
      await vi.runAllTimersAsync();
    }
    expect(of(h.out, "turn.start")).toHaveLength(30);
    expect(of(h.out, "error").map((e) => e.code)).toEqual(["limit"]);
  });

  it("drops frames sent faster than real time, with one protocol error, and counts them in the record", async () => {
    const h = setup();
    await h.loop.start();
    for (let i = 0; i < 80; i++) h.loop.onAudio(new ArrayBuffer(2560)); // 6.4 s at once
    expect(h.stt.frames).toHaveLength(62); // 5 s ahead of real time is the most allowed
    expect(of(h.out, "error")).toEqual([{ type: "error", code: "protocol", message: expect.any(String) }]);
    expect(h.closes).toEqual([]);
    await ask(h, QUESTION);
    await vi.runAllTimersAsync();
    await ask(h, "And before that?", 1);
    await vi.runAllTimersAsync();
    expect(records(h.out).map((r) => r.droppedFrames)).toEqual([18, 0]);
  });

  it("ends the conversation when the audio limit is reached", async () => {
    const h = setup({ maxSeconds: 1 });
    await h.loop.start();
    for (let i = 0; i < 14; i++) {
      h.loop.onAudio(new ArrayBuffer(2560));
      await vi.advanceTimersByTimeAsync(80);
    }
    expect(h.stt.frames).toHaveLength(12); // 12 × 80 ms = 0.96 s; the 13th would cross 1 s
    expect(of(h.out, "error").map((e) => e.code)).toEqual(["limit"]);
    expect(h.closes).toHaveLength(1);
    expect(h.stt.closed).toBe(true);
  });

  it("close() aborts the running turn and sends nothing more", async () => {
    const h = setup({ tokenMs: 50 });
    await h.loop.start();
    await ask(h, QUESTION);
    await vi.advanceTimersByTimeAsync(60);
    const cut = h.out.length;
    h.loop.close();
    await vi.runAllTimersAsync();
    expect(h.out.slice(cut)).toEqual([]);
    expect(h.signals[0]?.aborted).toBe(true);
    expect(h.stt.closed).toBe(true);
    h.loop.onAudio(new ArrayBuffer(2560));
    h.stt.emit({ type: "end", transcript: "late", turnIndex: 1 });
    expect(h.out.slice(cut)).toEqual([]);
  });
});

describe("VoiceLoop onRecord (the turn log)", () => {
  it("gets each turn's record as turn.end sends it", async () => {
    const h = setup();
    await h.loop.start();
    await ask(h, QUESTION);
    await vi.runAllTimersAsync();
    await ask(h, "And before that?", 1);
    await vi.runAllTimersAsync();
    expect(h.logged).toEqual(records(h.out));
    expect(h.logged).toHaveLength(2);
  });

  it("gets the updated record after a late interrupt, once", async () => {
    const h = setup();
    await h.loop.start();
    await ask(h, QUESTION);
    await vi.runAllTimersAsync();
    const turnId = of(h.out, "turn.start")[0]?.turnId ?? "";
    h.loop.onMessage({ type: "interrupt", turnId, lastHeardSentenceId: 0 });
    h.loop.onMessage({ type: "interrupt", turnId, lastHeardSentenceId: 1 });
    const [ended] = records(h.out);
    expect(h.logged).toEqual([ended, { ...ended, interrupted: true }]);
  });

  it("gets a record marked interrupted when the socket closes mid-answer, though nothing more is sent", async () => {
    const h = setup({ tokenMs: 50 });
    await h.loop.start();
    await ask(h, QUESTION);
    await until(() => kinds(h.out).includes("sentence:0"));
    h.loop.close();
    await vi.runAllTimersAsync();
    expect(of(h.out, "turn.end")).toEqual([]);
    const turnId = of(h.out, "turn.start")[0]?.turnId ?? "";
    expect(h.logged).toEqual([expect.objectContaining({ turnId, mode: "voice", interrupted: true, grounding: null })]);
    h.loop.close();
    expect(h.logged).toHaveLength(1);
  });

  it("gets nothing for a turn interrupted while its spend was pending (no model call)", async () => {
    const spends: ((ok: boolean) => void)[] = [];
    const h = setup({ spendTurn: () => new Promise<boolean>((resolve) => void spends.push(resolve)) });
    await h.loop.start();
    await ask(h, QUESTION);
    const first = of(h.out, "turn.start")[0]?.turnId ?? "";
    h.loop.onMessage({ type: "interrupt", turnId: first, lastHeardSentenceId: null });
    spends[0]?.(true);
    await vi.runAllTimersAsync();
    expect(h.signals).toEqual([]); // the model was never called
    expect(records(h.out)).toMatchObject([{ turnId: first, interrupted: true }]); // the client still gets turn.end
    expect(h.logged).toEqual([]);

    // The same when a second end-of-turn interrupts it: only the answered turn is logged.
    await ask(h, "And at Amazon?", 1);
    await ask(h, "And before that?", 2);
    const [, second, third] = of(h.out, "turn.start").map((t) => t.turnId);
    spends[1]?.(true);
    spends[2]?.(true);
    await vi.runAllTimersAsync();
    expect(h.signals).toHaveLength(1);
    expect(records(h.out).map((r) => r.turnId)).toEqual([first, second, third]);
    expect(h.logged).toEqual([expect.objectContaining({ turnId: third, interrupted: false })]);
  });

  it("gets nothing for a turn the day's ceiling refused (no model call)", async () => {
    const h = setup({ spendTurn: async () => false });
    await h.loop.start();
    await ask(h, QUESTION);
    await vi.runAllTimersAsync();
    expect(h.logged).toEqual([]);
  });
});

describe("VoiceLoop parity with text", () => {
  it("records cost from the profile's prices, the gate summary and the grounding check", async () => {
    const h = setup({ prices: { input: 1, cachedInput: 0.1, output: 2 } });
    await h.loop.start();
    await ask(h, QUESTION);
    await vi.runAllTimersAsync();
    const [record] = records(h.out);
    expect(record?.gate).toEqual({ dropped: 0, reasons: [], flags: [] });
    expect(record?.grounding).toEqual({ checked: expect.any(Number), unsupported: [], uncited: [] });
    const t = record?.tokens;
    expect(record?.costUsd).toBeCloseTo(((t?.input ?? 0) * 1 + (t?.output ?? 0) * 2) / 1e6, 12);
  });

  it("records no cost without prices (the demo)", async () => {
    const h = setup();
    await h.loop.start();
    await ask(h, QUESTION);
    await vi.runAllTimersAsync();
    expect(records(h.out)[0]?.costUsd).toBeNull();
  });

  it("never captions or speaks a sentence the gate dropped, and counts it in the record", async () => {
    const h = setup({ reply: `${S0} Write to yash@example.com any time. ${S2}\n${META}` });
    await h.loop.start();
    await ask(h, QUESTION);
    await vi.runAllTimersAsync();
    expect(of(h.out, "sentence").map((s) => [s.id, s.text])).toEqual([
      [0, S0],
      [1, S2],
    ]);
    expect(h.ttsCalls.filter((c) => c.startsWith("speak"))).toEqual(["speak 0", "speak 1"]);
    expect(JSON.stringify(h.out)).not.toContain("yash@example.com");
    expect(records(h.out)[0]?.gate).toEqual({ dropped: 1, reasons: ["url", "email"], flags: [] });
    expect(h.loop.history[1]).toEqual({ role: "assistant", text: `${S0} ${S2}` });
  });

  it("records a pressed answer without a data line as missing, but still offers Messages", async () => {
    // Seen in Yash's first voice session: the pressed-gap line, then nothing. The rules fix its fields.
    const h = setup({ reply: "That isn't in what I know about Yash's work, so I won't guess. Yash can answer that directly." });
    await h.loop.start();
    await ask(h, QUESTION);
    await vi.runAllTimersAsync();
    expect(of(h.out, "meta")).toMatchObject([{ data: { contact: true, coverage: "none" } }]);
    expect(records(h.out)[0]).toMatchObject({ dataLine: "missing", coverage: "none" });
  });

  it("records any other reply without a data line as missing, and sends no meta", async () => {
    const h = setup({ reply: `${S0} ${S1}` });
    await h.loop.start();
    await ask(h, QUESTION);
    await vi.runAllTimersAsync();
    expect(of(h.out, "meta")).toEqual([]);
    expect(records(h.out)[0]).toMatchObject({ dataLine: "missing", coverage: null });
  });

  it("neither captions nor speaks a bare <refs> list, sends its known refs as sources, and records it invalid", async () => {
    const h = setup({ reply: `${S0} ${S1}\n<refs>role:magenta, role:amazon</refs>` });
    await h.loop.start();
    await ask(h, QUESTION);
    await vi.runAllTimersAsync();
    expect(of(h.out, "sentence").map((s) => s.text)).toEqual([S0, S1]);
    expect(h.ttsCalls.filter((c) => c.startsWith("speak"))).toEqual(["speak 0", "speak 1"]);
    expect(JSON.stringify(h.out)).not.toContain("<refs>");
    const turnId = of(h.out, "turn.start")[0]?.turnId;
    expect(of(h.out, "meta")).toEqual([]);
    expect(of(h.out, "sources")).toEqual([
      { type: "sources", turnId, sources: [{ ref: "role:magenta", title: "Magenta Connect · Full Stack Developer" }] },
    ]);
    expect(records(h.out)[0]).toMatchObject({ dataLine: "invalid", coverage: null });
  });

  it("keeps the gate's drops and no grounding when the turn is interrupted before it finishes", async () => {
    const h = setup({ tokenMs: 50, reply: `Write to yash@example.com any time. ${S0} ${S1} ${S2}\n${META}` });
    await h.loop.start();
    await ask(h, QUESTION);
    await until(() => kinds(h.out).includes("sentence:0"));
    const turnId = of(h.out, "turn.start")[0]?.turnId ?? "";
    h.loop.onMessage({ type: "interrupt", turnId, lastHeardSentenceId: 0 });
    await vi.runAllTimersAsync();
    expect(records(h.out)[0]).toMatchObject({ interrupted: true, grounding: null, gate: { dropped: 1, reasons: ["url", "email"] } });
  });

  it("spends one of the day's turns before each answer", async () => {
    let spent = 0;
    const h = setup({ spendTurn: async () => (spent++, true) });
    await h.loop.start();
    await ask(h, QUESTION);
    await vi.runAllTimersAsync();
    await ask(h, "And before that?", 1);
    await vi.runAllTimersAsync();
    expect(spent).toBe(2);
    expect(records(h.out)).toHaveLength(2);
  });

  it("when the day's turns are spent: a resting error, no LLM call, and the conversation ends", async () => {
    const h = setup({ spendTurn: async () => false });
    await h.loop.start();
    await ask(h, QUESTION);
    await vi.runAllTimersAsync();
    expect(h.signals).toEqual([]); // the LLM was never called
    expect(of(h.out, "error")).toEqual([{ type: "error", code: "resting", message: expect.any(String) }]);
    expect(of(h.out, "turn.end")).toEqual([]);
    expect(of(h.out, "sentence")).toEqual([]);
    expect(h.closes).toEqual([{ code: 1008, reason: "resting" }]);
    expect(h.stt.closed).toBe(true);
    expect(h.ttsCalls).toContain("cancel");
  });

  it("treats a failing spend as spent (fails closed)", async () => {
    const h = setup({ spendTurn: async () => Promise.reject(new Error("ledger down")) });
    await h.loop.start();
    await ask(h, QUESTION);
    await vi.runAllTimersAsync();
    expect(h.signals).toEqual([]);
    expect(of(h.out, "error").map((e) => e.code)).toEqual(["resting"]);
    expect(h.closes).toEqual([{ code: 1008, reason: "resting" }]);
  });
});

describe("VoiceLoop idle close", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("closes a socket that has had no audio for the idle limit, and says why", async () => {
    const h = setup({ idleCloseMs: 120_000 });
    await h.loop.start();
    await vi.advanceTimersByTimeAsync(119_000);
    expect(h.closes).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.closes).toEqual([{ code: 1000, reason: "idle" }]);
    expect(h.logs.some((l) => l.includes("without audio"))).toBe(true);
  });

  it("stays open while mic frames keep arriving", async () => {
    const h = setup({ idleCloseMs: 120_000 });
    await h.loop.start();
    for (let s = 0; s < 300; s += 10) {
      h.loop.onAudio(new ArrayBuffer(2560));
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(h.closes).toEqual([]);
  });

  it("never closes when no idle limit is set", async () => {
    const h = setup();
    await h.loop.start();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(h.closes).toEqual([]);
  });
});
