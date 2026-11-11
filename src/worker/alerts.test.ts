import { describe, expect, it } from "vitest";
import { sqliteD1 } from "../../tests/sqlite-d1";
import { raiseAlert, type AlertKind } from "./alerts";
import type { Env } from "./env";
import { used, utcDay } from "./ledger";

const NOW = Date.UTC(2026, 10, 11, 14, 5, 9);
const TO = "owner@example.test";

type Sent = { to: string; from: string; subject: string; text: string };

function setup(o: { binding?: boolean; to?: string | null; fail?: boolean } = {}) {
  const sent: Sent[] = [];
  const db = sqliteD1();
  const env = {
    DB: db,
    ALERT_TO: o.to === null ? undefined : (o.to ?? TO),
    ALERT_FROM: "assistant@example.test",
    ALERT_EMAIL:
      o.binding === false
        ? undefined
        : {
            async send(m: Sent) {
              if (o.fail) throw new Error("send refused");
              sent.push(m);
              return { messageId: "m1" };
            },
          },
  } as unknown as Env;
  const logs: [string, string][] = [];
  const log = (level: string, line: string) => void logs.push([level, line]);
  return { env, db, sent, logs, log };
}

describe("raiseAlert", () => {
  it("sends one structured email saying the kind, the UTC time and the reason", async () => {
    const h = setup();
    expect(await raiseAlert(h.env, "canary_failed", "http 503 resting", h.log, NOW)).toBe("sent");
    expect(h.sent).toHaveLength(1);
    const [mail] = h.sent;
    expect(mail).toMatchObject({ to: TO, from: "assistant@example.test", subject: "Assistant alert: canary_failed" });
    expect(mail?.text).toContain("canary_failed");
    expect(mail?.text).toContain("2026-11-11T14:05:09.000Z");
    expect(mail?.text).toContain("http 503 resting");
  });

  it("sends at most one email per kind per UTC day, claimed in D1 first", async () => {
    const h = setup();
    expect(await raiseAlert(h.env, "slow", "12000 ms", h.log, NOW)).toBe("sent");
    expect(await raiseAlert(h.env, "slow", "13000 ms", h.log, NOW + 60_000)).toBe("already");
    expect(h.sent).toHaveLength(1);
    expect(await used(h.db, "alert:slow", utcDay(NOW))).toBe(1);
    // Another kind has its own claim, and the next UTC day starts over.
    expect(await raiseAlert(h.env, "resting", "turns used up", h.log, NOW)).toBe("sent");
    expect(await raiseAlert(h.env, "slow", "12000 ms", h.log, NOW + 24 * 60 * 60 * 1000)).toBe("sent");
    expect(h.sent).toHaveLength(3);
  });

  it("claims atomically: two raised at once send one", async () => {
    const h = setup();
    const kinds = await Promise.all([
      raiseAlert(h.env, "misconfigured", "IP_HASH_KEY", h.log, NOW),
      raiseAlert(h.env, "misconfigured", "IP_HASH_KEY", h.log, NOW),
    ]);
    expect(kinds.sort()).toEqual(["already", "sent"]);
    expect(h.sent).toHaveLength(1);
  });

  it("logs a warning and claims nothing without ALERT_TO or the binding, so a later fix still gets its email", async () => {
    for (const o of [{ to: null }, { binding: false }, { to: "  " }]) {
      const h = setup(o);
      expect(await raiseAlert(h.env, "resting", "turns used up", h.log, NOW)).toBe("unsent");
      expect(h.logs).toEqual([["warn", "alert resting not sent: ALERT_TO or the ALERT_EMAIL binding is missing"]]);
      expect(await used(h.db, "alert:resting", utcDay(NOW))).toBe(0);
    }
  });

  it("gives the claim back when sending fails, so the next hour tries again, and logs without the address", async () => {
    const h = setup({ fail: true });
    expect(await raiseAlert(h.env, "canary_failed", "no meta", h.log, NOW)).toBe("failed");
    expect(h.logs).toEqual([["error", "alert canary_failed not sent: send refused"]]);
    expect(JSON.stringify(h.logs)).not.toContain(TO);
    expect(await used(h.db, "alert:canary_failed", utcDay(NOW))).toBe(0);
  });

  it("sends anyway when the claim fails with a database error, and logs that the claim failed", async () => {
    const h = setup();
    (h.env as { DB: unknown }).DB = {
      prepare() {
        throw new Error("D1 unavailable");
      },
    };
    expect(await raiseAlert(h.env, "canary_failed", "ledger unavailable", h.log, NOW)).toBe("sent");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.text).toContain("ledger unavailable");
    expect(h.logs).toEqual([["error", "alert canary_failed claim failed, sending anyway: D1 unavailable"]]);
    expect(JSON.stringify(h.logs)).not.toContain(TO);
  });

  it("still returns failed when the claim and the send both fail", async () => {
    const h = setup({ fail: true });
    (h.env as { DB: unknown }).DB = {
      prepare() {
        throw new Error("D1 unavailable");
      },
    };
    expect(await raiseAlert(h.env, "slow", "r", h.log, NOW)).toBe("failed");
    expect(h.sent).toEqual([]);
  });

  it("covers the four kinds", async () => {
    const h = setup();
    const kinds: AlertKind[] = ["canary_failed", "slow", "resting", "misconfigured"];
    for (const k of kinds) expect(await raiseAlert(h.env, k, "r", h.log, NOW)).toBe("sent");
  });
});
