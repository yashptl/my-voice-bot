import WebSocket from "ws";
import type { Connect, SocketLike } from "../ports/websocket";

const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Workers: an outbound WebSocket is a `fetch` with `Upgrade: websocket` (https URL), then `accept()`.
 * `binaryType` is set before `accept()` because it defaults to "blob" from compat date 2026-03-17.
 */
export const connectWorker: Connect = async (url, headers) => {
  const resp = await fetch(url.replace(/^ws(s?):/, "http$1:"), { headers: { Upgrade: "websocket", ...headers } });
  const ws = resp.webSocket;
  if (!ws) {
    const body = (await resp.text().catch(() => "")).slice(0, 200);
    throw new Error(`WebSocket upgrade to ${new URL(url).host} failed: HTTP ${resp.status}${body ? ` ${body}` : ""}`);
  }
  ws.binaryType = "arraybuffer";
  ws.accept();
  return ws;
};

type EventType = "message" | "close" | "error";

/**
 * `ws` parses a frame that arrived together with the upgrade response before the caller's `await`
 * resumes, so that first frame (MiniMax's `connected_success`) would reach no listener. Events are
 * held until a macrotask after open, then replayed in order to the listeners attached by then; this
 * matches browsers and Workers, which dispatch socket events as tasks.
 */
function holdEarlyEvents(ws: WebSocket): { socket: SocketLike; release(): void } {
  const fns: Record<EventType, ((e: unknown) => void)[]> = { message: [], close: [], error: [] };
  let held: [EventType, unknown][] | null = [];
  const dispatch = (type: EventType, e: unknown) => {
    for (const fn of fns[type]) fn(e);
  };
  for (const type of ["message", "close", "error"] as const) {
    ws.addEventListener(type, (e: unknown) => (held ? held.push([type, e]) : dispatch(type, e)));
  }
  return {
    socket: {
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
      addEventListener: (type, fn) => void fns[type].push(fn),
    },
    release() {
      const early = held ?? [];
      held = null;
      for (const [type, e] of early) dispatch(type, e);
    },
  };
}

/** Node (probes): the `ws` package, which can send upgrade headers. Throws in the Worker build (browser stub). */
export const connectNode: Connect = (url, headers) =>
  new Promise<SocketLike>((resolve, reject) => {
    const ws = new WebSocket(url, { headers, handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
    ws.binaryType = "arraybuffer";
    const { socket, release } = holdEarlyEvents(ws);
    ws.once("open", () => {
      resolve(socket);
      setTimeout(release, 0);
    });
    ws.once("error", reject);
  });
