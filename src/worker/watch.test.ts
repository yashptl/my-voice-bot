import { afterEach, describe, expect, it, vi } from "vitest";
import { sqliteD1 } from "../../tests/sqlite-d1";
import type { CanaryResult } from "./canary";
import type { Env } from "./env";
import { markOutageAlerted, readOutage, setOutage } from "./outage-flag";

/** What the canary returns, run by run; the last one repeats. `canary = x` scripts a single result. */
let runs: CanaryResult[] = [];
let calls = 0;
const script = (...results: CanaryResult[]) => {
  runs = results;
  calls = 0;
};
let canary: CanaryResult = { ok: true, ms: 450, reason: null };
vi.mock("./canary", () => ({
  runCanary: async () => {
    const result = runs.length > 0 ? (runs[Math.min(calls, runs.length - 1)] as CanaryResult) : canary;
    calls++;
    return result;
  },
}));

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

afterEach(() => {
  vi.restoreAllMocks();
  runs = [];
  calls = 0;
});

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

  it("passing with the flag set clears it, and sends nothing", async () => {
    spies();
    const h = setup();
    await setOutage(h.env.DB, "llm_quota", 1000);
    canary = { ok: true, ms: 450, reason: null };
    await watch(h.env);
    expect(await readOutage(h.env.DB)).toBeNull();
    expect(h.sent).toEqual([]);
  });

  it("failing twice runs the canary twice, sets the flag with the second reason and sends one outage email", async () => {
    const c = spies();
    script({ ok: false, ms: 300, reason: "no meta" }, { ok: false, ms: 300, reason: "no sentence" });
    const h = setup();
    await watch(h.env);
    expect(calls).toBe(2);
    expect(c.error).toHaveBeenCalledWith("canary failed: no meta");
    expect(c.error).toHaveBeenCalledWith("canary failed: no sentence");
    expect(await readOutage(h.env.DB)).toMatchObject({ reason: "no sentence", alerted: true });
    expect(h.sent.map((m) => m.subject)).toEqual(["Assistant alert: outage"]);
    expect(h.sent[0]?.text).toContain("no sentence");
  });

  it("failing once and then passing leaves the flag unset and raises answer_failed naming the first failure", async () => {
    spies();
    script({ ok: false, ms: 300, reason: "no meta" }, { ok: true, ms: 450, reason: null });
    const h = setup();
    await watch(h.env);
    expect(calls).toBe(2);
    expect(await readOutage(h.env.DB)).toBeNull();
    expect(h.sent.map((m) => m.subject)).toEqual(["Assistant alert: answer_failed"]);
    expect(h.sent[0]?.text).toContain("no meta");
  });

  it("a first failure followed by a run skipped as resting still raises answer_failed, besides resting", async () => {
    spies();
    script({ ok: false, ms: 300, reason: "no meta" }, { ok: true, ms: 0, reason: null, skipped: "resting" });
    const h = setup();
    await watch(h.env);
    expect(h.sent.map((m) => m.subject).sort()).toEqual(["Assistant alert: answer_failed", "Assistant alert: resting"]);
    expect(h.sent.find((m) => m.subject.endsWith("answer_failed"))?.text).toContain("no meta");
    expect(await readOutage(h.env.DB)).toBeNull();
  });

  it("a first failure followed by a run that finds the assistant off still raises answer_failed", async () => {
    spies();
    script({ ok: false, ms: 300, reason: "no meta" }, { ok: false, ms: 0, reason: "assistant is off" });
    const h = setup();
    await watch(h.env);
    expect(h.sent.map((m) => m.subject)).toEqual(["Assistant alert: answer_failed"]);
    expect(await readOutage(h.env.DB)).toBeNull();
  });

  it("failing twice with the flag set and alerted sends nothing more", async () => {
    spies();
    script({ ok: false, ms: 300, reason: "no meta" });
    const h = setup();
    await setOutage(h.env.DB, "llm_quota", 1000);
    await markOutageAlerted(h.env.DB, 1000);
    await watch(h.env);
    expect(h.sent).toEqual([]);
    expect(await readOutage(h.env.DB)).toMatchObject({ reason: "llm_quota" });
  });

  it("failing twice with the flag set but never alerted sends the one email", async () => {
    spies();
    script({ ok: false, ms: 300, reason: "no meta" });
    const h = setup();
    await setOutage(h.env.DB, "llm_quota", 1000);
    await watch(h.env);
    expect(h.sent.map((m) => m.subject)).toEqual(["Assistant alert: outage"]);
    expect(await readOutage(h.env.DB)).toMatchObject({ alerted: true });
  });

  it("leaves the flag as it was when the canary is skipped as resting", async () => {
    spies();
    script({ ok: true, ms: 0, reason: null, skipped: "resting" });
    const h = setup();
    await setOutage(h.env.DB, "llm_quota", 1000);
    await watch(h.env);
    expect(await readOutage(h.env.DB)).toMatchObject({ reason: "llm_quota" });
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

  it("raises misconfigured, naming what is missing, after one run and without touching the flag", async () => {
    spies();
    script({ ok: false, ms: 0, reason: "not configured" });
    const h = setup({ IP_HASH_KEY: undefined, MINIMAX_API_KEY: undefined });
    await watch(h.env);
    expect(calls).toBe(1);
    expect(await readOutage(h.env.DB)).toBeNull();
    expect(h.sent.map((m) => m.subject)).toEqual(["Assistant alert: misconfigured"]);
    expect(h.sent[0]?.text).toContain("IP_HASH_KEY, MINIMAX_API_KEY");
  });

  it("logs, but sends nothing, while the assistant is off on purpose", async () => {
    const c = spies();
    script({ ok: false, ms: 0, reason: "assistant is off" });
    const h = setup();
    await watch(h.env);
    expect(calls).toBe(1);
    expect(await readOutage(h.env.DB)).toBeNull();
    expect(c.error).toHaveBeenCalledWith("canary failed: assistant is off");
    expect(h.sent).toEqual([]);
  });

  it("warns instead of sending without ALERT_TO", async () => {
    const c = spies();
    script({ ok: false, ms: 300, reason: "no meta" });
    const h = setup({ ALERT_TO: undefined });
    await watch(h.env);
    expect(h.sent).toEqual([]);
    expect(await readOutage(h.env.DB)).toMatchObject({ alerted: false });
    expect(c.warn).toHaveBeenCalledWith("alert outage not sent: ALERT_TO or the ALERT_EMAIL binding is missing");
  });
});
