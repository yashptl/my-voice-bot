import { z } from "zod";
import type { AudioFormat } from "./audio";
import type { DataLine } from "./data-line";
import { CLIENT_MARKS, type TurnRecord } from "./turn-record";

export type AssistantMode = "voice" | "text" | "off";

export type AssistantState = "listening" | "thinking" | "speaking" | "idle";

/**
 * `limit`: this conversation used its questions or audio. `resting`: the day's shared ceiling is
 * reached, so the client shows the static card (pitch, resume, Messages) instead of the assistant.
 * `busy`: a text answer is still streaming in this conversation.
 */
export type ErrorCode = "rate_limited" | "auth" | "provider" | "limit" | "resting" | "busy" | "protocol" | "internal";

/** A cited knowledge section, with the title the client shows on its chip. */
export interface Source {
  ref: string;
  title: string;
}

/**
 * Server → client JSON messages. Voice sends them over the WebSocket, with audio separately as binary
 * frames (see audio.ts). Text sends `turn.start`, `sentence`, `meta` (or `sources`), `turn.end` and
 * `error` as server-sent events (see sse.ts).
 */
export type ServerEvent =
  | { type: "ready"; protocol: number; mode: AssistantMode; audio: AudioFormat }
  | { type: "state"; state: AssistantState }
  | { type: "transcript"; turnIndex: number; text: string; final: boolean }
  | { type: "turn.start"; turnId: string; question: string }
  | { type: "sentence"; turnId: string; id: number; text: string }
  /** `sources` are `data.refs` in order, each with its bundle title. */
  | { type: "meta"; turnId: string; data: DataLine; sources: Source[] }
  /**
   * Sent instead of `meta` when the reply had no valid data line but ended with a bare list of refs:
   * `sources` are its known refs, for chips only. Nothing else is known (no coverage or contact flag),
   * so this is never a data line. A client that predates it skips it and shows no chips.
   */
  | { type: "sources"; turnId: string; sources: Source[] }
  | { type: "turn.end"; turnId: string; record: TurnRecord }
  /**
   * An interrupt for a turn that had already ended (its audio was still playing): history now keeps
   * only the sentences up to `lastHeardSentenceId`, and `record` is that turn's record, updated.
   */
  | { type: "turn.interrupted"; turnId: string; lastHeardSentenceId: number | null; record: TurnRecord }
  /**
   * Diagnostics, nothing for the visitor to act on: the speech-to-text session behind this socket
   * closed (Flux ends one after a few seconds without audio), or a new one opened for the next audio.
   * `session` counts this socket's sessions from 1. `idleMs` is the time since this socket last sent
   * it audio (null when it never did).
   */
  | { type: "stt"; status: "closed"; session: number; openForMs: number; idleMs: number | null }
  | { type: "stt"; status: "reopened"; session: number }
  | { type: "error"; code: ErrorCode; message: string };

const turnId = z.string().min(1).max(128);

/** Client → server JSON messages. Validated with this schema because they cross a trust boundary. */
export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("interrupt"),
    turnId,
    lastHeardSentenceId: z.int().nonnegative().nullable(),
  }),
  z.object({
    type: z.literal("mark"),
    turnId,
    mark: z.enum(CLIENT_MARKS),
    at: z.number(),
  }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/** Parses one WebSocket text message; null when it is not valid JSON or not a known message. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = ClientMessageSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
