import { describe, expect, it } from "vitest";
import type { ServerEvent } from "../protocol/events";
import { encodeSse } from "../protocol/sse";
import type { TurnRecord } from "../protocol/turn-record";
import { parseToken } from "./auth";
import { CANARY_QUESTION, runCanary } from "./canary";
import type { Env } from "./env";

const ANSWER = "Yash is a Full Stack Developer at Magenta Connect.";
const record = (error: string | null) => ({ turnId: "t1", mode: "text", error }) as unknown as TurnRecord;
const META: ServerEvent = {
  type: "meta",
  turnId: "t1",
  data: { refs: ["role:magenta"], show: null, contact: false, coverage: "direct" },
  sources: [{ ref: "role:magenta", title: "Magenta Connect" }],
};
const GOOD: ServerEvent[] = [
  { type: "turn.start", turnId: "t1", question: CANARY_QUESTION },
  { type: "sentence", turnId: "t1", id: 0, text: ANSWER },
  META,
  { type: "turn.end", turnId: "t1", record: record(null) },
];

/** An env whose Conversation stub answers every chat with `reply`, advancing the clock by 450 ms. */
function setup(o: { events?: ServerEvent[]; reply?: () => Response; mode?: Env["ASSISTANT_MODE"]; fail?: boolean } = {}) {
  let clock = 1_000_000;
  const inits: [string, number, string | undefined][] = [];
  const requests: Request[] = [];
  const env = {
    ASSISTANT_MODE: o.mode ?? "voice",
    CONVERSATION: {
      idFromName: (name: string) => `id:${name}`,
      get: () => ({
        async init(secretHash: string, expiresAt: number, source?: string) {
          inits.push([secretHash, expiresAt, source]);
        },
        async fetch(request: Request) {
          if (o.fail) throw new Error("object unavailable");
          requests.push(request);
          clock += 450;
          return o.reply?.() ?? new Response((o.events ?? GOOD).map(encodeSse).join(""), { status: 200 });
        },
      }),
    },
  } as unknown as Env;
  return { env, inits, requests, now: () => clock };
}

describe("runCanary", () => {
  it("is ok when the answer has a sentence, a meta and a clean turn.end, timed end to end", async () => {
    const h = setup();
    expect(await runCanary(h.env, h.now)).toEqual({ ok: true, ms: 450, reason: null });
  });

  it("asks through the same path visitors use: a fresh conversation, a bearer token, no special headers", async () => {
    const h = setup();
    await runCanary(h.env, h.now);
    const [req] = h.requests;
    expect(req?.method).toBe("POST");
    expect(new URL(req?.url ?? "").pathname).toBe("/assistant/chat");
    expect([...(req?.headers.keys() ?? [])].sort()).toEqual(["authorization", "content-type"]);
    const token = /^Bearer (.+)$/.exec(req?.headers.get("authorization") ?? "")?.[1] ?? "";
    expect(parseToken(token)).not.toBeNull();
    expect(await req?.json()).toEqual({ message: CANARY_QUESTION });
    const [init] = h.inits;
    expect(init?.[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(init?.[1]).toBeGreaterThan(1_000_000);
    expect(init?.[2]).toBe("canary"); // its turn log rows are told apart from visitors'
  });

  it("fails without a turn.end", async () => {
    const h = setup({ events: GOOD.slice(0, 3) });
    expect(await runCanary(h.env, h.now)).toEqual({ ok: false, ms: 450, reason: "no turn.end" });
  });

  it("fails without a sentence or a meta", async () => {
    const noSentence = setup({ events: GOOD.filter((e) => e.type !== "sentence") });
    expect((await runCanary(noSentence.env, noSentence.now)).reason).toBe("no sentence");
    const noMeta = setup({ events: GOOD.filter((e) => e.type !== "meta") });
    expect((await runCanary(noMeta.env, noMeta.now)).reason).toBe("no meta");
  });

  it("fails on an error event, naming its code", async () => {
    const h = setup({
      events: [
        GOOD[0] as ServerEvent,
        { type: "error", code: "provider", message: "The assistant could not finish that answer." },
        { type: "turn.end", turnId: "t1", record: record("llm_timeout") },
      ],
    });
    expect(await runCanary(h.env, h.now)).toEqual({ ok: false, ms: 450, reason: "error event: provider" });
  });

  it("fails when the record carries an error", async () => {
    const h = setup({ events: [...GOOD.slice(0, 3), { type: "turn.end", turnId: "t1", record: record("tts_failed") }] });
    expect((await runCanary(h.env, h.now)).reason).toBe("turn error: tts_failed");
  });

  it("fails on an HTTP refusal, with its status and error", async () => {
    const h = setup({ reply: () => Response.json({ error: "resting" }, { status: 503 }) });
    expect(await runCanary(h.env, h.now)).toEqual({ ok: false, ms: 450, reason: "http 503 resting" });
  });

  it("fails when the object throws", async () => {
    const h = setup({ fail: true });
    expect(await runCanary(h.env, h.now)).toEqual({ ok: false, ms: 0, reason: "object unavailable" });
  });

  it("does not ask while the assistant is off, as visitors cannot", async () => {
    const h = setup({ mode: "off" });
    expect(await runCanary(h.env, h.now)).toEqual({ ok: false, ms: 0, reason: "assistant is off" });
    expect(h.inits).toEqual([]);
  });

  it("never puts answer text in its reason", async () => {
    const h = setup({ events: GOOD.slice(0, 2) });
    const { reason } = await runCanary(h.env, h.now);
    expect(reason).not.toContain("Magenta");
  });
});
