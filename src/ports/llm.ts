/** Provider-neutral chat history. */
export interface NeutralTurn {
  role: "user" | "assistant";
  text: string;
}

export interface LlmRequest {
  /** Byte-identical across turns so the provider's prefix cache hits. */
  stable: string;
  /** Ends with the new user turn. */
  turns: NeutralTurn[];
  /** Per-turn instructions, sent in the last user message ahead of the visitor's text. */
  tail: string;
  maxTokens: number;
}

export interface LlmUsage {
  input: number;
  cachedInput: number;
  reasoning: number;
  /** True when `reasoning` is estimated from thinking characters rather than reported. */
  reasoningEstimated: boolean;
  output: number;
  model: string;
  stopReason: string | null;
}

/** Reasoning surfaces only as a content-free tick; its text never leaves the adapter. */
export type LlmChunk = { t: "reasoning" } | { t: "text"; text: string } | { t: "usage"; usage: LlmUsage };

export interface LlmPort {
  readonly id: string;
  readonly model: string;
  stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmChunk>;
}

export type LlmErrorKind =
  | "auth"
  /** The plan or credit is used up: like `auth`, it will not fix itself. */
  | "quota"
  | "rate_limit"
  | "overloaded"
  | "bad_request"
  | "empty"
  | "network"
  | "timeout"
  | "unknown";

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status?: number;
  /** Timeouts only: which deadline was missed, the whole answer's or the gap between chunks. */
  readonly deadline?: "total" | "idle";
  /** The provider's own numeric status code, when its reply carried one. */
  readonly code?: number;

  constructor(
    kind: LlmErrorKind,
    message: string,
    options: { status?: number; deadline?: "total" | "idle"; code?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "LlmError";
    this.kind = kind;
    this.status = options.status;
    this.deadline = options.deadline;
    this.code = options.code;
  }
}
