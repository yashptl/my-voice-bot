import { describe, expect, it } from "vitest";
import { LlmError, type LlmErrorKind } from "../ports/llm";
import { OUTAGE_ERRORS, turnFailure } from "./turn-failure";

describe("turnFailure", () => {
  it.each([
    ["total", "llm_timeout_total"],
    ["idle", "llm_timeout_idle"],
  ] as const)("a %s deadline is a timeout", (deadline, record) => {
    const f = turnFailure(new LlmError("timeout", "too slow", { deadline }));
    expect(f).toMatchObject({ record, code: "timeout" });
    expect(f.reason).toBeUndefined();
  });

  it.each([
    ["auth", "llm_auth"],
    ["quota", "llm_quota"],
  ] as const)("%s will not fix itself, so the assistant rests for an outage", (kind, record) => {
    expect(turnFailure(new LlmError(kind, "no"))).toMatchObject({
      record,
      code: "resting",
      reason: "outage",
      message: "The assistant is resting for now. Messages is the best way to reach Yash.",
    });
  });

  it.each<LlmErrorKind>(["rate_limit", "overloaded", "bad_request", "empty", "network", "unknown"])(
    "%s is an ordinary provider failure",
    (kind) => {
      const f = turnFailure(new LlmError(kind, "no"));
      expect(f).toMatchObject({
        record: `llm_${kind}`,
        code: "provider",
        message: "The assistant could not finish that answer. Please try again.",
      });
      expect(f.reason).toBeUndefined();
    },
  );

  it("a timeout without a deadline is still a timeout", () => {
    expect(turnFailure(new LlmError("timeout", "x"))).toMatchObject({ record: "llm_timeout", code: "timeout" });
  });

  it("anything that is not an LlmError is llm_failed", () => {
    expect(turnFailure(new Error("boom"))).toMatchObject({ record: "llm_failed", code: "provider" });
  });

  it("the log line holds kind, status and provider code, never the provider's text", () => {
    const line = turnFailure(new LlmError("quota", "secret provider text", { status: 429, code: 2056 })).logLine;
    expect(line).toContain("quota");
    expect(line).toContain("429");
    expect(line).toContain("2056");
    expect(line).not.toContain("secret provider text");
  });

  it("OUTAGE_ERRORS names the records that rest the assistant", () => {
    expect([...OUTAGE_ERRORS].sort()).toEqual(["llm_auth", "llm_quota"]);
  });
});
