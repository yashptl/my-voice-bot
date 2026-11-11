/** One dispatched Server-Sent Event. `event` defaults to "message" when the server names none. */
export interface SseEvent {
  event: string;
  data: string;
}

const LINE_BREAK = /\r\n|\r|\n/;

/**
 * Parses a `text/event-stream` body (WHATWG rules: CRLF/CR/LF lines, `:` comments, multi-line
 * `data`, one optional space after the colon). Skips `ping` events, which carry nothing.
 * Chunk boundaries may fall anywhere, including inside a UTF-8 character or a CRLF pair.
 * A final event without its trailing blank line is still dispatched. Stopping early cancels the body.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let finished = false;

  const dispatch = (): SseEvent | null => {
    const out = data.length > 0 && event !== "ping" ? { event: event || "message", data: data.join("\n") } : null;
    event = "";
    data = [];
    return out;
  };

  const take = (line: string): SseEvent | null => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    return null;
  };

  try {
    while (!finished) {
      const { done, value } = await reader.read();
      finished = done;
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // A trailing CR may be the first half of a CRLF; hold it until the next chunk arrives.
      const hold = !done && buffer.endsWith("\r");
      const lines = (hold ? buffer.slice(0, -1) : buffer).split(LINE_BREAK);
      buffer = (lines.pop() ?? "") + (hold ? "\r" : "");
      if (done && buffer !== "") lines.push(buffer);
      if (done) lines.push("");
      for (const line of lines) {
        const e = take(line);
        if (e) yield e;
      }
    }
  } finally {
    if (finished) reader.releaseLock();
    else await reader.cancel().catch(() => undefined);
  }
}
