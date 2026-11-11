import { LlmError, type LlmChunk, type LlmErrorKind, type LlmPort, type LlmRequest } from "../ports/llm";
import type { LlmProfile } from "./llm-profiles";
import { parseSse } from "./sse";

const ANTHROPIC_VERSION = "2023-06-01";
/** Provider error text is kept short; it is diagnostics, not content. */
const MAX_ERROR_DETAIL = 300;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * An `LlmPort` over any Anthropic Messages-compatible endpoint (MiniMax's `/anthropic`, Anthropic itself),
 * using plain `fetch` + SSE so it runs unchanged in Workers and Node. No retries: the caller owns latency.
 *
 * - Thinking text never leaves this function: the first thinking block surfaces as one content-free
 *   `{ t: "reasoning" }` tick, and its characters only feed the reasoning-token estimate.
 * - A reply that finishes with no answer text (typically `stop_reason: "max_tokens"` because thinking used
 *   the whole budget) yields its usage and then throws `LlmError` kind `empty`, so it can never be silence.
 * - Aborting `signal` rejects with the platform's AbortError, never an `LlmError`.
 */
export function createAnthropicCompatibleLlm(o: { profile: LlmProfile; apiKey: string; fetch?: typeof fetch }): LlmPort {
  const { profile, apiKey } = o;
  const doFetch: Fetch = o.fetch ?? ((url, init) => fetch(url, init));
  return {
    id: profile.id,
    model: profile.model,
    stream: (req, signal) => streamMessages(profile, apiKey, doFetch, req, signal),
  };
}

async function* streamMessages(
  profile: LlmProfile,
  apiKey: string,
  doFetch: Fetch,
  req: LlmRequest,
  signal: AbortSignal | undefined,
): AsyncIterable<LlmChunk> {
  const body = requestBody(profile, req);
  let res: Response;
  try {
    res = await doFetch(`${profile.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: requestHeaders(profile, apiKey),
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    throw asStreamError(profile, error, signal);
  }

  const contentType = res.headers.get("content-type");
  if (!res.ok || !res.body || (contentType !== null && !contentType.includes("text/event-stream"))) {
    throw await responseError(profile, res);
  }

  let reasoningSent = false;
  let thinkingChars = 0;
  let textChunks = 0;
  let stopped = false;
  let input = 0;
  let cachedInput = 0;
  let output = 0;
  let model = profile.model;
  let stopReason: string | null = null;

  try {
    for await (const sse of parseSse(res.body)) {
      signal?.throwIfAborted();
      const data = parseEvent(profile, sse.data);
      const type = typeof data.type === "string" ? data.type : sse.event;
      if (type === "message_start") {
        const usage = data.message?.usage;
        input = count(usage?.input_tokens, input);
        cachedInput = count(usage?.cache_read_input_tokens, cachedInput);
        output = count(usage?.output_tokens, output);
        model = str(data.message?.model) ?? model;
      } else if (type === "content_block_start" || type === "content_block_delta") {
        const part = type === "content_block_start" ? data.content_block : data.delta;
        const kind = part?.type;
        if (kind === "thinking" || kind === "redacted_thinking" || kind === "thinking_delta") {
          thinkingChars += str(part?.thinking)?.length ?? 0;
          if (!reasoningSent) yield { t: "reasoning" };
          reasoningSent = true;
        } else if (kind === "text" || kind === "text_delta") {
          const piece = str(part?.text);
          if (piece) {
            textChunks++;
            yield { t: "text", text: piece };
          }
        }
      } else if (type === "message_delta") {
        stopReason = str(data.delta?.stop_reason) ?? stopReason;
        input = count(data.usage?.input_tokens, input);
        cachedInput = count(data.usage?.cache_read_input_tokens, cachedInput);
        output = count(data.usage?.output_tokens, output);
      } else if (type === "error") {
        const kind = errorKind(undefined, str(data.error?.type));
        throw new LlmError(kind, `${profile.id}: stream error: ${detail(data.error?.message)}`);
      } else if (type === "message_stop") {
        stopped = true;
        break; // Anything after message_stop (e.g. a "[DONE]" sentinel) is not ours to parse.
      }
    }
  } catch (error) {
    throw asStreamError(profile, error, signal);
  }

  if (!stopped) throw new LlmError("network", `${profile.id}: stream ended before message_stop`);

  yield {
    t: "usage",
    usage: {
      input,
      cachedInput,
      output,
      reasoning: Math.ceil(thinkingChars / 4),
      reasoningEstimated: true,
      model,
      stopReason,
    },
  };

  if (textChunks === 0) {
    throw new LlmError(
      "empty",
      stopReason === "max_tokens"
        ? `${profile.id}: stop_reason max_tokens before any answer text (thinking used the budget)`
        : `${profile.id}: reply had no answer text (stop_reason ${stopReason ?? "none"})`,
    );
  }
}

function requestHeaders(profile: LlmProfile, apiKey: string): Record<string, string> {
  const auth: Record<string, string> =
    profile.auth === "bearer" ? { authorization: `Bearer ${apiKey}` } : { "x-api-key": apiKey };
  return { ...auth, "content-type": "application/json", "anthropic-version": ANTHROPIC_VERSION };
}

function requestBody(profile: LlmProfile, req: LlmRequest): Record<string, unknown> {
  const last = req.turns.at(-1);
  if (!last || last.role !== "user") {
    throw new LlmError("bad_request", `${profile.id}: turns must end with a user turn`);
  }
  // Empty text blocks are a 400 on the Messages API, so drop them (an interrupted reply can be empty).
  const history = req.turns.slice(0, -1).filter((turn) => turn.text !== "");
  const lastContent = [req.tail, last.text].filter((t) => t !== "").map((t) => ({ type: "text", text: t }));
  return {
    ...profile.extraBody,
    model: profile.model,
    max_tokens: req.maxTokens,
    stream: true,
    system: profile.cacheSystem
      ? [{ type: "text", text: req.stable, cache_control: { type: "ephemeral" } }]
      : req.stable,
    messages: [
      ...history.map((turn) => ({ role: turn.role, content: turn.text })),
      { role: "user", content: lastContent },
    ],
  };
}

function parseEvent(profile: LlmProfile, data: string): StreamEvent {
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed !== null && typeof parsed === "object") return parsed as StreamEvent;
  } catch {
    // fall through
  }
  throw new LlmError("unknown", `${profile.id}: stream event is not a JSON object`);
}

/** Abort passes through untouched; LlmErrors pass through; anything else is a transport failure. */
function asStreamError(profile: LlmProfile, error: unknown, signal: AbortSignal | undefined): unknown {
  if (error instanceof LlmError || signal?.aborted || isAbortError(error)) return error;
  return new LlmError("network", `${profile.id}: connection failed`, { cause: error });
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

async function responseError(profile: LlmProfile, res: Response): Promise<LlmError> {
  const raw = await res.text().catch(() => "");
  let type: string | undefined;
  let message = raw;
  try {
    const parsed = JSON.parse(raw) as {
      error?: { type?: unknown; message?: unknown };
      base_resp?: { status_msg?: unknown };
      message?: unknown;
    };
    type = typeof parsed.error?.type === "string" ? parsed.error.type : undefined;
    const candidate = parsed.error?.message ?? parsed.base_resp?.status_msg ?? parsed.message;
    if (typeof candidate === "string") message = candidate;
  } catch {
    // Not JSON: keep the raw text.
  }
  const status = res.ok ? undefined : res.status;
  const label = res.ok ? `HTTP ${res.status} without an event stream` : `HTTP ${res.status}`;
  return new LlmError(errorKind(status, type), `${profile.id}: ${label}: ${detail(message)}`, { status: res.status });
}

function errorKind(status: number | undefined, type: string | undefined): LlmErrorKind {
  if (status === 401 || status === 403 || type === "authentication_error" || type === "permission_error") return "auth";
  if (status === 429 || type === "rate_limit_error") return "rate_limit";
  if (status === 529 || status === 503 || type === "overloaded_error") return "overloaded";
  if ((status !== undefined && status >= 400 && status < 500) || type === "invalid_request_error") return "bad_request";
  return "unknown";
}

/** A non-empty string, or undefined. Provider events are untrusted, so every field is checked before use. */
function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function count(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

function detail(message: unknown): string {
  const text = typeof message === "string" && message.trim() !== "" ? message.trim() : "no details";
  return text.length > MAX_ERROR_DETAIL ? `${text.slice(0, MAX_ERROR_DETAIL)}…` : text;
}

/** The subset of Messages API stream events this adapter reads; everything is optional because it is untrusted. */
interface StreamEvent {
  type?: unknown;
  message?: { model?: unknown; usage?: Usage };
  content_block?: ContentPart;
  delta?: ContentPart & { stop_reason?: unknown };
  usage?: Usage;
  error?: { type?: unknown; message?: unknown };
}

/** A `content_block_start` block or a `content_block_delta` delta. */
interface ContentPart {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
}

interface Usage {
  input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  output_tokens?: unknown;
}
