import type { ChatRequest, SessionRequest, SessionResponse } from "../protocol/chat";
import type { ErrorCode, RestingReason, ServerEvent } from "../protocol/events";
import { SseParser } from "../protocol/sse";
import { PROTOCOL_VERSION } from "../protocol/version";

export type HttpErrorCode = ErrorCode | "off" | "bad_request" | "unknown";

/** The `error` values a client acts on; anything else is "unknown". */
const KNOWN_CODES = new Set<string>(["limit", "resting", "busy", "auth", "rate_limited", "bad_request", "off"]);

/**
 * A non-200 reply from `/session` or `/chat`, with the server's `error` mapped to a code the UI can
 * branch on. `reason` is set (never null) only for code "resting".
 */
export class AssistantHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: HttpErrorCode,
    detail: string | null,
    readonly reason: RestingReason | null = null,
  ) {
    super(`assistant replied HTTP ${status}${detail ? ` (${detail})` : ""}`);
    this.name = "AssistantHttpError";
  }
}

/** The server and this client speak different protocol versions: the page needs a reload. */
export class OutdatedError extends Error {
  constructor(readonly server: number) {
    super(`server speaks protocol ${server}, this client ${PROTOCOL_VERSION}`);
    this.name = "OutdatedError";
  }
}

/**
 * Opens a conversation (`POST <baseUrl>/session`) with a Turnstile token. `baseUrl` names the folder
 * the routes live in, absolute or relative to the page (fetch resolves it), like assistantUrls.
 */
export async function startSession(o: { baseUrl: string; turnstile: string; fetch?: typeof fetch }): Promise<SessionResponse> {
  const doFetch = o.fetch ?? fetch; // a local, so window.fetch is never called as a method of `o`
  const request: SessionRequest = { turnstile: o.turnstile };
  const res = await doFetch(endpoint(o.baseUrl, "session"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) throw await httpError(res);
  const session: unknown = await res.json().catch(() => null);
  // The version first: another version's reply may have another shape, and the fix is a reload.
  if (isRecord(session) && typeof session.protocol === "number" && session.protocol !== PROTOCOL_VERSION) {
    throw new OutdatedError(session.protocol);
  }
  if (!isSessionResponse(session)) throw new Error("session response is malformed");
  return session;
}

/**
 * Asks one question (`POST <baseUrl>/chat`) and hands each ServerEvent to `onEvent` as it streams in;
 * resolves when the stream ends. A non-200 reply throws AssistantHttpError. Aborting `signal`
 * cancels the stream (the server then stops the model) and rejects with the signal's AbortError;
 * no event is delivered after it.
 */
export async function ask(o: {
  baseUrl: string;
  token: string;
  message: string;
  signal?: AbortSignal;
  onEvent(e: ServerEvent): void;
  fetch?: typeof fetch;
}): Promise<void> {
  const { signal } = o;
  signal?.throwIfAborted();
  const doFetch = o.fetch ?? fetch;
  const request: ChatRequest = { message: o.message };
  const res = await doFetch(endpoint(o.baseUrl, "chat"), {
    method: "POST",
    headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!res.ok) throw await httpError(res);
  if (!res.body || !res.headers.get("content-type")?.startsWith("text/event-stream")) {
    throw new Error("chat reply is not an event stream");
  }

  const reader = res.body.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted(); // a cancel ends a pending read as if the stream were done
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        signal?.throwIfAborted(); // onEvent may have aborted (Stop) mid-chunk
        o.onEvent(event);
      }
    }
    for (const event of parser.push(decoder.decode())) o.onEvent(event);
  } catch (err) {
    cancel();
    throw err;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

/** `<baseUrl>/<name>`, treating `baseUrl` as a folder with or without its trailing slash. */
function endpoint(baseUrl: string, name: "session" | "chat"): string {
  return `${baseUrl.replace(/\/+$/, "")}/${name}`;
}

async function httpError(res: Response): Promise<AssistantHttpError> {
  const body: unknown = await res.json().catch(() => null);
  const error = isRecord(body) && typeof body.error === "string" ? body.error : null;
  const code: HttpErrorCode = error !== null && KNOWN_CODES.has(error) ? (error as HttpErrorCode) : "unknown";
  const reason = code === "resting" ? restingReason(isRecord(body) ? body.reason : undefined) : null;
  return new AssistantHttpError(res.status, code, error, reason);
}

/** A missing or unrecognised reason reads as an outage, the one that does not promise tomorrow. */
export function restingReason(x: unknown): RestingReason {
  return x === "ceiling" || x === "visitor" ? x : "outage";
}

function isSessionResponse(x: unknown): x is SessionResponse {
  return (
    isRecord(x) &&
    typeof x.token === "string" &&
    typeof x.protocol === "number" &&
    (x.mode === "voice" || x.mode === "text" || x.mode === "off") &&
    typeof x.expiresAt === "number" &&
    (x.resting === null || x.resting === "ceiling" || x.resting === "visitor" || x.resting === "outage")
  );
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}
