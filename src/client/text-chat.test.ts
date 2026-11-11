import { describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "../protocol/events";
import { encodeSse, SSE_KEEPALIVE } from "../protocol/sse";
import { PROTOCOL_VERSION } from "../protocol/version";
import { AssistantHttpError, ask, startSession } from "./text-chat";

const BASE = "https://yashos.dev/assistant";

const EVENTS: ServerEvent[] = [
  { type: "turn.start", turnId: "t1", question: "Where does Yash work now?" },
  { type: "sentence", turnId: "t1", id: 0, text: "Yash works at Magenta Connect — in Ahmedabad." },
  { type: "sentence", turnId: "t1", id: 1, text: "Yash joined in Aug 2025.\nStill there." },
  {
    type: "meta",
    turnId: "t1",
    data: { refs: ["role:magenta"], show: null, contact: false, coverage: "direct" },
    sources: [{ ref: "role:magenta", title: "Magenta Connect · Full Stack Developer" }],
  },
];

/** `bytes` cut into pieces of 1, 2, 3, … bytes, so cuts land inside lines and multi-byte characters. */
function oddChunks(bytes: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let at = 0, size = 1; at < bytes.length; at += size, size = (size % 7) + 1) {
    chunks.push(bytes.slice(at, at + size));
  }
  return chunks;
}

/**
 * A body that hands out one chunk per read. With `hang`, it never ends after the last chunk, like a
 * server still thinking. `cancelled` reports whether the reader gave up on it.
 */
function body(chunks: Uint8Array[], o: { hang?: boolean } = {}) {
  const state = { cancelled: false };
  let next = 0;
  const stream = new ReadableStream<Uint8Array>(
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
  return { stream, state };
}

const sse = (stream: ReadableStream<Uint8Array>) =>
  new Response(stream, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });

function fakeFetch(respond: () => Response) {
  return vi.fn<typeof fetch>(async () => respond());
}

describe("startSession", () => {
  const session = { token: "c1.s1", protocol: PROTOCOL_VERSION, mode: "text", expiresAt: 1_800_000, resting: false };

  it("posts the Turnstile token to <baseUrl>/session and returns the session", async () => {
    const fetch = fakeFetch(() => Response.json(session));
    await expect(startSession({ baseUrl: `${BASE}/`, turnstile: "XXXX.DUMMY.TOKEN.XXXX", fetch })).resolves.toEqual(
      session,
    );
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE}/session`);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ turnstile: "XXXX.DUMMY.TOKEN.XXXX" });
  });

  it("maps a failed check to an HTTP error and an off assistant to resting", async () => {
    const failed = startSession({
      baseUrl: BASE,
      turnstile: "x",
      fetch: fakeFetch(() => Response.json({ error: "turnstile_failed" }, { status: 403 })),
    });
    await expect(failed).rejects.toMatchObject({ name: "AssistantHttpError", status: 403, code: "unknown" });
    const off = startSession({
      baseUrl: BASE,
      turnstile: "x",
      fetch: fakeFetch(() => Response.json({ mode: "off" }, { status: 503 })),
    });
    await expect(off).rejects.toMatchObject({ status: 503, code: "resting" });
  });

  it("refuses a malformed reply or another protocol version", async () => {
    const malformed = fakeFetch(() => Response.json({ token: "c1.s1" }));
    await expect(startSession({ baseUrl: BASE, turnstile: "x", fetch: malformed })).rejects.toThrow(/malformed/);
    const newer = fakeFetch(() => Response.json({ ...session, protocol: PROTOCOL_VERSION + 1 }));
    await expect(startSession({ baseUrl: BASE, turnstile: "x", fetch: newer })).rejects.toThrow(/protocol/);
  });
});

describe("ask", () => {
  it("posts the message with the bearer token and delivers events in order across odd chunk boundaries", async () => {
    const text = SSE_KEEPALIVE + EVENTS.map(encodeSse).join("").replace(/\n/g, "\r\n");
    const { stream } = body(oddChunks(new TextEncoder().encode(text)));
    const fetch = fakeFetch(() => sse(stream));
    const seen: ServerEvent[] = [];

    await ask({ baseUrl: BASE, token: "c1.s1", message: "Where does Yash work now?", onEvent: (e) => seen.push(e), fetch });

    expect(seen).toEqual(EVENTS);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE}/chat`);
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer c1.s1");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ message: "Where does Yash work now?" });
  });

  it.each([
    [429, { error: "limit" }, "limit"],
    [503, { error: "resting" }, "resting"],
    [409, { error: "busy" }, "busy"],
    [401, { error: "auth" }, "auth"],
    [429, { error: "rate_limited" }, "rate_limited"],
    [400, { error: "bad_request" }, "bad_request"],
    [503, { mode: "off" }, "resting"],
    [418, { error: "teapot" }, "unknown"],
  ] as const)("maps HTTP %i %j to %s", async (status, json, code) => {
    const fetch = fakeFetch(() => Response.json(json, { status }));
    const err: unknown = await ask({ baseUrl: BASE, token: "t", message: "hi", onEvent: () => {}, fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(AssistantHttpError);
    expect(err).toMatchObject({ status, code });
  });

  it("maps a reply that is not JSON to unknown", async () => {
    const fetch = fakeFetch(() => new Response("<html>oops</html>", { status: 502 }));
    await expect(ask({ baseUrl: BASE, token: "t", message: "hi", onEvent: () => {}, fetch })).rejects.toMatchObject({
      status: 502,
      code: "unknown",
    });
  });

  it("refuses a 200 that is not an event stream", async () => {
    const fetch = fakeFetch(() => new Response("<html></html>", { headers: { "content-type": "text/html" } }));
    await expect(ask({ baseUrl: BASE, token: "t", message: "hi", onEvent: () => {}, fetch })).rejects.toThrow(
      /event stream/,
    );
  });

  it("on abort rejects with an AbortError, delivers nothing more and stops reading", async () => {
    // The first chunk holds turn.start and two sentences; then the server goes quiet.
    const first = new TextEncoder().encode(EVENTS.slice(0, 3).map(encodeSse).join(""));
    const { stream, state } = body([first], { hang: true });
    const controller = new AbortController();
    const seen: string[] = [];

    const done = ask({
      baseUrl: BASE,
      token: "t",
      message: "hi",
      signal: controller.signal,
      fetch: fakeFetch(() => sse(stream)),
      onEvent: (e) => {
        seen.push(e.type);
        if (e.type === "sentence") controller.abort(); // Stop pressed as the first sentence shows
      },
    });

    await expect(done).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toEqual(["turn.start", "sentence"]);
    expect(state.cancelled).toBe(true);
  });

  it("stops reading a quiet stream when aborted from outside", async () => {
    const { stream, state } = body([], { hang: true });
    const controller = new AbortController();
    const done = ask({
      baseUrl: BASE,
      token: "t",
      message: "hi",
      signal: controller.signal,
      fetch: fakeFetch(() => sse(stream)),
      onEvent: () => {},
    });
    setTimeout(() => controller.abort(), 5);
    await expect(done).rejects.toMatchObject({ name: "AbortError" });
    expect(state.cancelled).toBe(true);
  });

  it("does not send when the signal is already aborted", async () => {
    const fetch = fakeFetch(() => Response.json({}));
    const controller = new AbortController();
    controller.abort();
    await expect(
      ask({ baseUrl: BASE, token: "t", message: "hi", signal: controller.signal, onEvent: () => {}, fetch }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
