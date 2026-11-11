import { afterEach, describe, expect, it, vi } from "vitest";
import { sqliteD1 } from "../../tests/sqlite-d1";
import { MAX_BODY_BYTES } from "../protocol/chat";
import type { ServerEvent } from "../protocol/events";
import { encodeSse } from "../protocol/sse";
import type { TurnRecord } from "../protocol/turn-record";
import { mintToken, sha256Hex } from "./auth";
import type { Env } from "./env";
import { spend, spendVisitor, utcDay } from "./ledger";
import { recordGap } from "./gap-log";
import { recordTurn } from "./turn-log";

// The Durable Object class needs workerd; the routes only talk to it through its namespace stub.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { default: worker } = await import("./index");

const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

const DAY = 24 * 60 * 60 * 1000;

const RECORD: TurnRecord = {
  turnId: "t1",
  conversationId: "c1",
  mode: "text",
  protocol: 1,
  model: "fake",
  promptHash: "p",
  knowledgeHash: "k",
  marks: { received: 0 },
  tokens: { input: 0, cachedInput: 0, reasoning: 0, reasoningEstimated: false, output: 0 },
  ttsChars: 0,
  audioInSeconds: 0,
  costUsd: null,
  coverage: null,
  dataLine: null,
  gate: { dropped: 0, reasons: [], flags: [] },
  grounding: null,
  interrupted: false,
  error: null,
};

/** A database whose every call fails, as D1 does when it is unavailable. */
function brokenDb(): D1Database {
  return {
    prepare() {
      throw new Error("D1 unavailable");
    },
  } as unknown as D1Database;
}

function setup(
  o: {
    allow?: boolean;
    mode?: Env["ASSISTANT_MODE"];
    secret?: string | null;
    ipHashKey?: string | null;
    /** MINIMAX_API_KEY: a test value by default, null for none. */
    minimaxKey?: string | null;
    demo?: boolean;
    db?: D1Database;
    answer?: ServerEvent[];
  } = {},
) {
  const keys: string[] = [];
  const forwarded: Request[] = [];
  const inits: [string, number][] = [];
  const env = {
    ASSISTANT_MODE: o.mode ?? "voice",
    LLM_PROFILE: "minimax-flash",
    TTS_VOICE: "English_FriendlyPerson",
    DAILY_TURNS: "400",
    DAILY_VOICE_SECONDS: "1800",
    DAILY_TTS_CHARS: "60000",
    DAILY_TURNS_PER_IP: "60",
    TURNSTILE_SECRET: o.secret === null ? undefined : (o.secret ?? TURNSTILE_TEST_SECRET),
    IP_HASH_KEY: o.ipHashKey === null ? undefined : (o.ipHashKey ?? "test-key"),
    MINIMAX_API_KEY: o.minimaxKey === null ? undefined : (o.minimaxKey ?? "test-minimax-key"),
    ASSISTANT_DEMO: o.demo ? "1" : undefined,
    RL_SESSION: {
      async limit({ key }: { key: string }) {
        keys.push(key);
        return { success: o.allow ?? true };
      },
    },
    CONVERSATION: {
      idFromName: (name: string) => name,
      get: () => ({
        async init(secretHash: string, expiresAt: number) {
          inits.push([secretHash, expiresAt]);
        },
        async fetch(request: Request) {
          forwarded.push(request);
          if (o.answer) return new Response(o.answer.map(encodeSse).join(""));
          return new Response("upgraded");
        },
      }),
    },
    DB: o.db ?? sqliteD1(),
  } as unknown as Env;
  return { env, keys, forwarded, inits };
}

/** Replaces global fetch with a fake siteverify; returns the forms it received. */
function fakeSiteverify(reply: { success: boolean; "error-codes"?: string[] }) {
  const forms: URLSearchParams[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    forms.push(new URLSearchParams(init.body as URLSearchParams));
    return Response.json(reply);
  });
  return forms;
}

function voiceRequest(token = mintToken().token): Request {
  return new Request("https://example.test/assistant/voice", {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `assistant.v1, ${token}`, "cf-connecting-ip": "203.0.113.7" },
  });
}

function sessionRequest(body: unknown = { turnstile: DUMMY_TOKEN }): Request {
  return new Request("https://example.test/assistant/session", {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.7", "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function chatRequest(authorization: string | null = `Bearer ${mintToken().token}`): Request {
  return new Request("https://example.test/assistant/chat", {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.7", ...(authorization ? { authorization } : {}) },
    body: JSON.stringify({ message: "Where does Yash work?" }),
  });
}

const call = (request: Request, env: Env) =>
  (worker.fetch as (r: Request, e: Env) => Promise<Response>)(request, env);
const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /assistant/voice", () => {
  it("rate limits upgrades per client IP, apart from /session's count, before any Durable Object is reached", async () => {
    const h = setup({ allow: false });
    const res = await call(voiceRequest(), h.env);
    expect(res.status).toBe(429);
    expect(h.keys).toEqual(["voice:203.0.113.7"]);
    expect(h.forwarded).toEqual([]);
  });

  it("forwards a well-formed token to the conversation's Durable Object when under the limit", async () => {
    const h = setup();
    const res = await call(voiceRequest(), h.env);
    expect(await res.text()).toBe("upgraded");
    expect(h.forwarded).toHaveLength(1);
  });

  it("refuses a malformed token with 401 without spending the limit", async () => {
    const h = setup();
    const res = await call(voiceRequest("not-a-token"), h.env);
    expect(res.status).toBe(401);
    expect(h.keys).toEqual([]);
  });
});

describe("POST /assistant/session", () => {
  it("keeps its own per-IP key", async () => {
    const h = setup({ allow: false });
    const res = await call(
      new Request("https://example.test/assistant/session", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.7" } }),
      h.env,
    );
    expect(res.status).toBe(429);
    expect(h.keys).toEqual(["203.0.113.7"]);
  });

  it("answers 503 mode off before anything else", async () => {
    const h = setup({ mode: "off" });
    expect(await json(await call(sessionRequest(), h.env))).toEqual({ status: 503, body: { mode: "off" } });
    expect(h.keys).toEqual([]);
  });

  it("refuses a bad body with 400", async () => {
    const h = setup();
    for (const body of ["not json", {}, { turnstile: "" }, { turnstile: 7 }, { turnstile: "x".repeat(MAX_BODY_BYTES) }]) {
      expect(await json(await call(sessionRequest(body), h.env))).toEqual({ status: 400, body: { error: "bad_request" } });
    }
    expect(h.inits).toEqual([]);
  });

  it("refuses everyone with 503 when no Turnstile secret is configured, rather than skipping the check", async () => {
    const h = setup({ secret: null });
    expect(await json(await call(sessionRequest(), h.env))).toEqual({
      status: 503,
      body: { error: "turnstile_not_configured" },
    });
    expect(h.inits).toEqual([]);
  });

  it("refuses everyone with 503 not_configured when IP_HASH_KEY is missing, before asking Turnstile", async () => {
    const h = setup({ ipHashKey: null });
    const forms = fakeSiteverify({ success: true });
    expect(await json(await call(sessionRequest(), h.env))).toEqual({ status: 503, body: { error: "not_configured" } });
    expect(forms).toEqual([]);
    expect(h.inits).toEqual([]);
  });

  it("refuses everyone with 503 not_configured without MINIMAX_API_KEY unless in demo mode", async () => {
    const h = setup({ minimaxKey: null });
    const forms = fakeSiteverify({ success: true });
    expect(await json(await call(sessionRequest(), h.env))).toEqual({ status: 503, body: { error: "not_configured" } });
    expect(forms).toEqual([]);
    expect(h.inits).toEqual([]);
    const demo = setup({ minimaxKey: null, demo: true });
    fakeSiteverify({ success: true });
    expect((await call(sessionRequest(), demo.env)).status).toBe(200);
  });

  it("refuses a token Turnstile rejects with 403, minting nothing", async () => {
    const h = setup();
    const forms = fakeSiteverify({ success: false, "error-codes": ["invalid-input-response"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await json(await call(sessionRequest(), h.env))).toEqual({ status: 403, body: { error: "turnstile_failed" } });
    expect(Object.fromEntries(forms[0] ?? [])).toEqual({
      secret: TURNSTILE_TEST_SECRET,
      response: DUMMY_TOKEN,
      remoteip: "203.0.113.7",
    });
    expect(h.inits).toEqual([]);
  });

  /** A database with `n` of today's turns already spent. */
  async function spentToday(n: number) {
    const db = sqliteD1();
    await spend(db, "turns", n, n, utcDay(Date.now()));
    return db;
  }

  it("mints a conversation once Turnstile passes, with resting false under the day's ceiling", async () => {
    const h = setup({ db: await spentToday(399) });
    fakeSiteverify({ success: true });
    const before = Date.now();
    const res = await json(await call(sessionRequest(), h.env));
    expect(res).toEqual({
      status: 200,
      body: { token: expect.any(String), protocol: 1, mode: "voice", expiresAt: expect.any(Number), resting: false },
    });
    const secret = String(res.body.token).split(".")[1] ?? "";
    expect(h.inits).toEqual([[await sha256Hex(secret), res.body.expiresAt]]);
    expect(Number(res.body.expiresAt)).toBeGreaterThanOrEqual(before + 30 * 60_000);
  });

  it("says resting once the day's turns are used", async () => {
    const h = setup({ db: await spentToday(400) });
    fakeSiteverify({ success: true });
    expect((await json(await call(sessionRequest(), h.env))).body.resting).toBe(true);
  });

  it("says resting, in text mode, when the ledger cannot be read (fails closed), and logs why", async () => {
    const h = setup({ db: brokenDb() });
    fakeSiteverify({ success: true });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await json(await call(sessionRequest(), h.env));
    expect(res).toMatchObject({ status: 200, body: { resting: true, mode: "text" } });
    expect(error).toHaveBeenCalledWith("ledger failed: D1 unavailable");
  });

  it("reports mode text instead of voice while voice is resting today", async () => {
    for (const [unit, n] of [
      ["voice_seconds", 1786],
      ["tts_chars", 59_501],
    ] as const) {
      const db = sqliteD1();
      await spend(db, unit, n, n, utcDay(Date.now()));
      const h = setup({ db });
      fakeSiteverify({ success: true });
      expect((await json(await call(sessionRequest(), h.env))).body, unit).toMatchObject({ mode: "text", resting: false });
    }
  });

  it("keeps mode text and off as they are", async () => {
    const db = sqliteD1();
    await spend(db, "voice_seconds", 1800, 1800, utcDay(Date.now()));
    fakeSiteverify({ success: true });
    expect((await json(await call(sessionRequest(), setup({ db, mode: "text" }).env))).body.mode).toBe("text");
  });
});

describe("POST /assistant/chat", () => {
  it("answers 503 mode off", async () => {
    const h = setup({ mode: "off" });
    expect(await json(await call(chatRequest(), h.env))).toEqual({ status: 503, body: { mode: "off" } });
    expect(h.forwarded).toEqual([]);
  });

  it("refuses a missing or malformed bearer token with 401 without spending the limit", async () => {
    const h = setup();
    for (const auth of [null, "Bearer not-a-token", `Basic ${mintToken().token}`]) {
      expect(await json(await call(chatRequest(auth), h.env))).toEqual({ status: 401, body: { error: "auth" } });
    }
    expect(h.keys).toEqual([]);
    expect(h.forwarded).toEqual([]);
  });

  it("rate limits per client IP under its own key", async () => {
    const h = setup({ allow: false });
    expect(await json(await call(chatRequest(), h.env))).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect(h.keys).toEqual(["chat:203.0.113.7"]);
    expect(h.forwarded).toEqual([]);
  });

  it("forwards a well-formed token to the conversation's object, which streams the answer", async () => {
    const h = setup({ answer: [{ type: "turn.start", turnId: "t1", question: "Where does Yash work?" }] });
    const res = await call(chatRequest(), h.env);
    expect(await res.text()).toContain("event: turn.start");
    expect(h.forwarded).toHaveLength(1);
  });

  it("allows only POST", async () => {
    const h = setup();
    const res = await call(new Request("https://example.test/assistant/chat"), h.env);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});

describe("GET /assistant/health", () => {
  const health = (env: Env) => call(new Request("https://example.test/assistant/health"), env);

  it("is ok when every required name is set, listing only the missing optional one", async () => {
    const h = setup();
    expect(await json(await health(h.env))).toEqual({
      status: 200,
      body: {
        ok: true,
        protocol: 1,
        mode: "voice",
        demo: false,
        missing: { required: [], optional: ["ALERT_TO"] },
        providers: "llm minimax-flash (MiniMax-M3.1-Flash), tts minimax-speech, stt flux",
      },
    });
  });

  it("is not ok when required config is missing, naming it and never a value", async () => {
    const h = setup({ secret: null, ipHashKey: null, minimaxKey: null });
    const res = await json(await health(h.env));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      ok: false,
      missing: { required: ["TURNSTILE_SECRET", "IP_HASH_KEY", "MINIMAX_API_KEY"], optional: ["ALERT_TO"] },
    });
    expect(JSON.stringify(res.body)).not.toContain("test-key");
  });

  it("does not require MINIMAX_API_KEY in demo mode, and says it is demo", async () => {
    const res = await json(await health(setup({ minimaxKey: null, demo: true }).env));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, demo: true, missing: { required: [] } });
  });
});

describe("scheduled", () => {
  const run = (env: Env) => {
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) } as unknown as ExecutionContext;
    (worker.scheduled as (c: ScheduledController, e: Env, x: ExecutionContext) => void)({} as ScheduledController, env, ctx);
    return Promise.all(waits);
  };
  const ANSWER = "Yash is a Full Stack Developer at Magenta Connect.";

  it("runs the canary under waitUntil and logs its time, never the answer", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const h = setup({
      answer: [
        { type: "turn.start", turnId: "t1", question: "Where does Yash work now?" },
        { type: "sentence", turnId: "t1", id: 0, text: ANSWER },
        {
          type: "meta",
          turnId: "t1",
          data: { refs: ["role:magenta"], show: null, contact: false, coverage: "direct" },
          sources: [{ ref: "role:magenta", title: "Magenta Connect" }],
        },
        { type: "turn.end", turnId: "t1", record: { error: null } as never },
      ],
    });
    await run(h.env);
    expect(h.forwarded).toHaveLength(1);
    const canary = info.mock.calls.map((c) => String(c[0])).filter((line) => line.startsWith("canary"));
    expect(canary).toEqual([expect.stringMatching(/^canary ok in \d+ ms$/)]);
  });

  it("logs the reason when the canary fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = setup({ answer: [{ type: "sentence", turnId: "t1", id: 0, text: ANSWER }] });
    await run(h.env);
    expect(error).toHaveBeenCalledWith("canary failed: no meta");
    expect(JSON.stringify(error.mock.calls)).not.toContain("Magenta");
  });

  it("deletes turn log and gap rows after 30 days, daily counts after 7 and visitor counts once their day is over", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = sqliteD1();
    const now = Date.now();
    await recordTurn(db, { ...RECORD, turnId: "old" }, now - 31 * DAY);
    await recordTurn(db, { ...RECORD, turnId: "recent" }, now - 29 * DAY);
    const gap = { conversationId: "c1", mode: "text", coverage: "none", refs: [], question: "q" } as const;
    await recordGap(db, gap, now - 31 * DAY);
    await recordGap(db, gap, now - 29 * DAY);
    await spend(db, "turns", 1, 1, utcDay(now - 8 * DAY));
    await spend(db, "turns", 1, 1, utcDay(now));
    await spendVisitor(db, "a".repeat(64), 60, utcDay(now - DAY));
    await spendVisitor(db, "b".repeat(64), 60, utcDay(now));
    await run(setup({ db, answer: [] }).env);
    expect(db.sqlite.prepare("SELECT turn_id FROM turns").all()).toEqual([{ turn_id: "recent" }]);
    expect(db.sqlite.prepare("SELECT created_at FROM gaps").all()).toHaveLength(1);
    expect(db.sqlite.prepare("SELECT day FROM daily").all()).toEqual([{ day: utcDay(now) }]);
    expect(db.sqlite.prepare("SELECT day FROM daily_ip").all()).toEqual([{ day: utcDay(now) }]);
    expect(info).toHaveBeenCalledWith("retention: deleted 1 turns, 1 gaps, 1 daily counts and 1 visitor counts");
  });

  it("logs a retention failure without stopping the canary", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const h = setup({ db: brokenDb(), answer: [] });
    await run(h.env);
    expect(h.forwarded).toHaveLength(1);
    expect(error).toHaveBeenCalledWith("retention failed: D1 unavailable");
  });
});

