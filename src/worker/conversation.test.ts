import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { sqliteD1 } from "../../tests/sqlite-d1";
import { MAX_BODY_BYTES } from "../protocol/chat";
import type { ServerEvent } from "../protocol/events";
import { SseParser } from "../protocol/sse";
import { mintToken, parseToken } from "./auth";
import type { Env } from "./env";
import { used, utcDay, type LedgerUnit } from "./ledger";

// The Durable Object base class only exists inside workerd; the shell needs nothing from it here.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown;
    protected env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { Conversation, RETENTION_MS, readJson } = await import("./conversation");

const DAY = 24 * 60 * 60 * 1000;

/** The storage calls the shell makes, in memory. */
function fakeState() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = {
    async get(key: string | string[]) {
      if (Array.isArray(key)) return new Map(key.filter((k) => data.has(k)).map((k) => [k, data.get(k)]));
      return structuredClone(data.get(key));
    },
    async put(entries: string | Record<string, unknown>, value?: unknown) {
      if (typeof entries === "string") data.set(entries, structuredClone(value));
      else for (const [k, v] of Object.entries(entries)) data.set(k, v);
    },
    async setAlarm(at: number) {
      alarm = at;
    },
    async deleteAll() {
      data.clear();
    },
  };
  return { ctx: { storage } as unknown as DurableObjectState, data, alarm: () => alarm };
}

describe("Conversation", () => {
  it("keeps conversations for 30 days", () => {
    expect(RETENTION_MS).toBe(30 * DAY);
  });

  it("stores the secret hash, expiry and source, and schedules deletion 30 days after the session expires", async () => {
    const s = fakeState();
    const conversation = new Conversation(s.ctx, {} as Env);
    await conversation.init("hash-1", 1_700_000_000_000);
    expect(s.data.get("secretHash")).toBe("hash-1");
    expect(s.data.get("expiresAt")).toBe(1_700_000_000_000);
    expect(s.data.get("source")).toBe("visitor");
    expect(s.alarm()).toBe(1_700_000_000_000 + 30 * DAY);
  });

  it("deletes everything it stored when the alarm fires", async () => {
    const s = fakeState();
    const conversation = new Conversation(s.ctx, {} as Env);
    await conversation.init("hash-1", 1_700_000_000_000);
    s.data.set("history", [{ role: "user", text: "Where does Yash work?" }]);
    s.data.set("meter", { bytes: 2560, firstAt: 1, limited: false });
    await conversation.alarm();
    expect(s.data.size).toBe(0);
  });
});

/**
 * A chunked upload: `chunks` pieces, with no content-length header. Counts the bytes the reader
 * pulled and whether it cancelled the rest.
 */
function chunkedBody(chunks: Uint8Array[]) {
  const seen = { pulledBytes: 0, cancelled: false };
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[i++];
      if (!chunk) return controller.close();
      seen.pulledBytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  const request = new Request("https://example.test/assistant/session", {
    method: "POST",
    body: stream,
    duplex: "half",
  } as RequestInit);
  return { request, seen };
}

describe("readJson", () => {
  const Body = z.object({ message: z.string() });

  it("joins a chunked body under the cap and parses it", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ message: "Where does Yash work?" }));
    const { request } = chunkedBody([bytes.slice(0, 5), bytes.slice(5)]);
    expect(request.headers.get("content-length")).toBeNull();
    expect(await readJson(request, Body)).toEqual({ message: "Where does Yash work?" });
  });

  it("stops reading a chunked body with no content-length once it passes MAX_BODY_BYTES", async () => {
    // 1 MB in 1 KB chunks: buffering it whole before checking the size is what this guards against.
    const { request, seen } = chunkedBody(Array.from({ length: 1024 }, () => new Uint8Array(1024).fill(0x20)));
    expect(await readJson(request, Body)).toBeNull();
    expect(seen.cancelled).toBe(true);
    expect(seen.pulledBytes).toBeLessThanOrEqual(MAX_BODY_BYTES + 2 * 1024);
  });
});

const QUESTION = "Where does Yash work?";

/**
 * A Conversation initialised for a fresh token, on keyless providers (the scripted demo LLM), over
 * a SQLite D1 double (`sqlite`, to share one between conversations). `db` "refuse" leaves no turns
 * for the day; "throw" fails every call; "no-log" fails only the turn log's writes. `vars` override
 * the daily ceilings.
 */
async function chatSetup(
  o: {
    db?: "ok" | "refuse" | "throw" | "no-log" | "no-gaps";
    sqlite?: ReturnType<typeof sqliteD1>;
    vars?: Partial<Env>;
    ai?: unknown;
    turnsStarted?: number;
    expiresIn?: number;
    source?: "canary";
  } = {},
) {
  const s = fakeState();
  if (o.turnsStarted !== undefined) s.data.set("turnsStarted", o.turnsStarted);
  const db = o.sqlite ?? sqliteD1();
  const failing = (sql: string) =>
    o.db === "throw" || (o.db === "no-log" && sql.includes("INTO turns")) || (o.db === "no-gaps" && sql.includes("INTO gaps"));
  const env = {
    AI: o.ai ?? {},
    ASSISTANT_MODE: "voice",
    ASSISTANT_DEMO: "1", // no MINIMAX_API_KEY: the scripted demo is explicit now
    LLM_PROFILE: "minimax-flash",
    TTS_VOICE: "English_FriendlyPerson",
    DAILY_TURNS: o.db === "refuse" ? "0" : "400",
    DAILY_TURNS_PER_IP: "60",
    IP_HASH_KEY: "test-key",
    ...o.vars,
    DB: {
      prepare(sql: string) {
        if (failing(sql)) throw new Error("D1 unavailable");
        return db.prepare(sql);
      },
    },
  } as unknown as Env;
  const conversation = new Conversation(s.ctx, env);
  const minted = mintToken();
  await conversation.init(await minted.secretHash, Date.now() + (o.expiresIn ?? 60_000), o.source);
  const spentToday = () => used(db, "turns", utcDay(Date.now()));
  const usedToday = (unit: LedgerUnit) => used(db, unit, utcDay(Date.now()));
  const visitorCounts = () => db.sqlite.prepare("SELECT used FROM daily_ip ORDER BY used").all().map((r) => r.used);
  const turnRows = () => db.sqlite.prepare("SELECT * FROM turns").all();
  const gapRows = () => db.sqlite.prepare("SELECT * FROM gaps").all();
  return { conversation, token: minted.token, data: s.data, spentToday, usedToday, visitorCounts, turnRows, gapRows, db };
}

const IP = "203.0.113.7";

function chat(token: string | null, body: unknown = { message: QUESTION }, init: RequestInit = {}, ip = IP): Request {
  return new Request("https://example.test/assistant/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": ip,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

/** Reads the SSE body to its end; `stopAfter` cancels the read once it returns true. */
async function readEvents(res: Response, stopAfter?: (e: ServerEvent) => boolean): Promise<ServerEvent[]> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const out: ServerEvent[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    for (const e of parser.push(decoder.decode(value, { stream: true }))) {
      out.push(e);
      if (stopAfter?.(e)) {
        await reader.cancel();
        return out;
      }
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = async (res: Response) => ({ status: res.status, body: await res.json() });

describe("Conversation POST /assistant/chat", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("streams the answer as server-sent events and spends one of the day's turns", async () => {
    const h = await chatSetup();
    const res = await h.conversation.fetch(chat(h.token));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const events = await readEvents(res);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("turn.start");
    expect(types.slice(-2)).toEqual(["meta", "turn.end"]);
    expect(types.filter((t) => t === "sentence").length).toBeGreaterThan(0);
    expect(events.at(-1)).toMatchObject({ type: "turn.end", record: { mode: "text", error: null } });
    expect(await h.spentToday()).toBe(1);
    expect(h.data.get("history")).toEqual([
      { role: "user", text: QUESTION },
      { role: "assistant", text: expect.stringContaining("Magenta Connect") },
    ]);
  });

  it("refuses a missing, malformed, wrong or expired token with 401", async () => {
    const h = await chatSetup();
    const conversationId = parseToken(h.token)?.conversationId ?? "";
    for (const token of [null, "not-a-token", `${conversationId}.${"A".repeat(43)}`]) {
      expect(await json(await h.conversation.fetch(chat(token)))).toEqual({ status: 401, body: { error: "auth" } });
    }
    const expired = await chatSetup({ expiresIn: -1 });
    expect((await expired.conversation.fetch(chat(expired.token))).status).toBe(401);
    expect(await h.spentToday()).toBe(0);
  });

  it("refuses a bad body with 400, counting nothing", async () => {
    const h = await chatSetup();
    const bad = [
      "not json",
      {},
      { message: "" },
      { message: "   " },
      { message: "\u200B\u202E" }, // only invisible characters: nothing left once sanitized
      { message: 42 },
      { message: "x".repeat(4001) },
      { message: QUESTION, padding: "y".repeat(MAX_BODY_BYTES) },
    ];
    for (const body of bad) {
      expect(await json(await h.conversation.fetch(chat(h.token, body))), JSON.stringify(body).slice(0, 40)).toEqual({
        status: 400,
        body: { error: "bad_request" },
      });
    }
    expect(await h.spentToday()).toBe(0);
    expect(h.data.get("turnsStarted")).toBeUndefined();
  });

  it("answers a second chat while one is streaming with 409 busy, without a second paid turn", async () => {
    const h = await chatSetup();
    const first = await h.conversation.fetch(chat(h.token));
    const second = await h.conversation.fetch(chat(h.token, { message: "And before that?" }));
    expect(await json(second)).toEqual({ status: 409, body: { error: "busy" } });
    expect(await h.spentToday()).toBe(1);
    expect(h.data.get("turnsStarted")).toBe(1);
    await readEvents(first);
    // Free again once the first answer has ended.
    const third = await h.conversation.fetch(chat(h.token, { message: "And before that?" }));
    expect(third.status).toBe(200);
    await readEvents(third);
  });

  it("answers 429 limit once the conversation has used its turns, before spending the day's", async () => {
    const h = await chatSetup({ turnsStarted: 30 });
    expect(await json(await h.conversation.fetch(chat(h.token)))).toEqual({ status: 429, body: { error: "limit" } });
    expect(await h.spentToday()).toBe(0);
    expect((await h.conversation.fetch(chat(h.token))).status).toBe(429); // not stuck busy
  });

  it("answers 503 resting when the day's ceiling is reached, giving back the visitor's and the conversation's turn", async () => {
    const refused = await chatSetup({ db: "refuse" });
    expect(await json(await refused.conversation.fetch(chat(refused.token)))).toEqual({
      status: 503,
      body: { error: "resting" },
    });
    expect(refused.visitorCounts()).toEqual([0]);
    expect(refused.data.get("turnsStarted")).toBe(0);
    expect((await refused.conversation.fetch(chat(refused.token))).status).toBe(503); // not stuck busy

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = await chatSetup({ db: "throw" });
    expect(await json(await broken.conversation.fetch(chat(broken.token)))).toEqual({
      status: 503,
      body: { error: "resting" },
    });
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/ledger failed: D1 unavailable/));
    expect(refused.turnRows()).toEqual([]); // no model call, so nothing to log
  });

  it("answers 429 limit once the visitor's IP has used its turns today, giving back everyone's and the conversation's", async () => {
    const sqlite = sqliteD1();
    const vars = { DAILY_TURNS_PER_IP: "1" };
    const first = await chatSetup({ sqlite, vars });
    await readEvents(await first.conversation.fetch(chat(first.token)));
    // A new conversation from the same IP shares the visitor's count; another IP has its own.
    const second = await chatSetup({ sqlite, vars });
    expect(await json(await second.conversation.fetch(chat(second.token)))).toEqual({ status: 429, body: { error: "limit" } });
    expect(await second.spentToday()).toBe(1);
    expect(second.data.get("turnsStarted")).toBe(0);
    expect(second.visitorCounts()).toEqual([1]);
    const elsewhere = await second.conversation.fetch(chat(second.token, undefined, {}, "203.0.113.8"));
    expect(elsewhere.status).toBe(200);
    await readEvents(elsewhere);
  });

  it("counts a request without cf-connecting-ip as the visitor unknown", async () => {
    const h = await chatSetup({ vars: { DAILY_TURNS_PER_IP: "1" } });
    const bare = () => {
      const r = chat(h.token);
      r.headers.delete("cf-connecting-ip");
      return r;
    };
    await readEvents(await h.conversation.fetch(bare()));
    expect((await h.conversation.fetch(bare())).status).toBe(429);
  });

  it("refuses every answer as resting without IP_HASH_KEY (fails closed)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const h = await chatSetup({ vars: { IP_HASH_KEY: undefined } });
    expect(await json(await h.conversation.fetch(chat(h.token)))).toEqual({ status: 503, body: { error: "resting" } });
    expect(await h.spentToday()).toBe(0);
  });

  it("cancelling the response mid-answer stops the turn, keeps only what was sent and frees the conversation", async () => {
    const h = await chatSetup();
    const res = await h.conversation.fetch(chat(h.token));
    const events = await readEvents(res, (e) => e.type === "sentence");
    const sent = events.flatMap((e) => (e.type === "sentence" ? [e.text] : []));
    expect(sent).toHaveLength(1);
    await sleep(50);
    expect(h.data.get("history")).toEqual([
      { role: "user", text: QUESTION },
      { role: "assistant", text: sent[0] },
    ]);
    const next = await h.conversation.fetch(chat(h.token, { message: "And before that?" }));
    expect(next.status).toBe(200);
    await readEvents(next);
  });

  it("aborting the request (the visitor went away) stops the turn the same way", async () => {
    const h = await chatSetup();
    const visitor = new AbortController();
    const res = await h.conversation.fetch(chat(h.token, undefined, { signal: visitor.signal }));
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const seen: ServerEvent[] = [];
    while (!seen.some((e) => e.type === "sentence")) {
      const { done, value } = await reader.read();
      if (done) break;
      seen.push(...parser.push(decoder.decode(value, { stream: true })));
    }
    visitor.abort();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen.push(...parser.push(decoder.decode(value, { stream: true })));
    }
    expect(seen.map((e) => e.type)).toEqual(["turn.start", "sentence"]);
    const history = h.data.get("history") as { text: string }[];
    expect(history[1]?.text).toBe(seen[1]?.type === "sentence" ? seen[1].text : "");
  });

  it("writes the answer's record to the turn log after it ends, with no visitor or answer text", async () => {
    const h = await chatSetup();
    const events = await readEvents(await h.conversation.fetch(chat(h.token)));
    await sleep(0);
    const end = events.at(-1);
    const record = end?.type === "turn.end" ? end.record : null;
    const rows = h.turnRows();
    expect(rows).toEqual([
      expect.objectContaining({
        turn_id: record?.turnId,
        conversation_id: record?.conversationId,
        mode: "text",
        coverage: record?.coverage,
        interrupted: 0,
        error: null,
        source: "visitor",
      }),
    ]);
    const stored = JSON.stringify(rows);
    const answer = events.flatMap((e) => (e.type === "sentence" ? [e.text] : []));
    for (const text of [QUESTION, ...answer]) expect(stored).not.toContain(text);
  });

  it("logs the canary's answers with source canary", async () => {
    const h = await chatSetup({ source: "canary" });
    await readEvents(await h.conversation.fetch(chat(h.token)));
    await sleep(0);
    expect(h.turnRows()).toEqual([expect.objectContaining({ mode: "text", source: "canary" })]);
  });

  it("logs a stopped answer as interrupted", async () => {
    const h = await chatSetup();
    await readEvents(await h.conversation.fetch(chat(h.token)), (e) => e.type === "sentence");
    await sleep(50);
    expect(h.turnRows()).toEqual([expect.objectContaining({ mode: "text", interrupted: 1, done_ms: null })]);
  });

  it("still streams the whole answer when the turn log fails, and logs why without visitor text", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = await chatSetup({ db: "no-log" });
    const events = await readEvents(await h.conversation.fetch(chat(h.token)));
    await sleep(0);
    expect(events.map((e) => e.type).slice(-2)).toEqual(["meta", "turn.end"]);
    expect(await h.spentToday()).toBe(1);
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^conversation \w+: turn log failed: D1 unavailable$/));
    expect(JSON.stringify(errors.mock.calls)).not.toContain(QUESTION);
    // Free for the next question.
    const next = await h.conversation.fetch(chat(h.token, { message: "And before that?" }));
    expect(next.status).toBe(200);
    await readEvents(next);
  });

  it("writes a gap row for a question the knowledge did not cover: the question as sent, mode, coverage, refs", async () => {
    const h = await chatSetup();
    const asked = "Tell me a joke, my email is a@b.co";
    await readEvents(await h.conversation.fetch(chat(h.token, { message: asked })));
    await sleep(0);
    expect(h.gapRows()).toEqual([
      expect.objectContaining({ conversation: parseToken(h.token)?.conversationId.slice(0, 8), mode: "text", coverage: "none", refs: "[]", question: asked }),
    ]);
  });

  it("writes no gap row when the knowledge answered directly, or for the canary", async () => {
    const direct = await chatSetup();
    await readEvents(await direct.conversation.fetch(chat(direct.token)));
    await sleep(0);
    expect(direct.gapRows()).toEqual([]);
    const canary = await chatSetup({ source: "canary" });
    await readEvents(await canary.conversation.fetch(chat(canary.token, { message: "Tell me a joke" })));
    await sleep(0);
    expect(canary.gapRows()).toEqual([]);
  });

  it("still streams the whole answer when the gap log fails, and logs why without the question", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = await chatSetup({ db: "no-gaps" });
    const events = await readEvents(await h.conversation.fetch(chat(h.token, { message: "Tell me a joke" })));
    await sleep(0);
    expect(events.map((e) => e.type).slice(-2)).toEqual(["meta", "turn.end"]);
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^conversation \w+: gap log failed: D1 unavailable$/));
    expect(JSON.stringify(errors.mock.calls)).not.toContain("joke");
  });

  it("still requires a WebSocket upgrade on any other path", async () => {
    const h = await chatSetup();
    const res = await h.conversation.fetch(new Request("https://example.test/assistant/voice"));
    expect(res.status).toBe(426);
  });
});

/** Just enough of a Workers WebSocket: records what is sent and how it closed; `emit` plays the other end. */
class FakeSocket {
  binaryType = "blob";
  sent: (string | ArrayBuffer)[] = [];
  closed: { code: number; reason: string } | null = null;
  private listeners = new Map<string, ((e: unknown) => void)[]>();
  accept(): void {}
  send(data: string | ArrayBuffer): void {
    if (this.closed) throw new Error("WebSocket is closed");
    this.sent.push(data);
  }
  close(code: number, reason: string): void {
    this.closed ??= { code, reason };
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, e: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
  events(): ServerEvent[] {
    return this.sent.flatMap((d) => (typeof d === "string" ? [JSON.parse(d) as ServerEvent] : []));
  }
}

describe("Conversation voice socket", () => {
  /** The Durable Object's end of each WebSocketPair, and each Flux socket Workers AI opened. */
  const servers: FakeSocket[] = [];
  const fluxes: FakeSocket[] = [];
  const ai = {
    async run() {
      const flux = new FakeSocket();
      fluxes.push(flux);
      return { status: 101, webSocket: flux };
    },
  };

  beforeEach(() => {
    servers.length = 0;
    fluxes.length = 0;
    vi.stubGlobal(
      "WebSocketPair",
      class {
        0 = new FakeSocket();
        1 = new FakeSocket();
        constructor() {
          servers.push(this[1]);
        }
      },
    );
    // Node's Response refuses status 101; workerd's takes it, with the client's end of the socket.
    const NodeResponse = Response;
    vi.stubGlobal(
      "Response",
      class extends NodeResponse {
        constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
          super(body, init?.status === 101 ? { ...init, status: 200 } : init);
          if (init?.status === 101) Object.defineProperty(this, "status", { value: 101 });
        }
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function upgrade(token: string, ip = IP): Request {
    return new Request("https://example.test/assistant/voice", {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `assistant.v1, ${token}`, "cf-connecting-ip": ip },
    });
  }

  /** Opens a socket and waits for `ready`. */
  async function open(h: Awaited<ReturnType<typeof chatSetup>>) {
    const res = await h.conversation.fetch(upgrade(h.token));
    const socket = servers.at(-1) as FakeSocket;
    await vi.waitFor(() => expect(socket.events().map((e) => e.type)).toContain("ready"));
    return { res, socket, flux: fluxes.at(-1) as FakeSocket };
  }

  const ask = (flux: FakeSocket, transcript: string, turnIndex = 0) =>
    flux.emit("message", { data: JSON.stringify({ event: "EndOfTurn", transcript, turn_index: turnIndex }) });
  const types = (socket: FakeSocket) => socket.events().map((e) => (e.type === "error" ? `error:${e.code}` : e.type));

  it("refuses a malformed, wrong or expired token at upgrade with 401, reserving nothing", async () => {
    const h = await chatSetup({ ai });
    const conversationId = parseToken(h.token)?.conversationId ?? "";
    for (const token of ["not-a-token", `${conversationId}.${"A".repeat(43)}`]) {
      expect((await h.conversation.fetch(upgrade(token))).status).toBe(401);
    }
    const expired = await chatSetup({ ai, expiresIn: -1 });
    expect((await expired.conversation.fetch(upgrade(expired.token))).status).toBe(401);
    expect(servers).toEqual([]);
    expect(fluxes).toEqual([]);
    expect(await h.usedToday("voice_seconds")).toBe(0);
  });

  it("accepts a good token with 101, reserving the first 15 s block of the day's mic audio", async () => {
    const h = await chatSetup({ ai });
    const { res, socket } = await open(h);
    expect(res.status).toBe(101);
    expect(res.headers.get("Sec-WebSocket-Protocol")).toBe("assistant.v1");
    expect(types(socket).slice(0, 2)).toEqual(["ready", "state"]);
    expect(await h.usedToday("voice_seconds")).toBe(15);
  });

  for (const [what, vars] of [
    ["less than one 15 s block of mic audio", { DAILY_VOICE_SECONDS: "10" }],
    ["less than one reply's 500 spoken characters", { DAILY_TTS_CHARS: "400" }],
  ] as const) {
    it(`with ${what} left today: accepts, says voice_resting at once and closes 1008, opening nothing`, async () => {
      const h = await chatSetup({ ai, vars });
      const res = await h.conversation.fetch(upgrade(h.token));
      expect(res.status).toBe(101); // a browser hides a refused upgrade's status, so the socket says why
      const socket = servers.at(-1);
      expect(socket?.events()).toEqual([{ type: "error", code: "voice_resting", message: expect.any(String) }]);
      expect(socket?.closed).toEqual({ code: 1008, reason: "voice resting" });
      expect(fluxes).toEqual([]);
      expect(await h.usedToday("voice_seconds")).toBe(0);
    });
  }

  it("replaces the old socket with a new one, closing the old with 4000 and giving back its audio", async () => {
    const h = await chatSetup({ ai });
    const first = await open(h);
    const second = await open(h);
    expect(first.socket.closed).toEqual({ code: 4000, reason: "replaced by a newer connection" });
    expect(second.socket.closed).toBeNull();
    first.socket.emit("close"); // arrives late; the new socket carries on
    await vi.waitFor(async () => expect(await h.usedToday("voice_seconds")).toBe(15));
    second.socket.emit("message", { data: new ArrayBuffer(2560) });
    expect(second.flux.sent).toHaveLength(1);
  });

  it("closing the socket flushes the meter and gives back the unused mic audio", async () => {
    const h = await chatSetup({ ai });
    const { socket } = await open(h);
    for (let i = 0; i < 10; i++) socket.emit("message", { data: new ArrayBuffer(2560) }); // 0.8 s
    expect(h.data.get("meter")).toBeUndefined(); // saved every 5 s of audio, so not yet
    socket.emit("close");
    await vi.waitFor(() => expect(h.data.get("meter")).toMatchObject({ bytes: 25_600 }));
    await vi.waitFor(async () => expect(await h.usedToday("voice_seconds")).toBe(1)); // 14.2 s back, rounded down
  });

  it("closes the socket when the session expires", async () => {
    const h = await chatSetup({ ai, expiresIn: 400 });
    const { socket } = await open(h);
    expect(socket.closed).toBeNull();
    await vi.waitFor(() => expect(socket.closed).toEqual({ code: 1000, reason: "session expired" }), { timeout: 2000 });
  });

  it("lets text and voice on one conversation take 30 turns between them, never more", async () => {
    const h = await chatSetup({ ai, turnsStarted: 29 });
    const { socket, flux } = await open(h);
    // A voice question and a text question at once: only one gets the conversation's last turn.
    ask(flux, QUESTION);
    expect(await json(await h.conversation.fetch(chat(h.token, { message: "And before that?" })))).toEqual({
      status: 429,
      body: { error: "limit" },
    });
    await vi.waitFor(() => expect(types(socket)).toContain("turn.end"), { timeout: 5000 });
    expect(h.data.get("turnsStarted")).toBe(30);
    ask(flux, "And before that?", 1);
    expect(types(socket).at(-1)).toBe("error:limit");
    expect(socket.closed).toEqual({ code: 1008, reason: "turn limit" });
    expect(h.data.get("turnsStarted")).toBe(30);
  });

  it("spends voice turns against the IP it upgraded from, together with that IP's text", async () => {
    const h = await chatSetup({ ai, vars: { DAILY_TURNS_PER_IP: "1" } });
    const { socket, flux } = await open(h);
    ask(flux, QUESTION);
    await vi.waitFor(() => expect(types(socket)).toContain("turn.end"), { timeout: 5000 });
    expect(h.visitorCounts()).toEqual([1]);
    expect(await json(await h.conversation.fetch(chat(h.token, { message: "And before that?" })))).toEqual({
      status: 429,
      body: { error: "limit" },
    });
    expect(h.data.get("turnsStarted")).toBe(1);
  });
});
