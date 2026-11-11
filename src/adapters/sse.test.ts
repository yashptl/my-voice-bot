import { describe, expect, it } from "vitest";
import { parseSse } from "./sse";

/** A body that delivers `bytes` in chunks of `size`, so boundaries land mid-line, mid-event and mid-character. */
function bodyOf(text: string, size = Number.POSITIVE_INFINITY): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      const end = Math.min(bytes.length, offset + size);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<{ event: string; data: string }[]> {
  const out: { event: string; data: string }[] = [];
  for await (const e of parseSse(body)) out.push(e);
  return out;
}

const SCRIPT =
  "event: message_start\n" +
  'data: {"type":"message_start"}\n' +
  "\n" +
  ": a comment line\n" +
  "event: ping\n" +
  'data: {"type": "ping"}\n' +
  "\n" +
  "event: content_block_delta\n" +
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Yash ✓ ships — 🚀"}}\n' +
  "\n" +
  "event: message_stop\n" +
  'data: {"type":"message_stop"}\n' +
  "\n";

const EXPECTED = [
  { event: "message_start", data: '{"type":"message_start"}' },
  {
    event: "content_block_delta",
    data: '{"type":"content_block_delta","delta":{"type":"text_delta","text":"Yash ✓ ships — 🚀"}}',
  },
  { event: "message_stop", data: '{"type":"message_stop"}' },
];

describe("parseSse", () => {
  it("yields event/data pairs and skips comments and ping", async () => {
    expect(await collect(bodyOf(SCRIPT))).toEqual(EXPECTED);
  });

  it("gives the same events for every chunk size, including splits inside multi-byte characters", async () => {
    for (let size = 1; size <= 40; size++) {
      expect(await collect(bodyOf(SCRIPT, size)), `chunk size ${size}`).toEqual(EXPECTED);
    }
  });

  it("joins multi-line data with newlines and strips only one leading space", async () => {
    const text = "event: x\ndata: line one\ndata:  indented\ndata:\n\n";
    expect(await collect(bodyOf(text))).toEqual([{ event: "x", data: "line one\n indented\n" }]);
  });

  it("names events without an event field 'message'", async () => {
    expect(await collect(bodyOf("data: hello\n\n"))).toEqual([{ event: "message", data: "hello" }]);
  });

  it("accepts CRLF and CR line endings, including a CRLF split across chunks", async () => {
    const text = "event: a\r\ndata: one\r\ndata: two\r\n\r\nevent: b\rdata: three\r\r";
    const expected = [
      { event: "a", data: "one\ntwo" },
      { event: "b", data: "three" },
    ];
    for (let size = 1; size <= text.length; size++) {
      expect(await collect(bodyOf(text, size)), `chunk size ${size}`).toEqual(expected);
    }
  });

  it("does not dispatch an event with no data lines", async () => {
    expect(await collect(bodyOf("event: lonely\n\nid: 3\nretry: 10\n\n"))).toEqual([]);
  });

  it("flushes a final event that lacks the trailing blank line", async () => {
    expect(await collect(bodyOf("event: message_stop\ndata: {}"))).toEqual([{ event: "message_stop", data: "{}" }]);
  });

  it("cancels the body when the consumer stops early", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const e of parseSse(body)) {
      expect(e.data).toBe("first");
      break;
    }
    expect(cancelled).toBe(true);
  });

  it("propagates a body error", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        controller.error(new Error("connection reset"));
      },
    });
    await expect(collect(body)).rejects.toThrow("connection reset");
  });
});
