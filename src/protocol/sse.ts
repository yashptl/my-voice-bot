import type { ServerEvent } from "./events";

/** One ServerEvent as a server-sent event: `event: <type>` and one `data:` line of JSON. */
export function encodeSse(e: ServerEvent): string {
  return `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
}

/** A comment line, ignored by parsers; sent to keep a quiet stream open through proxies. */
export const SSE_KEEPALIVE = ": keepalive\n\n";

const KNOWN = new Set<string>([
  "ready",
  "state",
  "transcript",
  "turn.start",
  "sentence",
  "meta",
  "sources",
  "turn.end",
  "turn.interrupted",
  "stt",
  "error",
]);

/**
 * Incremental parser for the stream `encodeSse` writes. Feed it decoded text in any chunking; it
 * returns each complete event once. Comments, events without data, data that is not a JSON object
 * with a known `type`, and fields other than `data` are skipped. Handles `\n` and `\r\n`.
 */
export class SseParser {
  private buffer = "";

  push(chunk: string): ServerEvent[] {
    this.buffer += chunk;
    const out: ServerEvent[] = [];
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buffer);
      if (!m) break;
      const block = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      const event = parseBlock(block);
      if (event) out.push(event);
    }
    return out;
  }
}

function parseBlock(block: string): ServerEvent | null {
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
  }
  if (data.length === 0) return null;
  let json: unknown;
  try {
    json = JSON.parse(data.join("\n"));
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const type = (json as { type?: unknown }).type;
  return typeof type === "string" && KNOWN.has(type) ? (json as ServerEvent) : null;
}
