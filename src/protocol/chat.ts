import { z } from "zod";
import type { AssistantMode, RestingReason } from "./events";

/** Longest visitor message, in UTF-16 code units. The brain enforces it again after sanitizing. */
export const MAX_MESSAGE_CHARS = 4000;

/** Request bodies above this are refused before parsing. */
export const MAX_BODY_BYTES = 16_384;

/**
 * `POST /assistant/session` body. `turnstile` is the Turnstile widget's token (single use, valid
 * 300 s). Local dev and staging use Cloudflare's test keys, whose token is `XXXX.DUMMY.TOKEN.XXXX`.
 */
export const SessionRequestSchema = z.object({
  turnstile: z.string().min(1).max(2048),
});
export type SessionRequest = z.infer<typeof SessionRequestSchema>;

/** `POST /assistant/session` reply. `resting`: why the assistant rests for this visitor now (show the static card), or null. */
export interface SessionResponse {
  token: string;
  protocol: number;
  mode: AssistantMode;
  expiresAt: number;
  resting: RestingReason | null;
}

/**
 * `POST /assistant/chat` body, sent with `Authorization: Bearer <token>`. The reply is a
 * `text/event-stream` of ServerEvents (see sse.ts); HTTP errors carry `{ error: ErrorCode | string }`, and a 503 `resting` also carries `reason`.
 */
export const ChatRequestSchema = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/** The token from an `Authorization: Bearer <token>` header, or null. */
export function tokenFromAuthorization(header: string | null): string | null {
  const m = /^Bearer ([^\s]+)$/.exec(header ?? "");
  return m?.[1] ?? null;
}
