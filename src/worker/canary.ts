import { SseParser } from "../protocol/sse";
import type { TurnRecord } from "../protocol/turn-record";
import { mintToken } from "./auth";
import type { Env } from "./env";

export const CANARY_QUESTION = "Where does Yash work now?";

/** The canary's session; it needs one answer. Its conversation is deleted on the usual schedule. */
const CANARY_SESSION_MS = 5 * 60_000;

export interface CanaryResult {
  ok: boolean;
  ms: number;
  /** Why it failed: status codes, event types and record errors only, never answer text. */
  reason: string | null;
}

/**
 * One real question through the path visitors use: a new conversation and token, then
 * `POST /assistant/chat` to its object, read as server-sent events. No special headers or
 * bypasses, so it spends one of the day's turns like any visitor; only its turn log rows differ,
 * tagged `source = 'canary'` through `init`. Ok when the answer had at least one sentence, a meta
 * and a turn.end whose record has no error.
 */
export async function runCanary(env: Env, now: () => number = () => Date.now()): Promise<CanaryResult> {
  const startedAt = now();
  const result = (reason: string | null): CanaryResult => ({ ok: reason === null, ms: now() - startedAt, reason });
  if (env.ASSISTANT_MODE === "off") return result("assistant is off");
  try {
    const { token, conversationId, secretHash } = mintToken();
    const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(conversationId));
    await stub.init(await secretHash, startedAt + CANARY_SESSION_MS, "canary");
    const res = await stub.fetch(
      new Request("https://assistant.internal/assistant/chat", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ message: CANARY_QUESTION }),
      }),
    );
    if (res.status !== 200 || !res.body) {
      const error = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error;
      return result(`http ${res.status}${typeof error === "string" ? ` ${error}` : ""}`);
    }
    return result(await checkAnswer(res.body));
  } catch (err) {
    return result(err instanceof Error ? err.message : String(err));
  }
}

/** Reads the whole stream; null when the answer is whole, otherwise what was missing or wrong. */
async function checkAnswer(body: ReadableStream<Uint8Array>): Promise<string | null> {
  const reader = body.getReader();
  const parser = new SseParser();
  const decoder = new TextDecoder();
  let sentences = 0;
  let meta = false;
  let error: string | null = null;
  let record: TurnRecord | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const e of parser.push(decoder.decode(value, { stream: true }))) {
      if (e.type === "sentence") sentences++;
      else if (e.type === "meta") meta = true;
      else if (e.type === "error") error ??= e.code;
      else if (e.type === "turn.end") record = e.record;
    }
  }
  if (error) return `error event: ${error}`;
  if (sentences === 0) return "no sentence";
  if (!meta) return "no meta";
  if (!record) return "no turn.end";
  if (record.error) return `turn error: ${record.error}`;
  return null;
}
