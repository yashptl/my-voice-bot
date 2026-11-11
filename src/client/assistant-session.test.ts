import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionResponse } from "../protocol/chat";
import type { ServerEvent } from "../protocol/events";
import { encodeSse } from "../protocol/sse";
import type { TurnRecord } from "../protocol/turn-record";
import { VOICE_FORMAT } from "../protocol/audio";
import { PROTOCOL_VERSION } from "../protocol/version";
import { AssistantSession, type AssistantSnapshot } from "./assistant-session";
import { DISCLOSURE } from "./disclosure";
import { startMic } from "./mic";
import { FakeAudioContext, FakeWebSocket } from "./testing";

vi.mock("./mic", () => ({ startMic: vi.fn(async () => ({ stop: vi.fn(), setMuted: vi.fn() })) }));

const BASE = "https://yashos.dev/assistant";
const RECORD = { turnId: "t1", interrupted: false, error: null, coverage: "direct" } as unknown as TurnRecord;

const SENTENCES: ServerEvent[] = [
  { type: "turn.start", turnId: "t1", question: "Where does Yash work now?" },
  { type: "sentence", turnId: "t1", id: 0, text: "Yash works at Magenta Connect — in Ahmedabad." },
  { type: "sentence", turnId: "t1", id: 1, text: "Joined in Aug 2025." },
  {
    type: "meta",
    turnId: "t1",
    data: { refs: ["role:magenta"], show: "role:magenta", contact: true, coverage: "adjacent" },
    sources: [{ ref: "role:magenta", title: "Magenta Connect" }],
  },
  { type: "turn.end", turnId: "t1", record: RECORD },
];

/** The stream cut into pieces of 1 to 7 bytes, so cuts land inside lines and multi-byte characters. */
function oddChunks(events: ServerEvent[]): Uint8Array[] {
  const bytes = new TextEncoder().encode(events.map(encodeSse).join(""));
  const chunks: Uint8Array[] = [];
  for (let at = 0, size = 1; at < bytes.length; at += size, size = (size % 7) + 1) chunks.push(bytes.slice(at, at + size));
  return chunks;
}

function stream(events: ServerEvent[], o: { hang?: boolean } = {}) {
  const state = { cancelled: false };
  const chunks = oddChunks(events);
  let next = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[next++];
        if (chunk) controller.enqueue(chunk);
        else if (o.hang) return new Promise<void>(() => {});
        else controller.close();
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const response = () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  return { response, state };
}

const refusal = (status: number, error: string) => () => Response.json({ error }, { status });

let t: number;
let tokens: number;
let sessionTemplate: Partial<SessionResponse>;
let chats: (() => Response)[];
let chatCalls: { token: string; message: string }[];
let sessionCalls: number;
let sockets: FakeWebSocket[];

const fakeFetch = vi.fn<typeof fetch>(async (input, init) => {
  const url = String(input);
  if (url.endsWith("/session")) {
    sessionCalls++;
    return Response.json({
      token: `c1.s${++tokens}`,
      protocol: PROTOCOL_VERSION,
      mode: "text",
      expiresAt: t + 600_000,
      resting: false,
      ...sessionTemplate,
    });
  }
  const headers = new Headers(init?.headers);
  chatCalls.push({ token: headers.get("authorization")!.slice(7), message: JSON.parse(String(init?.body)).message });
  const next = chats.shift();
  if (!next) throw new Error("no chat response queued");
  return next();
});

function make() {
  return new AssistantSession({
    baseUrl: BASE,
    turnstileToken: async () => "XXXX.DUMMY.TOKEN.XXXX",
    fetch: fakeFetch,
    now: () => t,
    createWebSocket: (url, protocols) => {
      const ws = new FakeWebSocket(url, protocols);
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
  });
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(cond()).toBe(true);
};

beforeEach(() => {
  t = 1_000_000;
  tokens = 0;
  sessionTemplate = {};
  chats = [];
  chatCalls = [];
  sessionCalls = 0;
  sockets = [];
  fakeFetch.mockClear();
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe("DISCLOSURE", () => {
  it("is the agreed text", () => {
    expect(DISCLOSURE).toBe(
      "You're talking to an AI assistant, not Yash. Your messages go to MiniMax, which writes the answers and the voice and may use them to improve its services, and to Cloudflare, which runs the assistant and turns speech into text without keeping it. Conversations are deleted after 30 days, and Yash may read the questions the assistant couldn't fully answer. Please don't share personal details here.",
    );
  });
});

describe("start", () => {
  it("starts idle, then mints the session and is ready", async () => {
    const s = make();
    expect(s.snapshot).toMatchObject({ status: "idle", mode: "off", busy: false, limitReached: false, notice: null, messages: [] });
    const starting = s.start();
    expect(s.snapshot.status).toBe("starting");
    await starting;
    expect(s.snapshot).toMatchObject({ status: "ready", mode: "text" });
  });

  it("mints once however often it is called", async () => {
    const s = make();
    await Promise.all([s.start(), s.start()]);
    await s.start();
    expect(sessionCalls).toBe(1);
  });

  it("reports off and resting", async () => {
    sessionTemplate = { mode: "off" };
    const off = make();
    await off.start();
    expect(off.snapshot).toMatchObject({ status: "off", mode: "off" });

    sessionTemplate = { resting: true };
    const resting = make();
    await resting.start();
    expect(resting.snapshot.status).toBe("resting");
  });

  it("reports an error with a notice when the session cannot be minted, and can be retried", async () => {
    const s = new AssistantSession({
      baseUrl: BASE,
      turnstileToken: async () => {
        throw new Error("widget failed");
      },
      fetch: fakeFetch,
    });
    await s.start();
    expect(s.snapshot.status).toBe("error");
    expect(s.snapshot.notice).toContain("widget failed");
  });

  it("does not ask when the assistant is off or resting", async () => {
    sessionTemplate = { resting: true };
    const s = make();
    await s.start();
    await s.ask("hello");
    expect(s.snapshot.messages).toEqual([]);
    expect(chatCalls).toEqual([]);
  });
});

describe("ask", () => {
  it("streams one answer into a visitor message and an assistant message", async () => {
    chats.push(stream(SENTENCES).response);
    const s = make();
    const seen: AssistantSnapshot[] = [];
    s.subscribe(() => seen.push(s.snapshot));
    await s.ask("  Where does Yash work now?  ");

    expect(chatCalls).toEqual([{ token: "c1.s1", message: "Where does Yash work now?" }]);
    const [visitor, assistant] = s.snapshot.messages;
    expect(visitor).toMatchObject({ role: "visitor", text: "Where does Yash work now?", sentences: [], pending: false });
    expect(assistant).toMatchObject({
      role: "assistant",
      text: "Yash works at Magenta Connect — in Ahmedabad. Joined in Aug 2025.",
      sentences: [
        { id: 0, text: "Yash works at Magenta Connect — in Ahmedabad." },
        { id: 1, text: "Joined in Aug 2025." },
      ],
      pending: false,
      sources: [{ ref: "role:magenta", title: "Magenta Connect" }],
      contact: true,
      show: "role:magenta",
      coverage: "adjacent",
      record: RECORD,
      error: null,
      stopped: false,
    });
    expect(s.snapshot.busy).toBe(false);
    expect(s.snapshot.status).toBe("ready");

    // It streamed: pending with one sentence, then two, then done; busy throughout.
    const streaming = seen.filter((x) => x.busy);
    expect(streaming.some((x) => x.messages[1]?.pending && x.messages[1].sentences.length === 1)).toBe(true);
  });

  it("mints the session lazily on the first ask", async () => {
    chats.push(stream(SENTENCES).response);
    const s = make();
    await s.ask("hi");
    expect(sessionCalls).toBe(1);
    expect(s.snapshot.status).toBe("ready");
  });

  it("takes sources alone (a reply without a valid data line)", async () => {
    chats.push(
      stream([
        { type: "sentence", turnId: "t1", id: 0, text: "Hello." },
        { type: "sources", turnId: "t1", sources: [{ ref: "a:b", title: "A B" }] },
        { type: "turn.end", turnId: "t1", record: RECORD },
      ]).response,
    );
    const s = make();
    await s.ask("hi");
    expect(s.snapshot.messages[1]).toMatchObject({ sources: [{ ref: "a:b", title: "A B" }], contact: false, show: null, coverage: null });
  });

  it("puts a stream error event on the message and keeps what was shown", async () => {
    chats.push(
      stream([
        { type: "sentence", turnId: "t1", id: 0, text: "Partly." },
        { type: "error", code: "provider", message: "model failed" },
        { type: "turn.end", turnId: "t1", record: RECORD },
      ]).response,
    );
    const s = make();
    await s.ask("hi");
    expect(s.snapshot.messages[1]).toMatchObject({ text: "Partly.", error: "provider", pending: false });
    expect(s.snapshot.limitReached).toBe(false);
  });

  it("treats limit and resting error events like the HTTP codes", async () => {
    chats.push(stream([{ type: "error", code: "limit", message: "" }]).response);
    const a = make();
    await a.ask("hi");
    expect(a.snapshot.limitReached).toBe(true);

    chats.push(stream([{ type: "error", code: "resting", message: "" }]).response);
    const b = make();
    await b.ask("hi");
    expect(b.snapshot.status).toBe("resting");
  });

  it("marks a stream that ends early as cut off (unknown)", async () => {
    chats.push(stream([{ type: "sentence", turnId: "t1", id: 0, text: "Half an" }]).response);
    const s = make();
    await s.ask("hi");
    expect(s.snapshot.messages[1]).toMatchObject({ text: "Half an", pending: false, error: "unknown" });
  });

  it("marks a failed connection as unknown", async () => {
    chats.push(() => {
      throw new TypeError("network down");
    });
    const s = make();
    await s.ask("hi");
    expect(s.snapshot.messages[1]).toMatchObject({ pending: false, error: "unknown" });
    expect(s.snapshot.busy).toBe(false);
  });

  it.each([
    ["busy", 409],
    ["rate_limited", 429],
    ["bad_request", 400],
    ["something_else", 500],
  ] as const)("puts HTTP error %s on that message only", async (error, status) => {
    chats.push(refusal(status, error));
    const s = make();
    await s.start();
    await s.ask("hi");
    expect(s.snapshot.messages[1]).toMatchObject({ pending: false, error: error === "something_else" ? "unknown" : error });
    expect(s.snapshot).toMatchObject({ status: "ready", limitReached: false, busy: false });
  });

  it("sets limitReached on HTTP limit, and refuses further questions", async () => {
    chats.push(refusal(429, "limit"));
    const s = make();
    await s.ask("hi");
    expect(s.snapshot.limitReached).toBe(true);
    expect(s.snapshot.messages[1]?.error).toBe("limit");
    await s.ask("again");
    expect(chatCalls).toHaveLength(1);
  });

  it("sets status resting on HTTP resting", async () => {
    chats.push(refusal(503, "resting"));
    const s = make();
    await s.ask("hi");
    expect(s.snapshot.status).toBe("resting");
    expect(s.snapshot.messages[1]?.error).toBe("resting");
  });

  it("withdraws the question when the new session turns out to be resting", async () => {
    const s = make();
    await s.start();
    t += 590_000; // inside the renewal margin
    sessionTemplate = { resting: true };
    await s.ask("hi");
    expect(s.snapshot.status).toBe("resting");
    expect(s.snapshot.messages).toEqual([]);
    expect(chatCalls).toEqual([]);
  });

  it("does nothing when asked while an answer is streaming", async () => {
    const first = stream([SENTENCES[1]!], { hang: true });
    chats.push(first.response);
    const s = make();
    const running = s.ask("one");
    await until(() => s.snapshot.messages[1]?.sentences.length === 1);
    await s.ask("two"); // resolves at once, changes nothing
    expect(s.snapshot.messages).toHaveLength(2);
    expect(chatCalls).toHaveLength(1);
    s.stop();
    await running;
  });

  it("ignores an empty question", async () => {
    const s = make();
    await s.ask("   ");
    expect(s.snapshot.messages).toEqual([]);
    expect(sessionCalls).toBe(0);
  });
});

describe("stop", () => {
  it("aborts the stream, keeps what was shown and marks the message stopped", async () => {
    const hanging = stream([SENTENCES[1]!], { hang: true });
    chats.push(hanging.response);
    const s = make();
    const running = s.ask("hi");
    await until(() => s.snapshot.messages[1]?.sentences.length === 1);
    s.stop();
    await running;
    expect(s.snapshot.messages[1]).toMatchObject({
      text: "Yash works at Magenta Connect — in Ahmedabad.",
      pending: false,
      stopped: true,
      error: null,
    });
    expect(s.snapshot.busy).toBe(false);
    expect(hanging.state.cancelled).toBe(true);
    // And the conversation goes on.
    chats.push(stream(SENTENCES).response);
    await s.ask("again");
    expect(s.snapshot.messages).toHaveLength(4);
  });

  it("changes nothing when there is nothing to stop", async () => {
    const s = make();
    const before = s.snapshot;
    s.stop();
    expect(s.snapshot).toBe(before);
  });
});

describe("session renewal", () => {
  it("re-mints before an ask when under 60 s remain, and says so after an earlier answer", async () => {
    chats.push(stream(SENTENCES).response, stream(SENTENCES).response);
    const s = make();
    await s.ask("one");
    expect(s.snapshot.notice).toBeNull();
    t += 600_000 - 59_000;
    await s.ask("two");
    expect(sessionCalls).toBe(2);
    expect(chatCalls.map((c) => c.token)).toEqual(["c1.s1", "c1.s2"]);
    expect(s.snapshot.notice).toMatch(/renewed/);
    expect(s.snapshot.messages).toHaveLength(4); // the UI keeps its messages
  });

  it("does not re-mint with 60 s or more left, and says nothing when nothing was said before", async () => {
    chats.push(stream(SENTENCES).response, stream(SENTENCES).response);
    const s = make();
    await s.start();
    t += 600_000 - 61_000;
    await s.ask("one");
    expect(sessionCalls).toBe(1);

    t += 5_000;
    const fresh = make();
    await fresh.start();
    t += 600_000 - 30_000; // expiring, but no answer yet: a silent re-mint
    chats.push(stream(SENTENCES).response);
    await fresh.ask("two");
    expect(fresh.snapshot.notice).toBeNull();
  });

  it("clears the notice on the next ask", async () => {
    chats.push(stream(SENTENCES).response, stream(SENTENCES).response, stream(SENTENCES).response);
    const s = make();
    await s.ask("one");
    t += 590_000;
    await s.ask("two");
    expect(s.snapshot.notice).not.toBeNull();
    await s.ask("three");
    expect(s.snapshot.notice).toBeNull();
  });

  it("re-mints once on a 401 auth and retries the ask once", async () => {
    chats.push(refusal(401, "auth"), stream(SENTENCES).response);
    const s = make();
    await s.start();
    await s.ask("hi");
    expect(sessionCalls).toBe(2);
    expect(chatCalls).toEqual([
      { token: "c1.s1", message: "hi" },
      { token: "c1.s2", message: "hi" },
    ]);
    expect(s.snapshot.messages).toHaveLength(2);
    expect(s.snapshot.messages[1]).toMatchObject({ error: null, pending: false });
  });

  it("gives up after one retry", async () => {
    chats.push(refusal(401, "auth"), refusal(401, "auth"), stream(SENTENCES).response);
    const s = make();
    await s.ask("hi");
    expect(chatCalls).toHaveLength(2);
    expect(s.snapshot.messages[1]?.error).toBe("auth");
  });

  it("does not retry an answer that already started", async () => {
    chats.push(stream([{ type: "sentence", turnId: "t1", id: 0, text: "Hi." }]).response, stream(SENTENCES).response);
    const s = make();
    await s.ask("hi");
    expect(chatCalls).toHaveLength(1);
  });
});

describe("snapshot", () => {
  it("is the same object until something changes, and never mutated", async () => {
    chats.push(stream(SENTENCES).response);
    const s = make();
    const listener = vi.fn();
    const off = s.subscribe(listener);
    const first = s.snapshot;
    expect(s.snapshot).toBe(first);
    s.stop();
    s.stopVoice();
    s.interrupt();
    expect(s.snapshot).toBe(first);
    expect(listener).not.toHaveBeenCalled();

    await s.ask("hi");
    const after = s.snapshot;
    expect(after).not.toBe(first);
    expect(first.messages).toEqual([]);
    expect(listener).toHaveBeenCalled();
    const calls = listener.mock.calls.length;
    await s.start(); // already ready: nothing changes
    expect(s.snapshot).toBe(after);
    expect(listener).toHaveBeenCalledTimes(calls);

    off();
    chats.push(stream(SENTENCES).response);
    await s.ask("again");
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  it("keeps earlier message objects when a later one changes", async () => {
    chats.push(stream(SENTENCES).response);
    const s = make();
    const pending = s.ask("hi");
    await until(() => s.snapshot.messages.length === 2);
    const visitor = s.snapshot.messages[0];
    await pending;
    expect(s.snapshot.messages[0]).toBe(visitor);
  });
});

describe("reset and dispose", () => {
  it("reset forgets the conversation and the session", async () => {
    chats.push(stream(SENTENCES).response);
    const s = make();
    await s.ask("hi");
    s.reset();
    expect(s.snapshot).toMatchObject({ status: "idle", messages: [], limitReached: false, notice: null });
    await s.start();
    expect(sessionCalls).toBe(2);
  });

  it("dispose aborts the answer and stops notifying", async () => {
    const hanging = stream([SENTENCES[1]!], { hang: true });
    chats.push(hanging.response);
    const s = make();
    const running = s.ask("hi");
    await until(() => s.snapshot.messages[1]?.sentences.length === 1);
    const listener = vi.fn();
    s.subscribe(listener);
    s.dispose();
    await running;
    expect(listener).not.toHaveBeenCalled();
    expect(hanging.state.cancelled).toBe(true);
  });
});

describe("voice", () => {
  const READY = { type: "ready", protocol: PROTOCOL_VERSION, mode: "voice", audio: VOICE_FORMAT };

  async function voiceReady() {
    sessionTemplate = { mode: "voice" };
    const s = make();
    await s.start();
    const starting = s.startVoice();
    await until(() => sockets.length === 1);
    const ws = sockets[0]!;
    ws.open();
    await starting;
    ws.receive(READY);
    return { s, ws };
  }

  it("connects, goes live, and follows the server's state", async () => {
    const { s, ws } = await voiceReady();
    expect(ws.url).toBe("wss://yashos.dev/assistant/voice");
    await until(() => vi.mocked(startMic).mock.calls.length > 0);
    expect(s.snapshot.voice.state).toBe("listening");
    ws.receive({ type: "state", state: "thinking" });
    expect(s.snapshot.voice.state).toBe("thinking");
    ws.receive({ type: "state", state: "speaking" });
    expect(s.snapshot.voice.state).toBe("speaking");
    ws.receive({ type: "state", state: "listening" });
    expect(s.snapshot.voice.state).toBe("listening");
  });

  it("shows the transcript as it forms, and a turn as a visitor and an assistant message", async () => {
    const { s, ws } = await voiceReady();
    ws.receive({ type: "transcript", turnIndex: 0, text: "where does", final: false });
    expect(s.snapshot.voice.transcript).toBe("where does");
    ws.receive({ type: "transcript", turnIndex: 0, text: "where does Yash work", final: true });
    ws.receive({ type: "turn.start", turnId: "t1", question: "where does Yash work" });
    expect(s.snapshot.voice.transcript).toBe("");
    expect(s.snapshot.busy).toBe(true);
    expect(s.snapshot.messages).toMatchObject([
      { role: "visitor", text: "where does Yash work" },
      { role: "assistant", pending: true },
    ]);

    ws.receive({ type: "sentence", turnId: "t1", id: 0, text: "At Magenta Connect." });
    ws.receive({ type: "sentence", turnId: "t1", id: 1, text: "It is shown only.", spoken: false });
    ws.receive({ type: "meta", turnId: "t1", data: { refs: [], show: null, contact: false, coverage: "direct" }, sources: [] });
    ws.receive({ type: "turn.end", turnId: "t1", record: RECORD });
    expect(s.snapshot.messages[1]).toMatchObject({
      text: "At Magenta Connect. It is shown only.",
      sentences: [{ id: 0, text: "At Magenta Connect." }, { id: 1, text: "It is shown only.", spoken: false }],
      coverage: "direct",
      pending: false,
    });
    expect(s.snapshot.messages[1]?.sentences[0]).not.toHaveProperty("spoken");
    expect(s.snapshot.busy).toBe(false);
  });

  it("marks an interrupted turn stopped", async () => {
    const { s, ws } = await voiceReady();
    ws.receive({ type: "turn.start", turnId: "t1", question: "q" });
    ws.receive({ type: "sentence", turnId: "t1", id: 0, text: "One." });
    ws.receive({ type: "state", state: "speaking" });
    s.interrupt();
    expect(ws.sentJson).toContainEqual({ type: "interrupt", turnId: "t1", lastHeardSentenceId: null });
    ws.receive({ type: "turn.end", turnId: "t1", record: { ...RECORD, interrupted: true } });
    expect(s.snapshot.messages[1]).toMatchObject({ text: "One.", stopped: true, pending: false });
  });

  it("on voice_resting turns voice off, sets mode to text and says so", async () => {
    const { s, ws } = await voiceReady();
    ws.receive({ type: "turn.start", turnId: "t1", question: "q" });
    ws.receive({ type: "error", code: "voice_resting", message: "" });
    expect(s.snapshot).toMatchObject({ mode: "text", voice: { state: "off", transcript: "" } });
    expect(s.snapshot.notice).toMatch(/voice is resting/i);
    expect(ws.closedWith).not.toBeNull();
    // Answers continue as text.
    chats.push(stream(SENTENCES).response);
    await s.ask("and now?");
    expect(s.snapshot.messages.at(-1)).toMatchObject({ role: "assistant", error: null, pending: false });
    await s.startVoice();
    expect(sockets).toHaveLength(1); // voice cannot be started again
  });

  it("puts other voice errors on the answer in progress", async () => {
    const { s, ws } = await voiceReady();
    ws.receive({ type: "turn.start", turnId: "t1", question: "q" });
    ws.receive({ type: "error", code: "provider", message: "" });
    expect(s.snapshot.messages[1]).toMatchObject({ error: "provider", pending: false });
    expect(s.snapshot.voice.state).not.toBe("off");
  });

  it("stopVoice closes the socket and keeps the messages", async () => {
    const { s, ws } = await voiceReady();
    ws.receive({ type: "turn.start", turnId: "t1", question: "q" });
    ws.receive({ type: "sentence", turnId: "t1", id: 0, text: "One." });
    s.stopVoice();
    expect(ws.closedWith).toEqual({ code: 1000, reason: "client closed" });
    expect(s.snapshot.voice.state).toBe("off");
    expect(s.snapshot.busy).toBe(false);
    expect(s.snapshot.messages[1]).toMatchObject({ text: "One.", pending: false, stopped: true });
  });

  it("says so when the socket drops, and marks an unfinished answer", async () => {
    const { s, ws } = await voiceReady();
    ws.receive({ type: "turn.start", turnId: "t1", question: "q" });
    ws.serverClose(1006);
    expect(s.snapshot.voice.state).toBe("off");
    expect(s.snapshot.notice).toMatch(/voice/i);
    expect(s.snapshot.messages[1]).toMatchObject({ pending: false, error: "unknown" });
    expect(s.snapshot.mode).toBe("voice");
  });

  it("says so when the upgrade is refused (a socket that never opened)", async () => {
    sessionTemplate = { mode: "voice" };
    const s = make();
    await s.start();
    const starting = s.startVoice();
    await until(() => sockets.length === 1);
    sockets[0]!.serverClose(1006);
    await starting;
    expect(s.snapshot.voice.state).toBe("off");
    expect(s.snapshot.notice).toMatch(/couldn't connect/i);
  });

  it("turns voice off with a notice when the microphone is refused", async () => {
    vi.mocked(startMic).mockRejectedValueOnce(new Error("denied"));
    const { s } = await voiceReady();
    await until(() => s.snapshot.voice.state === "off");
    expect(s.snapshot.notice).toMatch(/microphone/i);
  });

  it("does not start voice in text mode", async () => {
    const s = make();
    await s.start();
    await s.startVoice();
    expect(sockets).toHaveLength(0);
    expect(s.snapshot.voice.state).toBe("off");
  });
});
