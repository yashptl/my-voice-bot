import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAudioFrame, VOICE_FORMAT } from "../protocol/audio";
import type { SessionResponse } from "../protocol/chat";
import { PROTOCOL_VERSION, WS_SUBPROTOCOL } from "../protocol/version";
import { FakeAudioContext, FakeWebSocket } from "./testing";
import { startMic, type Mic } from "./mic";
import { VoiceSession, type VoiceSessionEvent } from "./voice-session";

vi.mock("./mic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mic")>()),
  startMic: vi.fn(async () => ({ stop: vi.fn(), setMuted: vi.fn(), readLevels: vi.fn((out: Float32Array) => out.fill(0.5)) })),
}));

const BASE = "https://yashos.dev/assistant";
const SESSION: SessionResponse = { token: "c1.s1", protocol: PROTOCOL_VERSION, mode: "voice", expiresAt: 9e12, resting: null };
const READY = { type: "ready", protocol: PROTOCOL_VERSION, mode: "voice", audio: VOICE_FORMAT };

const WORKLET_URL = "/assets/capture-worklet.js";

let sockets: FakeWebSocket[];
let contexts: FakeAudioContext[];

function makeSession() {
  const session = new VoiceSession({
    workletUrl: WORKLET_URL,
    createWebSocket: (url, protocols) => {
      const ws = new FakeWebSocket(url, protocols);
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
  });
  const events: VoiceSessionEvent[] = [];
  for (const type of [
    "connection", "ready", "state", "transcript", "turn.start", "sentence", "turn.end", "error", "mark", "mic",
    "playing", "interrupt", "followUp",
  ] as const) {
    session.on(type, (e) => events.push(e));
  }
  return { session, events };
}

async function connected(session: VoiceSession, response: SessionResponse = SESSION) {
  await session.connect(async () => response, BASE);
  const ws = sockets.at(-1)!;
  ws.open();
  return ws;
}

beforeEach(() => {
  sockets = [];
  contexts = [];
  vi.stubGlobal(
    "AudioContext",
    class extends FakeAudioContext {
      constructor() {
        super();
        contexts.push(this);
      }
    },
  );
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The mic the last talk() started (the mocked startMic's result). */
async function lastMic(): Promise<Mic> {
  return (await vi.mocked(startMic).mock.results.at(-1)!.value) as Mic;
}

/** One 10 ms audio chunk for `sentenceId`. */
const audio = (sentenceId: number) => encodeAudioFrame(sentenceId, new Uint8Array(480));

describe("VoiceSession.connect", () => {
  it("opens the voice socket with the subprotocol and token, and reports connecting then open", async () => {
    const { session, events } = makeSession();
    const ws = await connected(session);
    expect(ws.url).toBe("wss://yashos.dev/assistant/voice");
    expect(ws.protocols).toEqual([WS_SUBPROTOCOL, "c1.s1"]);
    expect(events.filter((e) => e.type === "connection")).toEqual([
      { type: "connection", status: "connecting" },
      { type: "connection", status: "open", mode: "voice" },
    ]);
  });

  it("rejects, without a socket, when the session is not in voice mode", async () => {
    const { session, events } = makeSession();
    await expect(session.connect(async () => ({ ...SESSION, mode: "text" }), BASE)).rejects.toThrow(/voice is not enabled/);
    expect(sockets).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "connection", status: "closed", detail: expect.stringContaining("mode: text") });
  });

  it("reports an unexpected close with its code and reason, as fields too", async () => {
    const { session, events } = makeSession();
    const ws = await connected(session);
    ws.serverClose(1006, "gone");
    expect(events.at(-1)).toEqual({ type: "connection", status: "closed", detail: "socket closed (code 1006: gone)", code: 1006, reason: "gone" });
  });

  it("closes its audio context on close(), and keeps it across connect() calls", async () => {
    const { session } = makeSession();
    await connected(session);
    await connected(session);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.closed).toBe(false);
    session.close();
    expect(contexts[0]?.closed).toBe(true);
    await connected(session);
    expect(contexts).toHaveLength(2);
  });

  it("closes the socket on close() and reports closed once", async () => {
    const { session, events } = makeSession();
    const ws = await connected(session);
    session.close();
    session.close();
    expect(ws.closedWith).toEqual({ code: 1000, reason: "client closed" });
    expect(events.filter((e) => e.type === "connection" && e.status === "closed")).toHaveLength(1);
  });

  it("drops a connect that close() overtook", async () => {
    const { session } = makeSession();
    const pending = session.connect(async () => SESSION, BASE);
    session.close();
    await pending;
    expect(sockets).toHaveLength(0);
  });
});

describe("VoiceSession events", () => {
  it("hands server events to listeners, skipping malformed messages", async () => {
    const { session, events } = makeSession();
    const ws = await connected(session);
    ws.receive(READY);
    ws.receive("not json");
    ws.receive({ no: "type" });
    ws.receive({ type: "state", state: "thinking" });
    ws.receive({ type: "transcript", turnIndex: 0, text: "hi", final: false });
    ws.receive({ type: "sentence", turnId: "t1", id: 0, text: "Hello.", spoken: false });
    ws.receive({ type: "error", code: "voice_resting", message: "resting" });
    expect(events.map((e) => e.type).filter((t) => t !== "connection")).toEqual([
      "ready",
      "state",
      "transcript",
      "sentence",
      "error",
    ]);
    expect(events.find((e) => e.type === "sentence")).toMatchObject({ spoken: false });
  });

  it("closes on a protocol mismatch", async () => {
    const { session, events } = makeSession();
    const ws = await connected(session);
    ws.receive({ ...READY, protocol: PROTOCOL_VERSION + 1 });
    expect(ws.closedWith?.code).toBe(1000);
    expect(events.at(-1)).toMatchObject({ type: "connection", status: "closed", detail: expect.stringContaining("protocol") });
  });

  it("sends clientTurnEnd on turn.start after a final transcript, and reports the mark", async () => {
    const { session, events } = makeSession();
    const ws = await connected(session);
    ws.receive(READY);
    ws.receive({ type: "transcript", turnIndex: 0, text: "hello", final: true });
    ws.receive({ type: "turn.start", turnId: "t1", question: "hello" });
    expect(ws.sentJson).toEqual([expect.objectContaining({ type: "mark", turnId: "t1", mark: "clientTurnEnd" })]);
    expect(events.some((e) => e.type === "mark" && e.mark === "clientTurnEnd")).toBe(true);
  });

  it("does not send a turn-end mark for an empty transcript", async () => {
    const { session } = makeSession();
    const ws = await connected(session);
    ws.receive(READY);
    ws.receive({ type: "transcript", turnIndex: 0, text: "  ", final: true });
    ws.receive({ type: "turn.start", turnId: "t1", question: "" });
    expect(ws.sentJson).toEqual([]);
  });

  it("accepts audio frames after ready and ignores them before", async () => {
    const { session } = makeSession();
    const ws = await connected(session);
    const frame = encodeAudioFrame(0, new Uint8Array(480));
    expect(() => ws.receive(frame)).not.toThrow(); // no player yet
    ws.receive(READY);
    expect(() => ws.receive(frame)).not.toThrow();
  });
});

describe("VoiceSession.interrupt", () => {
  it("tells the server which turn to stop while it is replying", async () => {
    const { session } = makeSession();
    const ws = await connected(session);
    ws.receive(READY);
    ws.receive({ type: "turn.start", turnId: "t1", question: "q" });
    ws.receive({ type: "state", state: "speaking" });
    session.interrupt();
    expect(ws.sentJson).toEqual([{ type: "interrupt", turnId: "t1", lastHeardSentenceId: null }]);
  });

  it("sends nothing when no reply is in progress", async () => {
    const { session } = makeSession();
    const ws = await connected(session);
    ws.receive(READY);
    session.interrupt();
    expect(ws.sentJson).toEqual([]);
  });
});

describe("VoiceSession.talk", () => {
  it("refuses before the socket is open", async () => {
    const { session } = makeSession();
    expect(session.open).toBe(false);
    await expect(session.talk()).rejects.toThrow("not connected");
  });

  it("says whether the socket is open", async () => {
    const { session } = makeSession();
    const ws = await connected(session);
    expect(session.open).toBe(true);
    ws.readyState = FakeWebSocket.CLOSING; // the server's close is in flight
    expect(session.open).toBe(false);
  });

  it("turns the mic live, and reports it", async () => {
    const { session, events } = makeSession();
    await connected(session);
    await session.talk();
    expect(events).toContainEqual({ type: "mic", state: "live" });
  });

  it("hands the worklet URL to the mic", async () => {
    const { session } = makeSession();
    await connected(session);
    await session.talk();
    expect(vi.mocked(startMic)).toHaveBeenCalledWith(expect.objectContaining({ workletUrl: WORKLET_URL }));
  });

  it("refuses without a worklet URL, before the mic is asked for", async () => {
    vi.mocked(startMic).mockClear();
    const session = new VoiceSession({
      createWebSocket: (url, protocols) => {
        const ws = new FakeWebSocket(url, protocols);
        sockets.push(ws);
        return ws as unknown as WebSocket;
      },
    });
    await connected(session);
    await expect(session.talk()).rejects.toThrow("workletUrl is required for voice");
    expect(startMic).not.toHaveBeenCalled();
  });
});

describe("VoiceSession playing", () => {
  async function replying() {
    vi.useFakeTimers();
    const { session, events } = makeSession();
    const ws = await connected(session);
    ws.receive(READY);
    ws.receive({ type: "turn.start", turnId: "t1", question: "q" });
    ws.receive({ type: "state", state: "speaking" });
    ws.receive(audio(0));
    const playing = () => events.filter((e) => e.type === "playing");
    return { session, events, ws, playing };
  }

  it("reports the sentence, with its turn, when its audio starts", async () => {
    const { ws, playing } = await replying();
    ws.receive(audio(1)); // queued right after sentence 0's 10 ms chunk
    expect(playing()).toEqual([]);
    vi.advanceTimersByTime(80);
    expect(playing()).toEqual([{ type: "playing", playing: { turnId: "t1", sentenceId: 0 } }]);
    vi.advanceTimersByTime(10);
    expect(playing().at(-1)).toEqual({ type: "playing", playing: { turnId: "t1", sentenceId: 1 } });
  });

  it("clears it when the speaker drains", async () => {
    const { playing } = await replying();
    vi.advanceTimersByTime(80);
    contexts[0]!.sources[0]!.end();
    expect(playing().at(-1)).toEqual({ type: "playing", playing: null });
  });

  it("clears it on interrupt, stop and close, once", async () => {
    for (const end of ["interrupt", "stop", "close"] as const) {
      const { session, playing } = await replying();
      vi.advanceTimersByTime(80);
      session[end]();
      session.interrupt();
      expect(playing().map((e) => e.playing)).toEqual([{ turnId: "t1", sentenceId: 0 }, null]);
    }
  });

  it("clears it on the next turn.start", async () => {
    const { ws, playing } = await replying();
    vi.advanceTimersByTime(80);
    ws.receive({ type: "turn.start", turnId: "t2", question: "q2" });
    expect(playing().at(-1)).toEqual({ type: "playing", playing: null });
  });

  it("reports nothing when nothing was playing", async () => {
    const { session, playing } = await replying();
    session.interrupt(); // before the first chunk started
    expect(playing()).toEqual([]);
  });
});

describe("VoiceSession interrupt event", () => {
  it("reports each interrupt it sends, with the last sentence that started", async () => {
    vi.useFakeTimers();
    const { session, events } = makeSession();
    const ws = await connected(session);
    ws.receive(READY);
    ws.receive({ type: "turn.start", turnId: "t1", question: "q" });
    ws.receive({ type: "state", state: "speaking" });
    ws.receive(audio(0));
    ws.receive(audio(1));
    vi.advanceTimersByTime(85);
    session.interrupt();
    expect(events.filter((e) => e.type === "interrupt")).toEqual([{ type: "interrupt", turnId: "t1", lastHeardSentenceId: 0 }]);
    expect(ws.sentJson).toContainEqual({ type: "interrupt", turnId: "t1", lastHeardSentenceId: 0 });
  });

  it("reports the interrupt inside talk(), even after the turn ended while its audio played", async () => {
    vi.useFakeTimers();
    const { session, events } = makeSession();
    const ws = await connected(session);
    ws.receive(READY);
    ws.receive({ type: "turn.start", turnId: "t1", question: "q" });
    ws.receive(audio(0));
    ws.receive({ type: "state", state: "listening" });
    vi.advanceTimersByTime(80);
    await session.talk();
    expect(events.filter((e) => e.type === "interrupt")).toEqual([{ type: "interrupt", turnId: "t1", lastHeardSentenceId: 0 }]);
  });

  it("talk() while the server is thinking interrupts that reply, so its audio cannot mute the mic", async () => {
    const { session, events } = makeSession();
    const ws = await connected(session);
    ws.receive(READY);
    ws.receive({ type: "turn.start", turnId: "t1", question: "q" });
    ws.receive({ type: "state", state: "thinking" });
    await session.talk();
    expect(ws.sentJson).toContainEqual({ type: "interrupt", turnId: "t1", lastHeardSentenceId: null });
    expect(events.filter((e) => e.type === "interrupt")).toEqual([{ type: "interrupt", turnId: "t1", lastHeardSentenceId: null }]);
    ws.receive(audio(0)); // already in flight for the interrupted turn
    expect(events.filter((e) => e.type === "mic").at(-1)).toEqual({ type: "mic", state: "live" });
  });

  it("reports nothing when there was nothing to interrupt", async () => {
    const { session, events } = makeSession();
    const ws = await connected(session);
    ws.receive(READY);
    session.interrupt();
    await session.talk();
    expect(events.filter((e) => e.type === "interrupt")).toEqual([]);
  });
});

describe("VoiceSession follow-up and pause", () => {
  it("reports the listening window opening, and closing when speech is heard", async () => {
    vi.useFakeTimers();
    const { session, events } = makeSession();
    const ws = await connected(session);
    ws.receive(READY);
    await session.talk();
    ws.receive({ type: "state", state: "thinking" });
    ws.receive({ type: "state", state: "listening" });
    vi.advanceTimersByTime(150);
    expect(events.filter((e) => e.type === "followUp")).toEqual([{ type: "followUp", open: true }]);
    ws.receive({ type: "transcript", turnIndex: 1, text: "and", final: false });
    expect(events.filter((e) => e.type === "followUp")).toEqual([
      { type: "followUp", open: true },
      { type: "followUp", open: false },
    ]);
  });

  it("pauseTalking mutes the mic until the turn starts, then turns it off", async () => {
    const { session, events } = makeSession();
    const ws = await connected(session);
    ws.receive(READY);
    await session.talk();
    const mic = await lastMic();
    session.pauseTalking();
    expect(mic.setMuted).toHaveBeenLastCalledWith(true);
    expect(events.filter((e) => e.type === "mic").at(-1)).toEqual({ type: "mic", state: "muted" });
    ws.receive({ type: "turn.start", turnId: "t1", question: "q" });
    expect(events.filter((e) => e.type === "mic").at(-1)).toEqual({ type: "mic", state: "off" });
    expect(mic.stop).toHaveBeenCalled();
  });
});

describe("VoiceSession.readLevels", () => {
  it("reads zeros and null before voice is on", () => {
    const { session } = makeSession();
    const out = new Float32Array(5).fill(1);
    expect(session.readLevels(out)).toBeNull();
    expect([...out]).toEqual([0, 0, 0, 0, 0]);
  });

  it("reads the mic while it is live, and nothing while it is muted", async () => {
    const { session } = makeSession();
    const ws = await connected(session);
    ws.receive(READY);
    await session.talk();
    const out = new Float32Array(5);
    expect(session.readLevels(out)).toBe("mic");
    expect([...out]).toEqual([0.5, 0.5, 0.5, 0.5, 0.5]);
    session.pauseTalking();
    expect(session.readLevels(out)).toBeNull();
    expect([...out]).toEqual([0, 0, 0, 0, 0]);
  });

  it("reads the voice while reply audio plays", async () => {
    const { session } = makeSession();
    const ws = await connected(session);
    ws.receive(READY);
    await session.talk();
    ws.receive({ type: "turn.start", turnId: "t1", question: "q" });
    ws.receive(audio(0));
    const analyser = contexts[0]!.analysers[0]!;
    analyser.bins = new Uint8Array(analyser.frequencyBinCount).fill(255);
    const out = new Float32Array(5);
    expect(session.readLevels(out)).toBe("voice");
    expect([...out]).toEqual([1, 1, 1, 1, 1]);
    contexts[0]!.sources[0]!.end();
    expect(session.readLevels(out)).toBeNull();
  });
});

describe("VoiceSession.setSpeakerMuted", () => {
  it("applies to the player, including a mute set before the player exists", async () => {
    const { session } = makeSession();
    session.setSpeakerMuted(true);
    const ws = await connected(session);
    ws.receive(READY);
    expect(contexts[0]!.gains[0]!.gain.value).toBe(0);
    session.setSpeakerMuted(false);
    expect(contexts[0]!.gains[0]!.gain.value).toBe(1);
    session.setSpeakerMuted(true);
    ws.receive(READY); // a new player keeps the setting
    expect(contexts[0]!.gains[1]!.gain.value).toBe(0);
  });
});
