import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeLlm } from "../adapters/fake-llm";
import { createFakeStt } from "../adapters/fake-stt";
import { createFakeTts } from "../adapters/fake-tts";
import type { Bundle } from "../knowledge/types";
import type { LlmRequest } from "../ports/llm";
import type { ServerEvent } from "../protocol/events";
import { ConversationState, type StateStorage } from "./conversation-state";
import { VoiceLoop } from "./voice-loop";

const FRAME = 2560; // 80 ms of 16 kHz s16le mono

const bundle: Bundle = {
  version: "0123456789ab",
  hash: "0123456789ab".padEnd(64, "0"),
  text: "## role:magenta — Magenta Connect · Full Stack Developer · Aug 2025 - now\nYash builds AI agents for field teams.\n",
  refs: ["doc:profile", "doc:resume", "role:magenta"],
  titles: { "role:magenta": "Magenta Connect · Full Stack Developer" },
  keyterms: ["Yash", "Magenta Connect"],
  tokenEstimate: 30,
};
const REPLY = 'Yash works at Magenta Connect.\n<meta>{"refs":["role:magenta"],"coverage":"direct"}</meta>';
const PROSE = "Yash works at Magenta Connect.";

/** Durable Object storage as far as the state uses it; values are cloned like real storage. */
function memoryStorage(): StateStorage & { data: Map<string, unknown>; puts: string[] } {
  const data = new Map<string, unknown>();
  const puts: string[] = [];
  return {
    data,
    puts,
    async get<T>(key: string) {
      return data.has(key) ? (structuredClone(data.get(key)) as T) : undefined;
    },
    async put<T>(key: string, value: T) {
      puts.push(key);
      data.set(key, structuredClone(value));
    },
  };
}

function stateOn(storage: StateStorage, o: { maxTurns?: number; maxAudioSeconds?: number } = {}) {
  return new ConversationState({ storage, now: () => Date.now(), ...o });
}

/** One socket: a VoiceLoop on the shared state, with fakes, recording what it sends. */
function socket(state: ConversationState, requests: LlmRequest[] = []) {
  const out: ServerEvent[] = [];
  const stt = createFakeStt();
  const loop = new VoiceLoop({
    conversationId: "conv-1",
    stt,
    llm: createFakeLlm({
      reply: (req) => {
        requests.push(req);
        return REPLY;
      },
    }),
    tts: createFakeTts(),
    bundle,
    state,
    send: (e) => {
      if (!(e instanceof ArrayBuffer)) out.push(structuredClone(e));
    },
    now: () => Date.now(),
  });
  return { out, stt, loop };
}

async function ask(s: ReturnType<typeof socket>, question: string, turnIndex = 0): Promise<void> {
  s.stt.emit({ type: "end", transcript: question, turnIndex });
  await vi.runAllTimersAsync();
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ConversationState", () => {
  it("allows maxTurns turns (30 by default), then refuses", () => {
    const state = stateOn(memoryStorage());
    const results = Array.from({ length: 31 }, () => state.startTurn());
    expect(results.filter(Boolean)).toHaveLength(30);
    expect(results.at(-1)).toBe(false);
    expect(state.turnsStarted).toBe(30);
  });

  it("keeps the history as exchanges and lets an answer be trimmed", () => {
    const state = stateOn(memoryStorage());
    const index = state.addExchange("Where does Yash work?", "Yash works at Magenta Connect. Want more?");
    state.replaceAnswer(index, "Yash works at Magenta Connect.");
    expect(state.history).toEqual([
      { role: "user", text: "Where does Yash work?" },
      { role: "assistant", text: "Yash works at Magenta Connect." },
    ]);
  });

  it("saves turns and history as they change, so load() after a restart continues them", async () => {
    const storage = memoryStorage();
    const state = stateOn(storage);
    state.startTurn();
    state.addExchange("Q1", "A1");
    state.startTurn();
    const index = state.addExchange("Q2", "A2 long");
    state.replaceAnswer(index, "A2");

    const restarted = await ConversationState.load({ storage, now: () => Date.now() });
    expect(restarted.turnsStarted).toBe(2);
    expect(restarted.history).toEqual(state.history);
  });

  it("saves the meter every 5 s of audio, at once when it hits the limit, and on flush()", async () => {
    const storage = memoryStorage();
    const state = stateOn(storage, { maxAudioSeconds: 7 });
    const meterPuts = () => storage.puts.filter((k) => k === "meter").length;
    for (let i = 0; i < 62; i++) {
      expect(state.addAudio(FRAME)).toBe("ok"); // 4.96 s
      await vi.advanceTimersByTimeAsync(80);
    }
    expect(meterPuts()).toBe(0);
    state.addAudio(FRAME); // 5.04 s
    expect(meterPuts()).toBe(1);
    state.addAudio(FRAME);
    state.flush();
    expect(meterPuts()).toBe(2);
    expect((await ConversationState.load({ storage, now: () => Date.now() })).audioSeconds).toBeCloseTo(5.12, 6);

    for (let i = 0; i < 30 && state.addAudio(FRAME) === "ok"; i++) await vi.advanceTimersByTimeAsync(80);
    expect(state.addAudio(FRAME)).toBe("limit");
    const restarted = await ConversationState.load({ storage, now: () => Date.now(), maxAudioSeconds: 7 });
    expect(restarted.addAudio(2)).toBe("limit"); // the limit was saved the moment it was hit
  });

  it("logs a failed save as an error instead of throwing", async () => {
    const lines: string[] = [];
    const storage: StateStorage = {
      get: async () => undefined,
      put: async () => {
        throw new Error("storage full");
      },
    };
    const state = new ConversationState({ storage, now: () => Date.now(), log: (level, line) => void lines.push(`${level}: ${line}`) });
    state.startTurn();
    await vi.advanceTimersByTimeAsync(0);
    expect(lines).toEqual([expect.stringMatching(/^error: .*turnsStarted.*storage full/)]);
  });
});

describe("ConversationState shared by every socket of a conversation", () => {
  it("refuses the 31st turn even when the turns are spread over two sockets", async () => {
    const state = stateOn(memoryStorage());
    const first = socket(state);
    await first.loop.start();
    for (let i = 0; i < 20; i++) await ask(first, `Question ${i}?`, i);
    first.loop.close(); // the visitor reconnects

    const second = socket(state);
    await second.loop.start();
    for (let i = 20; i < 31; i++) await ask(second, `Question ${i}?`, i - 20);

    const started = (s: ReturnType<typeof socket>) => s.out.filter((e) => e.type === "turn.start").length;
    expect([started(first), started(second)]).toEqual([20, 10]);
    expect(second.out.filter((e) => e.type === "error")).toEqual([
      { type: "error", code: "limit", message: expect.any(String) },
    ]);
  });

  it("keeps the audio meter across a reconnect: the total and the limit carry over", async () => {
    const state = stateOn(memoryStorage(), { maxAudioSeconds: 2 });
    const first = socket(state);
    await first.loop.start();
    for (let i = 0; i < 20; i++) {
      first.loop.onAudio(new ArrayBuffer(FRAME)); // 1.6 s
      await vi.advanceTimersByTimeAsync(80);
    }
    first.loop.close();

    const second = socket(state);
    await second.loop.start();
    expect(state.audioSeconds).toBeCloseTo(1.6, 6);
    for (let i = 0; i < 10; i++) {
      second.loop.onAudio(new ArrayBuffer(FRAME));
      await vi.advanceTimersByTimeAsync(80);
    }
    expect(second.stt.frames).toHaveLength(5); // 1.6 s + 5 × 80 ms = 2 s; the 6th would cross it
    expect(second.out.filter((e) => e.type === "error").map((e) => e.type === "error" && e.code)).toEqual(["limit"]);
  });

  it("continues the history on the next socket", async () => {
    const state = stateOn(memoryStorage());
    const requests: LlmRequest[] = [];
    const first = socket(state, requests);
    await first.loop.start();
    await ask(first, "Where does Yash work?");
    first.loop.close();

    const second = socket(state, requests);
    await second.loop.start();
    await ask(second, "And before that?");

    expect(requests[1]?.turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    expect(requests[1]?.turns[0]?.text).toContain("Where does Yash work?");
    expect(requests[1]?.turns[1]?.text).toBe(PROSE);
    expect(state.history.map((t) => t.text)).toEqual(["Where does Yash work?", PROSE, "And before that?", PROSE]);
  });

  it("records only the new socket's audio in its first turn", async () => {
    const state = stateOn(memoryStorage());
    const first = socket(state);
    await first.loop.start();
    for (let i = 0; i < 25; i++) {
      first.loop.onAudio(new ArrayBuffer(FRAME)); // 2 s on the first socket, never answered
      await vi.advanceTimersByTimeAsync(80);
    }
    first.loop.close();

    const second = socket(state);
    await second.loop.start();
    for (let i = 0; i < 12; i++) {
      second.loop.onAudio(new ArrayBuffer(FRAME)); // 0.96 s
      await vi.advanceTimersByTimeAsync(80);
    }
    await ask(second, "Where does Yash work?");
    const record = second.out.find((e) => e.type === "turn.end");
    expect(record?.type === "turn.end" && record.record.audioInSeconds).toBeCloseTo(0.96, 6);
  });
});
