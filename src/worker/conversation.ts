import { DurableObject } from "cloudflare:workers";
import type { z } from "zod";
import bundle from "../../knowledge/bundle.json" with { type: "json" };
import { buildStable, promptHash } from "../core/prompt";
import { sanitizeInput } from "../core/sanitize";
import { ChatRequestSchema, MAX_BODY_BYTES, tokenFromAuthorization } from "../protocol/chat";
import { parseClientMessage, type ServerEvent } from "../protocol/events";
import { encodeSse } from "../protocol/sse";
import type { TurnRecord } from "../protocol/turn-record";
import { WS_SUBPROTOCOL } from "../protocol/version";
import { parseToken, tokenFromProtocols, verifySecret } from "./auth";
import { ConversationState, type Log } from "./conversation-state";
import type { Env } from "./env";
import { spendTurn } from "./ledger";
import { buildProviders } from "./providers";
import { textTurn } from "./text-turn";
import { recordTurn, type TurnSource } from "./turn-log";
import { VOICE_IDLE_CLOSE_MS, VoiceLoop } from "./voice-loop";

/** Client JSON messages are tiny; anything bigger is refused without parsing. */
const MAX_TEXT_FRAME = 4096;
/** How long a conversation is kept after its session expires (the 30-day promise in 0002). */
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** A request's JSON body checked against `schema`; null when it is too big, not JSON or invalid. */
export async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T | null> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  const body = await readCapped(request, MAX_BODY_BYTES);
  if (!body) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(body)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The body's bytes, or null once they pass `max` (or the body fails). Read chunk by chunk and
 * cancelled at the cap: a chunked upload has no content-length to check first, and buffering it
 * whole could take tens of MB of the isolate's memory before the size check.
 */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

/**
 * One conversation. Holds the token's secret hash, expiry and source (from `init`) and the
 * ConversationState (meter, turn count, history) that voice sockets and text answers share. Voice:
 * one socket at a time, a new one replaces the old; turn logic lives in VoiceLoop. Text:
 * `POST /assistant/chat` streams one answer at a time as server-sent events (textTurn). Every
 * answer first spends one of the day's shared turns (ledger.ts), and once it ends its TurnRecord
 * goes to the turn log in D1 (turn-log.ts). A storage alarm deletes everything RETENTION_MS after
 * the session expires.
 */
export class Conversation extends DurableObject<Env> {
  private state: Promise<ConversationState> | null = null;
  private live: { socket: WebSocket; loop: VoiceLoop } | null = null;
  /** A text answer is streaming; another one gets 409 busy until it ends. */
  private answering = false;
  private hash: Promise<string> | null = null;

  /** `source` tags this conversation's rows in the turn log: the canary passes "canary". */
  async init(secretHash: string, expiresAt: number, source: TurnSource = "visitor"): Promise<void> {
    await this.ctx.storage.put({ secretHash, expiresAt, source });
    await this.ctx.storage.setAlarm(expiresAt + RETENTION_MS);
  }

  async alarm(): Promise<void> {
    const live = this.live;
    this.live = null;
    live?.loop.close();
    closeQuietly(live?.socket, 1000, "conversation deleted");
    this.state = null;
    await this.ctx.storage.deleteAll();
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/assistant/chat") return this.chat(request);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const conversationId = await this.authorize(tokenFromProtocols(request.headers.get("Sec-WebSocket-Protocol")));
    if (!conversationId) return new Response("Unauthorized", { status: 401 });

    const log = logFor(conversationId);
    const providers = buildProviders(this.env);
    const state = await this.loadState(log);
    const pair = new WebSocketPair();
    const client = pair[0];
    const socket = pair[1];
    socket.binaryType = "arraybuffer";
    socket.accept();

    const send = (e: ServerEvent | ArrayBuffer) => {
      try {
        socket.send(e instanceof ArrayBuffer ? e : JSON.stringify(e));
      } catch {
        // The socket is closing; its close event cleans up.
      }
    };
    const loop = new VoiceLoop({
      conversationId,
      stt: providers.stt,
      llm: providers.llm,
      prices: providers.prices,
      tts: providers.tts,
      bundle,
      send,
      now: () => Date.now(),
      state,
      spendTurn: () => spendTurn(this.env, log),
      closeSocket: (code, reason) => closeQuietly(socket, code, reason),
      idleCloseMs: VOICE_IDLE_CLOSE_MS,
      log,
      onRecord: (record) => this.logTurn(record, log),
    });

    const previous = this.live;
    this.live = { socket, loop };
    if (previous) {
      previous.loop.close();
      closeQuietly(previous.socket, 4000, "replaced by a newer connection");
    }

    socket.addEventListener("message", (e: MessageEvent) => {
      if (typeof e.data !== "string") return loop.onAudio(e.data as ArrayBuffer);
      const message = e.data.length <= MAX_TEXT_FRAME ? parseClientMessage(e.data) : null;
      if (message) loop.onMessage(message);
      else send({ type: "error", code: "protocol", message: "Unknown message." });
    });
    const closed = () => {
      loop.close();
      if (this.live?.loop === loop) this.live = null;
      state.flush();
    };
    socket.addEventListener("close", closed);
    socket.addEventListener("error", closed);

    loop.start().catch((err: unknown) => {
      log("error", `start failed: ${err instanceof Error ? err.message : String(err)}`);
      send({ type: "error", code: "internal", message: "The assistant could not start." });
      loop.close();
      closeQuietly(socket, 1011, "start failed");
    });

    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": WS_SUBPROTOCOL } });
  }

  /**
   * One text answer, streamed as server-sent events. Checks in order: token (401), body (400), an
   * answer already streaming (409), the conversation's turns (429), the day's shared turns (503).
   * The answer stops, and stops costing, when the visitor aborts the request or the response
   * stream is cancelled; history then keeps only the sentences already sent.
   */
  private async chat(request: Request): Promise<Response> {
    const conversationId = await this.authorize(tokenFromAuthorization(request.headers.get("Authorization")));
    if (!conversationId) return json({ error: "auth" }, 401);
    const body = await readJson(request, ChatRequestSchema);
    if (!body || !sanitizeInput(body.message).trim()) return json({ error: "bad_request" }, 400);
    // Set before the next await, so a double send cannot slip in while this one is checked.
    if (this.answering) return json({ error: "busy" }, 409);
    this.answering = true;
    let streaming = false;
    try {
      const log = logFor(conversationId);
      const providers = buildProviders(this.env);
      const hash = await (this.hash ??= promptHash(buildStable(bundle)));
      const state = await this.loadState(log);
      if (!state.startTurn()) return json({ error: "limit" }, 429);
      if (!(await spendTurn(this.env, log))) return json({ error: "resting" }, 503);

      const stop = new AbortController();
      const events = textTurn({
        conversationId,
        llm: providers.llm,
        prices: providers.prices,
        bundle,
        promptHash: hash,
        state,
        message: body.message,
        signal: AbortSignal.any([request.signal, stop.signal]),
        now: () => Date.now(),
        log,
        onRecord: (record) => this.logTurn(record, log),
      });
      const encoder = new TextEncoder();
      // Pushed, not pulled: the turn runs to its end (or its deadline) whatever the reader does,
      // so `answering` always clears.
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          const send = (e: ServerEvent) => {
            try {
              controller.enqueue(encoder.encode(encodeSse(e)));
            } catch {
              // Cancelled: the abort below has already ended the turn.
            }
          };
          void (async () => {
            try {
              for await (const e of events) send(e);
            } catch (err) {
              log("error", `text turn failed: ${err instanceof Error ? err.message : String(err)}`);
              send({ type: "error", code: "internal", message: "The assistant could not finish that answer." });
            } finally {
              this.answering = false;
              try {
                controller.close();
              } catch {
                // Already cancelled.
              }
            }
          })();
        },
        cancel: () => stop.abort(),
      });
      streaming = true;
      return new Response(stream, {
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
      });
    } finally {
      if (!streaming) this.answering = false;
    }
  }

  /**
   * Writes a finished turn's record to the turn log without waiting for it, so the visitor's stream
   * is never held up. A failure is logged (the record holds no visitor text) and the turn stands.
   */
  private logTurn(record: TurnRecord, log: Log): void {
    const at = Date.now();
    void (async () => {
      const source: TurnSource = (await this.ctx.storage.get("source")) === "canary" ? "canary" : "visitor";
      await recordTurn(this.env.DB, record, at, source);
    })().catch((err: unknown) => {
      log("error", `turn log failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** The conversation id when the token's secret matches and the session has not expired. */
  private async authorize(token: string | null): Promise<string | null> {
    const parsed = parseToken(token ?? "");
    if (!parsed) return null;
    const stored = await this.ctx.storage.get(["secretHash", "expiresAt"]);
    const secretHash = stored.get("secretHash");
    const expiresAt = stored.get("expiresAt");
    if (typeof secretHash !== "string" || typeof expiresAt !== "number" || Date.now() >= expiresAt) return null;
    return (await verifySecret(parsed.secret, secretHash)) ? parsed.conversationId : null;
  }

  /** Loaded once per object and shared by every socket; a failed load is retried by the next socket. */
  private loadState(log: Log): Promise<ConversationState> {
    this.state ??= ConversationState.load({ storage: this.ctx.storage, now: () => Date.now(), log }).catch((err: unknown) => {
      this.state = null;
      throw err;
    });
    return this.state;
  }
}

/** Operational lines tagged with the conversation; never visitor text or keys. */
function logFor(conversationId: string): Log {
  return (level, line) => console[level](`conversation ${conversationId.slice(0, 8)}: ${line}`);
}

function closeQuietly(socket: WebSocket | undefined, code: number, reason: string): void {
  try {
    socket?.close(code, reason);
  } catch {
    // Already closed.
  }
}
