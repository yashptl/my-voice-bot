import { describe, expect, it } from "vitest";
import { LlmError, type LlmChunk, type LlmRequest } from "../ports/llm";
import { createAnthropicCompatibleLlm } from "./anthropic-compatible";
import type { LlmProfile } from "./llm-profiles";

const BEARER_PROFILE: LlmProfile = {
  id: "test-bearer",
  baseUrl: "https://llm.test/anthropic",
  model: "Test-Model",
  auth: "bearer",
  keyEnv: "MINIMAX_API_KEY",
  extraBody: { output_config: { effort: "low" } },
  prices: { input: 1, cachedInput: 0.1, output: 2 },
};

const API_KEY_PROFILE: LlmProfile = {
  id: "test-x-api-key",
  baseUrl: "https://api.test/",
  model: "test-haiku",
  auth: "x-api-key",
  keyEnv: "ANTHROPIC_API_KEY",
  extraBody: { thinking: { type: "disabled" } },
  prices: { input: 1, cachedInput: 0.1, output: 2 },
  cacheSystem: true,
};

const REQUEST: LlmRequest = {
  stable: "STABLE PREFIX",
  turns: [
    { role: "user", text: "Where does Yash work?" },
    { role: "assistant", text: "Yash works at Magenta Connect." },
    { role: "user", text: '<visitor_message id="b1">What did Yash build there?</visitor_message>' },
  ],
  tail: "TAIL: voice mode, reply in English.",
  maxTokens: 8192,
};

type Ev = [event: string, data: Record<string, unknown>];

const messageStart = (usage: Record<string, number> = { input_tokens: 120, cache_read_input_tokens: 5000 }): Ev => [
  "message_start",
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "Test-Model-0601",
      content: [],
      stop_reason: null,
      usage: { cache_creation_input_tokens: 0, output_tokens: 1, ...usage },
    },
  },
];
const blockStart = (index: number, type: "thinking" | "text"): Ev => [
  "content_block_start",
  { type: "content_block_start", index, content_block: type === "text" ? { type, text: "" } : { type, thinking: "" } },
];
const thinking = (text: string): Ev => [
  "content_block_delta",
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: text } },
];
const signature: Ev = [
  "content_block_delta",
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "c2lnbmF0dXJl" } },
];
const text = (t: string): Ev => [
  "content_block_delta",
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: t } },
];
const blockStop = (index: number): Ev => ["content_block_stop", { type: "content_block_stop", index }];
const messageDelta = (stopReason: string, outputTokens: number): Ev => [
  "message_delta",
  { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } },
];
const messageStop: Ev = ["message_stop", { type: "message_stop" }];
const ping: Ev = ["ping", { type: "ping" }];

const THOUGHTS = ["The visitor asks about Magenta. ", "Recall the AI agent work. ", "Answer briefly."];

const HAPPY: Ev[] = [
  messageStart(),
  ping,
  blockStart(0, "thinking"),
  ...THOUGHTS.map(thinking),
  signature,
  blockStop(0),
  blockStart(1, "text"),
  text("Hi"),
  text(" there"),
  blockStop(1),
  messageDelta("end_turn", 80),
  messageStop,
];

function sseText(events: Ev[]): string {
  return ": keep-alive comment\n\n" + events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
}

/** Splits the body into 7-byte chunks so boundaries fall mid-line and mid-event. */
function chunkedBody(textBody: string, size = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(textBody);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  };
  return { fetch: f as typeof fetch, calls };
}

const sseResponse = (events: Ev[]) => () =>
  new Response(chunkedBody(sseText(events)), { status: 200, headers: { "content-type": "text/event-stream" } });

async function run(
  events: Ev[],
  profile: LlmProfile = BEARER_PROFILE,
  req: LlmRequest = REQUEST,
): Promise<{ chunks: LlmChunk[]; calls: Call[] }> {
  const { fetch, calls } = fakeFetch(sseResponse(events));
  const llm = createAnthropicCompatibleLlm({ profile, apiKey: "test-key-123", fetch });
  const chunks: LlmChunk[] = [];
  for await (const c of llm.stream(req)) chunks.push(c);
  return { chunks, calls };
}

function bodyOf(call: Call | undefined): Record<string, unknown> {
  if (!call) throw new Error("fetch was not called");
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

describe("createAnthropicCompatibleLlm: request", () => {
  it("exposes the profile id and model", () => {
    const llm = createAnthropicCompatibleLlm({ profile: BEARER_PROFILE, apiKey: "k", fetch: fakeFetch(sseResponse([])).fetch });
    expect(llm.id).toBe("test-bearer");
    expect(llm.model).toBe("Test-Model");
  });

  it("POSTs <baseUrl>/v1/messages with bearer auth and the Anthropic headers", async () => {
    const { calls } = await run(HAPPY);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://llm.test/anthropic/v1/messages");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({
      authorization: "Bearer test-key-123",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    });
  });

  it("sends the stable prefix as system, maps turns, puts tail then visitor text in the last user message, merges extraBody", async () => {
    const { calls } = await run(HAPPY);
    expect(bodyOf(calls[0])).toEqual({
      model: "Test-Model",
      max_tokens: 8192,
      stream: true,
      system: "STABLE PREFIX",
      messages: [
        { role: "user", content: "Where does Yash work?" },
        { role: "assistant", content: "Yash works at Magenta Connect." },
        {
          role: "user",
          content: [
            { type: "text", text: "TAIL: voice mode, reply in English." },
            { type: "text", text: '<visitor_message id="b1">What did Yash build there?</visitor_message>' },
          ],
        },
      ],
      output_config: { effort: "low" },
    });
    const raw = String(calls[0]?.init.body);
    for (const banned of ["temperature", "stop_sequences", "cache_control", "top_p", "top_k"]) {
      expect(raw).not.toContain(banned);
    }
  });

  it("uses x-api-key auth and a cache breakpoint on the system block when the profile asks for one", async () => {
    const { calls } = await run(HAPPY, API_KEY_PROFILE);
    expect(calls[0]?.url).toBe("https://api.test/v1/messages");
    expect(calls[0]?.init.headers).toEqual({
      "x-api-key": "test-key-123",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    });
    const body = bodyOf(calls[0]);
    expect(body.system).toEqual([{ type: "text", text: "STABLE PREFIX", cache_control: { type: "ephemeral" } }]);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.model).toBe("test-haiku");
  });

  it("drops empty history turns and an empty tail, which the API would reject", async () => {
    const { calls } = await run(HAPPY, BEARER_PROFILE, {
      ...REQUEST,
      tail: "",
      turns: [
        { role: "user", text: "Hi" },
        { role: "assistant", text: "" },
        { role: "user", text: "Still there?" },
      ],
    });
    expect(bodyOf(calls[0]).messages).toEqual([
      { role: "user", content: "Hi" },
      { role: "user", content: [{ type: "text", text: "Still there?" }] },
    ]);
  });

  it("rejects a request whose turns do not end with a user turn, without calling the provider", async () => {
    const { fetch, calls } = fakeFetch(sseResponse(HAPPY));
    const llm = createAnthropicCompatibleLlm({ profile: BEARER_PROFILE, apiKey: "k", fetch });
    const iterate = async () => {
      for await (const _ of llm.stream({ ...REQUEST, turns: [{ role: "assistant", text: "Hello" }] })) void _;
    };
    await expect(iterate()).rejects.toMatchObject({ name: "LlmError", kind: "bad_request" });
    expect(calls).toHaveLength(0);
  });
});

describe("createAnthropicCompatibleLlm: stream", () => {
  it("emits one reasoning tick, then text deltas, then usage", async () => {
    const { chunks } = await run(HAPPY);
    expect(chunks.map((c) => c.t)).toEqual(["reasoning", "text", "text", "usage"]);
    expect(chunks.filter((c) => c.t === "text")).toEqual([
      { t: "text", text: "Hi" },
      { t: "text", text: " there" },
    ]);
  });

  it("never forwards thinking text or signatures", async () => {
    const { chunks } = await run(HAPPY);
    const serialized = JSON.stringify(chunks);
    for (const thought of THOUGHTS) expect(serialized).not.toContain(thought.trim());
    expect(serialized).not.toContain("c2lnbmF0dXJl");
  });

  it("reports usage from message_start and message_delta, estimating reasoning from thinking characters", async () => {
    const { chunks } = await run(HAPPY);
    const thinkingChars = THOUGHTS.join("").length;
    expect(chunks.at(-1)).toEqual({
      t: "usage",
      usage: {
        input: 120,
        cachedInput: 5000,
        output: 80,
        reasoning: Math.ceil(thinkingChars / 4),
        reasoningEstimated: true,
        model: "Test-Model-0601",
        stopReason: "end_turn",
      },
    });
  });

  it("emits a reasoning tick for a thinking block even when its text is omitted", async () => {
    const { chunks } = await run([
      messageStart(),
      blockStart(0, "thinking"),
      signature,
      blockStop(0),
      blockStart(1, "text"),
      text("Yes."),
      blockStop(1),
      messageDelta("end_turn", 9),
      messageStop,
    ]);
    expect(chunks.map((c) => c.t)).toEqual(["reasoning", "text", "usage"]);
    expect(chunks.at(-1)).toMatchObject({ usage: { reasoning: 0, reasoningEstimated: true } });
  });

  it("emits no reasoning tick when the model does not think", async () => {
    const { chunks } = await run([
      messageStart({ input_tokens: 10 }),
      blockStart(1, "text"),
      text("Yes."),
      blockStop(1),
      messageDelta("end_turn", 2),
      messageStop,
    ]);
    expect(chunks.map((c) => c.t)).toEqual(["text", "usage"]);
    expect(chunks.at(-1)).toMatchObject({ usage: { input: 10, cachedInput: 0, output: 2, reasoning: 0 } });
  });

  it("ignores anything after message_stop", async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response(chunkedBody(sseText(HAPPY) + "data: [DONE]\n\n"), {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const llm = createAnthropicCompatibleLlm({ profile: BEARER_PROFILE, apiKey: "k", fetch });
    const chunks: LlmChunk[] = [];
    for await (const c of llm.stream(REQUEST)) chunks.push(c);
    expect(chunks.map((c) => c.t)).toEqual(["reasoning", "text", "text", "usage"]);
  });
});

/** Drains the stream; returns what arrived before the error, and the error. */
async function drain(llm: ReturnType<typeof createAnthropicCompatibleLlm>, signal?: AbortSignal) {
  const chunks: LlmChunk[] = [];
  try {
    for await (const c of llm.stream(REQUEST, signal)) chunks.push(c);
  } catch (error) {
    return { chunks, error };
  }
  return { chunks, error: undefined };
}

function llmFor(respond: (call: Call) => Response | Promise<Response>) {
  const fake = fakeFetch(respond);
  return { llm: createAnthropicCompatibleLlm({ profile: BEARER_PROFILE, apiKey: "test-key-123", fetch: fake.fetch }), ...fake };
}

describe("createAnthropicCompatibleLlm: errors", () => {
  const errorBody = (type: string, message: string) => JSON.stringify({ type: "error", error: { type, message } });

  it.each([
    [401, "authentication_error", "auth"],
    [403, "permission_error", "auth"],
    [429, "rate_limit_error", "rate_limit"],
    [529, "overloaded_error", "overloaded"],
    [503, "api_error", "overloaded"],
    [404, "not_found_error", "bad_request"],
    [500, "api_error", "unknown"],
  ] as const)("HTTP %i maps to LlmError kind %s/%s", async (status, type, kind) => {
    const { llm } = llmFor(
      () => new Response(errorBody(type, "provider says no"), { status, headers: { "content-type": "application/json" } }),
    );
    const { chunks, error } = await drain(llm);
    expect(chunks).toEqual([]);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ kind, status });
  });

  it("HTTP 400 is bad_request carrying the provider's message", async () => {
    const { llm } = llmFor(
      () =>
        new Response(errorBody("invalid_request_error", "max_tokens: must be at most 128000"), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    const { error } = await drain(llm);
    expect(error).toMatchObject({ name: "LlmError", kind: "bad_request", status: 400 });
    expect((error as Error).message).toContain("max_tokens: must be at most 128000");
  });

  it("keeps a non-JSON error body, truncated, and never includes the API key", async () => {
    const { llm } = llmFor(() => new Response("x".repeat(5000), { status: 502 }));
    const { error } = await drain(llm);
    expect(error).toMatchObject({ kind: "unknown", status: 502 });
    expect((error as Error).message.length).toBeLessThan(600);
    expect((error as Error).message).not.toContain("test-key-123");
  });

  it("an SSE error event mid-stream maps by error type (overloaded_error → overloaded)", async () => {
    const { llm } = llmFor(
      sseResponse([
        messageStart(),
        blockStart(1, "text"),
        text("Hi"),
        ["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }],
      ]),
    );
    const { chunks, error } = await drain(llm);
    expect(chunks).toEqual([{ t: "text", text: "Hi" }]);
    expect(error).toMatchObject({ name: "LlmError", kind: "overloaded" });
    expect((error as Error).message).toContain("Overloaded");
  });

  it("a 200 that is not an event stream is an error carrying the body's message", async () => {
    const { llm } = llmFor(
      () =>
        new Response(JSON.stringify({ base_resp: { status_code: 1004, status_msg: "login fail" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const { error } = await drain(llm);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as Error).message).toContain("login fail");
  });

  it("max_tokens with no answer text (thinking ate the budget) yields usage, then throws kind empty", async () => {
    const { llm } = llmFor(
      sseResponse([
        messageStart(),
        blockStart(0, "thinking"),
        ...THOUGHTS.map(thinking),
        blockStop(0),
        messageDelta("max_tokens", 8192),
        messageStop,
      ]),
    );
    const { chunks, error } = await drain(llm);
    expect(chunks.map((c) => c.t)).toEqual(["reasoning", "usage"]);
    expect(chunks.at(-1)).toMatchObject({ usage: { output: 8192, stopReason: "max_tokens" } });
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ kind: "empty" });
    expect((error as Error).message).toContain("max_tokens");
  });

  it("any reply that ends with no text is kind empty, not silence", async () => {
    const { llm } = llmFor(sseResponse([messageStart(), messageDelta("refusal", 3), messageStop]));
    const { error } = await drain(llm);
    expect(error).toMatchObject({ name: "LlmError", kind: "empty" });
    expect((error as Error).message).toContain("refusal");
  });

  it("a stream that ends before message_stop is a network error", async () => {
    const { llm } = llmFor(sseResponse([messageStart(), blockStart(1, "text"), text("Hi")]));
    const { chunks, error } = await drain(llm);
    expect(chunks).toEqual([{ t: "text", text: "Hi" }]);
    expect(error).toMatchObject({ name: "LlmError", kind: "network" });
  });

  it("a fetch that rejects is a network error", async () => {
    const { llm } = llmFor(() => Promise.reject(new TypeError("fetch failed")));
    const { error } = await drain(llm);
    expect(error).toMatchObject({ name: "LlmError", kind: "network" });
    expect((error as Error).cause).toBeInstanceOf(TypeError);
  });

  it("a body that fails mid-stream is a network error", async () => {
    const { llm } = llmFor(() => {
      const prefix = new TextEncoder().encode(sseText([messageStart(), blockStart(1, "text"), text("Hi")]));
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(prefix);
          controller.error(new TypeError("terminated"));
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    const { error } = await drain(llm);
    expect(error).toMatchObject({ name: "LlmError", kind: "network" });
  });

  it("an event whose data is not JSON before message_stop is a protocol error, not a silent drop", async () => {
    const { llm } = llmFor(
      () =>
        new Response(chunkedBody(sseText([messageStart()]) + "event: content_block_delta\ndata: {not json\n\n"), {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const { error } = await drain(llm);
    expect(error).toMatchObject({ name: "LlmError", kind: "unknown" });
  });
});

describe("createAnthropicCompatibleLlm: abort", () => {
  /** Behaves like real fetch: sends the first events, then holds the body open until the signal aborts it. */
  function hangingFetch() {
    let seenSignal: AbortSignal | undefined;
    const fake = fakeFetch(({ init }) => {
      const signal = init.signal ?? undefined;
      seenSignal = signal;
      if (signal?.aborted) throw signal.reason;
      const head = new TextEncoder().encode(sseText([messageStart(), blockStart(1, "text"), text("Hi")]));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(head);
          signal?.addEventListener("abort", () => controller.error(signal.reason));
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    return { ...fake, signal: () => seenSignal };
  }

  it("passes the signal to fetch; aborting mid-stream ends with the AbortError, not an LlmError", async () => {
    const fake = hangingFetch();
    const llm = createAnthropicCompatibleLlm({ profile: BEARER_PROFILE, apiKey: "k", fetch: fake.fetch });
    const controller = new AbortController();
    const chunks: LlmChunk[] = [];
    const iterate = async () => {
      for await (const c of llm.stream(REQUEST, controller.signal)) {
        chunks.push(c);
        controller.abort();
      }
    };
    const error = await iterate().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(fake.signal()).toBe(controller.signal);
    expect(fake.signal()?.aborted).toBe(true);
    expect(chunks).toEqual([{ t: "text", text: "Hi" }]);
    expect(error).not.toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ name: "AbortError" });
  });

  it("an already-aborted signal rejects with the AbortError", async () => {
    const fake = hangingFetch();
    const llm = createAnthropicCompatibleLlm({ profile: BEARER_PROFILE, apiKey: "k", fetch: fake.fetch });
    const { error } = await drain(llm, AbortSignal.abort());
    expect(error).not.toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ name: "AbortError" });
  });
});
