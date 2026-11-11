import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAudioFrame, VOICE_FORMAT } from "../protocol/audio";
import type { SessionResponse } from "../protocol/chat";
import { PROTOCOL_VERSION, WS_SUBPROTOCOL } from "../protocol/version";
import { FakeAudioContext, FakeWebSocket } from "./testing";
import { VoiceSession, type VoiceSessionEvent } from "./voice-session";

vi.mock("./mic", () => ({ startMic: vi.fn(async () => ({ stop: vi.fn(), setMuted: vi.fn() })) }));

const BASE = "https://yashos.dev/assistant";
const SESSION: SessionResponse = { token: "c1.s1", protocol: PROTOCOL_VERSION, mode: "voice", expiresAt: 9e12, resting: false };
const READY = { type: "ready", protocol: PROTOCOL_VERSION, mode: "voice", audio: VOICE_FORMAT };

let sockets: FakeWebSocket[];

function makeSession() {
  const session = new VoiceSession({
    createWebSocket: (url, protocols) => {
      const ws = new FakeWebSocket(url, protocols);
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
  });
  const events: VoiceSessionEvent[] = [];
  for (const type of [
    "connection", "ready", "state", "transcript", "turn.start", "sentence", "turn.end", "error", "mark", "mic",
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
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

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

  it("reports an unexpected close with its code and reason", async () => {
    const { session, events } = makeSession();
    const ws = await connected(session);
    ws.serverClose(1006, "gone");
    expect(events.at(-1)).toEqual({ type: "connection", status: "closed", detail: "socket closed (code 1006: gone)" });
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
    await expect(session.talk()).rejects.toThrow("not connected");
  });

  it("turns the mic live, and reports it", async () => {
    const { session, events } = makeSession();
    await connected(session);
    await session.talk();
    expect(events).toContainEqual({ type: "mic", state: "live" });
  });
});
