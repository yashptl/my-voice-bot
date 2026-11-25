import { LlmError } from "../ports/llm";

export interface TurnFailure {
  /** For TurnRecord.error. */
  record: string;
  /** For the error event. */
  code: "timeout" | "provider" | "resting";
  reason?: "outage";
  message: string;
  /** For the log: kind, HTTP status and provider code; never provider or visitor text. */
  logLine: string;
}

/** Record errors that mean the provider will keep failing until someone acts. */
export const OUTAGE_ERRORS: ReadonlySet<string> = new Set(["llm_auth", "llm_quota"]);

const FAILED = "The assistant could not finish that answer. Please try again.";
const RESTING = "The assistant is resting for now. Messages is the best way to reach Yash.";

/**
 * What a failed model answer means, for the record, the visitor and the log. A key the provider
 * rejects or a plan it says is used up rests the assistant; a missed deadline is a timeout; anything
 * else is an ordinary failure the visitor can retry. Reads only LlmError's own fields.
 */
export function turnFailure(err: unknown): TurnFailure {
  if (!(err instanceof LlmError)) {
    return { record: "llm_failed", code: "provider", message: FAILED, logLine: "llm failed: unexpected error" };
  }
  const logLine = `llm failed: ${[err.kind, err.deadline, err.status, err.code].filter((v) => v !== undefined).join(" ")}`;
  if (err.kind === "timeout") {
    return { record: `llm_timeout${err.deadline ? `_${err.deadline}` : ""}`, code: "timeout", message: FAILED, logLine };
  }
  const record = `llm_${err.kind}`;
  if (OUTAGE_ERRORS.has(record)) return { record, code: "resting", reason: "outage", message: RESTING, logLine };
  return { record, code: "provider", message: FAILED, logLine };
}
