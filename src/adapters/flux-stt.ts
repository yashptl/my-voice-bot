import type { SttEvent, SttEventType, SttPort, SttSession } from "../ports/stt";
import type { SocketLike } from "../ports/websocket";
import { MIC_FORMAT } from "../protocol/audio";

const MODEL = "@cf/deepgram/flux";

const EVENTS: Record<string, SttEventType> = {
  Update: "update",
  StartOfTurn: "start",
  EagerEndOfTurn: "eager",
  TurnResumed: "resumed",
  EndOfTurn: "end",
};

/** The Workers WebSocket from `env.AI.run(..., { websocket: true })`. */
type FluxSocket = SocketLike & { accept(): void; binaryType: string };
type FluxResponse = { status: number; webSocket?: FluxSocket | null; text(): Promise<string> };
type FluxRun = (model: string, inputs: Record<string, unknown>, options: { websocket: true }) => Promise<unknown>;

const INERT: SttSession = { send() {}, close() {} };

const asMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Frame = { event?: unknown; transcript?: unknown; turn_index?: unknown; type?: unknown; code?: unknown; description?: unknown };

function parseFrame(data: unknown): Frame | null {
  if (typeof data !== "string") return null;
  try {
    const value: unknown = JSON.parse(data);
    return value !== null && typeof value === "object" ? (value as Frame) : null;
  } catch {
    return null;
  }
}

/** A turn frame (detected by `event`, as Cloudflare's schema has no `type`), or null for any other shape. */
function toSttEvent(f: Frame): SttEvent | null {
  const type = typeof f.event === "string" ? EVENTS[f.event] : undefined;
  if (!type) return null;
  if (f.transcript !== undefined && typeof f.transcript !== "string") return null;
  return {
    type,
    transcript: f.transcript ?? "",
    turnIndex: typeof f.turn_index === "number" ? f.turn_index : 0,
  };
}

/**
 * Deepgram Flux on Workers AI (English, linear16 at 16 kHz). Failures, including a refused upgrade
 * (say, 429 AiError 3040), go to `onError` with the HTTP status and body; `open()` then resolves to a
 * session that ignores everything. `onClose` fires only when Flux closes the socket, not after
 * `close()`. Flux fatal-error frames (`type: "Error"`) also go to `onError`; other non-turn frames
 * (Connected, Warning) are ignored.
 *
 * `keyterm` is passed as an array, as Cloudflare's own agents SDK does (`agents/voice`
 * WorkersAIFluxSTT); the binding JSON-encodes the inputs.
 */
export function createFluxStt(o: {
  ai: Ai;
  /** Default "0.7". */
  eotThreshold?: string;
  /** Default "0.5"; enables EagerEndOfTurn and TurnResumed. */
  eagerEotThreshold?: string;
  /** Default "5000". */
  eotTimeoutMs?: string;
}): SttPort {
  // Untyped here: the binding's types take `keyterm` as one string, but it accepts an array.
  const ai = o.ai as unknown as { run: FluxRun };

  return {
    id: "flux",
    async open(cb): Promise<SttSession> {
      const inputs: Record<string, unknown> = {
        encoding: "linear16",
        sample_rate: String(MIC_FORMAT.sampleRate),
        eot_threshold: o.eotThreshold ?? "0.7",
        eager_eot_threshold: o.eagerEotThreshold ?? "0.5",
        eot_timeout_ms: o.eotTimeoutMs ?? "5000",
        ...(cb.keyterms.length ? { keyterm: [...cb.keyterms] } : {}),
        mip_opt_out: "true",
      };

      let resp: FluxResponse;
      try {
        resp = (await ai.run(MODEL, inputs, { websocket: true })) as FluxResponse;
      } catch (e) {
        cb.onError(new Error(`Flux connection failed: ${asMessage(e)}`));
        return INERT;
      }
      const ws = resp.webSocket;
      if (!ws) {
        const body = (await resp.text().catch(() => "")).slice(0, 300);
        cb.onError(new Error(`Flux WebSocket upgrade failed: HTTP ${resp.status}${body ? ` ${body}` : ""}`));
        return INERT;
      }

      ws.binaryType = "arraybuffer";
      ws.accept();
      let closed = false;

      ws.addEventListener("message", (e: { data?: unknown }) => {
        if (closed) return;
        const f = parseFrame(e?.data);
        if (!f) return;
        if (f.type === "Error") {
          cb.onError(new Error(`Flux error ${String(f.code ?? "unknown")}: ${String(f.description ?? "").slice(0, 200)}`));
          return;
        }
        const event = toSttEvent(f);
        if (event) cb.onEvent(event);
      });
      ws.addEventListener("close", () => {
        if (closed) return;
        closed = true;
        cb.onClose();
      });
      ws.addEventListener("error", (e: { message?: string }) => {
        if (!closed) cb.onError(new Error(`Flux socket error${e?.message ? `: ${e.message}` : ""}`));
      });

      return {
        send(frame) {
          if (closed) return;
          try {
            ws.send(frame);
          } catch {
            // The socket is closing; its close event reports it.
          }
        },
        close() {
          if (closed) return;
          closed = true;
          try {
            ws.close(1000, "done");
          } catch {
            // Already closed.
          }
        },
      };
    },
  };
}
