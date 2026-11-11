import { afterEach, expect, it, vi } from "vitest";
import type { Env } from "./env";
import { watch } from "./watch";

afterEach(() => vi.restoreAllMocks());

/** The whole chain with D1 down: chat rests, the canary calls that a failure, the alert still goes out. */
it("D1 down: the canary fails as 'ledger unavailable' and the owner is emailed anyway", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const sent: { subject: string; text: string }[] = [];
  const env = {
    ASSISTANT_MODE: "voice",
    TURNSTILE_SECRET: "t",
    IP_HASH_KEY: "k",
    MINIMAX_API_KEY: "m",
    ALERT_TO: "owner@example.test",
    ALERT_EMAIL: { send: async (m: { subject: string; text: string }) => void sent.push(m) },
    DB: {
      prepare() {
        throw new Error("D1 unavailable");
      },
    },
    CONVERSATION: {
      idFromName: (n: string) => n,
      get: () => ({
        init: async () => {},
        fetch: async () => Response.json({ error: "resting" }, { status: 503 }), // spendTurn fails closed
      }),
    },
  } as unknown as Env;
  await watch(env);
  expect(sent.map((m) => m.subject)).toEqual(["Assistant alert: canary_failed"]);
  expect(sent[0]?.text).toContain("ledger unavailable");
});
