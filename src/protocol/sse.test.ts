import { describe, expect, it } from "vitest";
import { ChatRequestSchema, SessionRequestSchema, tokenFromAuthorization } from "./chat";
import type { ServerEvent } from "./events";
import { encodeSse, SSE_KEEPALIVE, SseParser } from "./sse";

const events: ServerEvent[] = [
  { type: "turn.start", turnId: "t1", question: "Where does Yash work?" },
  { type: "sentence", turnId: "t1", id: 0, text: "Yash works at Magenta Connect.\nOn two lines." },
  { type: "sources", turnId: "t1", sources: [{ ref: "role:magenta", title: "Magenta Connect" }] },
  { type: "error", code: "resting", message: "Back tomorrow." },
];

describe("SSE framing", () => {
  it("round-trips events in one chunk", () => {
    expect(new SseParser().push(events.map(encodeSse).join(""))).toEqual(events);
  });

  it("round-trips events split at every byte", () => {
    const parser = new SseParser();
    const text = events.map(encodeSse).join("");
    const out: ServerEvent[] = [];
    for (const ch of text) out.push(...parser.push(ch));
    expect(out).toEqual(events);
  });

  it("handles CRLF line endings", () => {
    const text = encodeSse(events[0]!).replace(/\n/g, "\r\n");
    expect(new SseParser().push(text)).toEqual([events[0]]);
  });

  it("skips keepalives, unknown types, bad JSON and data-less blocks", () => {
    const parser = new SseParser();
    const text = [
      SSE_KEEPALIVE,
      'event: x\ndata: {"type":"hello"}\n\n',
      "data: not json\n\n",
      "event: sentence\n\n",
      "data: [1,2]\n\n",
      encodeSse(events[0]!),
    ].join("");
    expect(parser.push(text)).toEqual([events[0]]);
  });

  it("holds an incomplete event until its blank line arrives", () => {
    const parser = new SseParser();
    const text = encodeSse(events[0]!);
    expect(parser.push(text.slice(0, -1))).toEqual([]);
    expect(parser.push("\n")).toEqual([events[0]]);
  });
});

describe("chat contracts", () => {
  it("reads a bearer token", () => {
    expect(tokenFromAuthorization("Bearer abc.def")).toBe("abc.def");
    expect(tokenFromAuthorization("bearer abc")).toBeNull();
    expect(tokenFromAuthorization("Bearer a b")).toBeNull();
    expect(tokenFromAuthorization(null)).toBeNull();
  });

  it("trims messages and refuses empty or oversized ones", () => {
    expect(ChatRequestSchema.parse({ message: "  hi  " })).toEqual({ message: "hi" });
    expect(ChatRequestSchema.safeParse({ message: "   " }).success).toBe(false);
    expect(ChatRequestSchema.safeParse({ message: "x".repeat(4001) }).success).toBe(false);
  });

  it("requires a Turnstile token for a session", () => {
    expect(SessionRequestSchema.safeParse({}).success).toBe(false);
    expect(SessionRequestSchema.parse({ turnstile: "XXXX.DUMMY.TOKEN.XXXX" })).toEqual({ turnstile: "XXXX.DUMMY.TOKEN.XXXX" });
  });
});
