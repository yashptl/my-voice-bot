import { afterEach, describe, expect, it, vi } from "vitest";
import { sqliteD1 } from "../../tests/sqlite-d1";
import type { CanaryResult } from "./canary";
import type { Env } from "./env";

let canary: CanaryResult = { ok: true, ms: 450, reason: null };
vi.mock("./canary", () => ({ runCanary: async () => canary }));

const { watch } = await import("./watch");

function setup(over: Partial<Env> = {}) {
  const sent: { subject: string; text: string }[] = [];
  const env = {
    DB: sqliteD1(),
    TURNSTILE_SECRET: "t",
    IP_HASH_KEY: "k",
    MINIMAX_API_KEY: "m",
    ALERT_TO: "owner@example.test",
    ALERT_FROM: "assistant@example.test",
    ALERT_EMAIL: { send: async (m: { subject: string; text: string }) => void sent.push(m) },
    ...over,
  } as unknown as Env;
  return { env, sent };
}

afterEach(() => vi.restoreAllMocks());

function spies() {
  return {
    info: vi.spyOn(console, "info").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

describe("watch", () => {
  it("logs an ok canary and sends nothing", async () => {
    const c = spies();
    canary = { ok: true, ms: 450, reason: null };
    const h = setup();
    await watch(h.env);
    expect(c.info).toHaveBeenCalledWith("canary ok in 450 ms");
    expect(h.sent).toEqual([]);
  });

  it("raises slow when the canary took over 10 s, and not at exactly 10 s", async () => {
    spies();
    const h = setup();
    canary = { ok: true, ms: 10_000, reason: null };
    await watch(h.env);
    expect(h.sent).toEqual([]);
    canary = { ok: true, ms: 10_001, reason: null };
    await watch(h.env);
    expect(h.sent.map((m) => m.subject)).toEqual(["Assistant alert: slow"]);
    expect(h.sent[0]?.text).toContain("10001 ms");
  });

  it("logs a failure and raises canary_failed with its reason", async () => {
    const c = spies();
    canary = { ok: false, ms: 300, reason: "no meta" };
    const h = setup();
    await watch(h.env);
    expect(c.error).toHaveBeenCalledWith("canary failed: no meta");
    expect(h.sent.map((m) => m.subject)).toEqual(["Assistant alert: canary_failed"]);
    expect(h.sent[0]?.text).toContain("no meta");
  });

  it("logs 'canary skipped: resting' and raises resting, which is not a failure", async () => {
    const c = spies();
    canary = { ok: true, ms: 0, reason: null, skipped: "resting" };
    const h = setup();
    await watch(h.env);
    expect(c.info).toHaveBeenCalledWith("canary skipped: resting");
    expect(c.error).not.toHaveBeenCalled();
    expect(h.sent.map((m) => m.subject)).toEqual(["Assistant alert: resting"]);
  });

  it("raises misconfigured, naming what is missing, instead of canary_failed when config is missing", async () => {
    spies();
    canary = { ok: false, ms: 0, reason: "not configured" };
    const h = setup({ IP_HASH_KEY: undefined, MINIMAX_API_KEY: undefined });
    await watch(h.env);
    expect(h.sent.map((m) => m.subject)).toEqual(["Assistant alert: misconfigured"]);
    expect(h.sent[0]?.text).toContain("IP_HASH_KEY, MINIMAX_API_KEY");
  });

  it("logs, but sends nothing, while the assistant is off on purpose", async () => {
    const c = spies();
    canary = { ok: false, ms: 0, reason: "assistant is off" };
    const h = setup();
    await watch(h.env);
    expect(c.error).toHaveBeenCalledWith("canary failed: assistant is off");
    expect(h.sent).toEqual([]);
  });

  it("warns instead of sending without ALERT_TO", async () => {
    const c = spies();
    canary = { ok: false, ms: 300, reason: "no meta" };
    const h = setup({ ALERT_TO: undefined });
    await watch(h.env);
    expect(h.sent).toEqual([]);
    expect(c.warn).toHaveBeenCalledWith("alert canary_failed not sent: ALERT_TO or the ALERT_EMAIL binding is missing");
  });
});
