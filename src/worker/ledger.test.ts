import { afterEach, describe, expect, it, vi } from "vitest";
import { sqliteD1 } from "../../tests/sqlite-d1";
import type { Env } from "./env";
import { dailyTurns, pruneDays, restingToday, spend, spendTurn, used, utcDay } from "./ledger";

const DAY = "2026-11-08";

const rows = (db: ReturnType<typeof sqliteD1>) => db.sqlite.prepare("SELECT day, unit, used FROM daily ORDER BY day").all();

/** A database whose every call fails, as D1 does when it is unavailable. */
const brokenDb = () =>
  ({
    prepare() {
      throw new Error("D1 unavailable");
    },
  }) as unknown as D1Database;

afterEach(() => {
  vi.useRealTimers();
});

describe("spend", () => {
  it("spends up to the ceiling, then refuses without counting the refused spend", async () => {
    const db = sqliteD1();
    expect(await spend(db, "turns", 1, 2, DAY)).toEqual({ ok: true, used: 1 });
    expect(await spend(db, "turns", 1, 2, DAY)).toEqual({ ok: true, used: 2 });
    expect(await spend(db, "turns", 1, 2, DAY)).toEqual({ ok: false });
    expect(await spend(db, "turns", 1, 2, DAY)).toEqual({ ok: false });
    expect(await used(db, "turns", DAY)).toBe(2);
  });

  it("refuses a spend that would cross the ceiling, even when some is left", async () => {
    const db = sqliteD1();
    await spend(db, "turns", 3, 4, DAY);
    expect(await spend(db, "turns", 2, 4, DAY)).toEqual({ ok: false });
    expect(await spend(db, "turns", 1, 4, DAY)).toEqual({ ok: true, used: 4 });
  });

  it("writes nothing for a first spend bigger than the ceiling (DAILY_TURNS 0 pauses)", async () => {
    const db = sqliteD1();
    expect(await spend(db, "turns", 5, 4, DAY)).toEqual({ ok: false });
    expect(await spend(db, "turns", 1, 0, DAY)).toEqual({ ok: false });
    expect(rows(db)).toEqual([]);
  });

  it("starts each UTC day at 0, keeping earlier days' counts", async () => {
    const db = sqliteD1();
    await spend(db, "turns", 2, 2, DAY);
    expect(await spend(db, "turns", 1, 2, DAY)).toEqual({ ok: false });
    expect(await spend(db, "turns", 1, 2, "2026-11-09")).toEqual({ ok: true, used: 1 });
    expect(rows(db)).toEqual([
      { day: DAY, unit: "turns", used: 2 },
      { day: "2026-11-09", unit: "turns", used: 1 },
    ]);
  });

  it("never passes the ceiling when many spends arrive at once", async () => {
    const db = sqliteD1();
    const results = await Promise.all(Array.from({ length: 25 }, () => spend(db, "turns", 1, 10, DAY)));
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(results.filter((r) => r.ok).map((r) => (r.ok ? r.used : 0))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await used(db, "turns", DAY)).toBe(10);
  });

  it("interleaves two days' spends without mixing their counts", async () => {
    const db = sqliteD1();
    const days = [DAY, "2026-11-09"];
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => spend(db, "turns", 1, 4, days[i % 2] ?? DAY)));
    expect(results.filter((r) => r.ok)).toHaveLength(8);
    expect(await used(db, "turns", DAY)).toBe(4);
    expect(await used(db, "turns", "2026-11-09")).toBe(4);
  });
});

describe("used", () => {
  it("is 0 for a day with nothing spent", async () => {
    expect(await used(sqliteD1(), "turns", DAY)).toBe(0);
  });
});

describe("pruneDays", () => {
  it("deletes days more than 7 days old and keeps the rest", async () => {
    const db = sqliteD1();
    for (const day of ["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-08"]) await spend(db, "turns", 1, 9, day);
    expect(await pruneDays(db, Date.UTC(2026, 10, 8, 12))).toBe(2);
    expect(rows(db).map((r) => r.day)).toEqual(["2026-11-02", "2026-11-08"]);
  });
});

describe("utcDay", () => {
  it("runs outside UTC (vitest.config.ts sets TZ), so the tests below catch a local date", () => {
    expect(new Date(Date.UTC(2026, 10, 8, 23)).getDate()).toBe(9);
  });

  it("is the UTC calendar date", () => {
    expect(utcDay(Date.UTC(2026, 10, 8, 23, 59, 59, 999))).toBe("2026-11-08");
    expect(utcDay(Date.UTC(2026, 10, 9, 0, 0, 0, 0))).toBe("2026-11-09");
  });
});

describe("spendTurn and restingToday", () => {
  const env = (DB: D1Database, DAILY_TURNS = "2") => ({ DB, DAILY_TURNS }) as unknown as Env;

  it("spend today's (UTC) turns against DAILY_TURNS, so the ceiling resets at UTC midnight", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 8, 23, 59, 59) });
    const e = env(sqliteD1(), "1");
    const log = vi.fn();
    expect(await restingToday(e, log)).toBe(false);
    expect(await spendTurn(e, log)).toBe(true);
    expect(await spendTurn(e, log)).toBe(false);
    expect(await restingToday(e, log)).toBe(true);
    vi.setSystemTime(Date.UTC(2026, 10, 9, 0, 0, 0));
    expect(await restingToday(e, log)).toBe(false);
    expect(await spendTurn(e, log)).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  it("rest when DAILY_TURNS is 0", async () => {
    const e = env(sqliteD1(), "0");
    expect(await restingToday(e, vi.fn())).toBe(true);
    expect(await spendTurn(e, vi.fn())).toBe(false);
  });

  it("fail closed as resting when the database fails, and log why", async () => {
    const log = vi.fn();
    expect(await spendTurn(env(brokenDb()), log)).toBe(false);
    expect(await restingToday(env(brokenDb()), log)).toBe(true);
    expect(log.mock.calls).toEqual([
      ["error", "ledger failed: D1 unavailable"],
      ["error", "ledger failed: D1 unavailable"],
    ]);
  });
});

describe("dailyTurns", () => {
  const env = (DAILY_TURNS: string | undefined) => ({ DAILY_TURNS }) as unknown as Env;

  it("parses DAILY_TURNS", () => {
    expect(dailyTurns(env("400"))).toBe(400);
    expect(dailyTurns(env(" 25 "))).toBe(25);
    expect(dailyTurns(env("0"))).toBe(0);
  });

  it("defaults to 400 when missing or invalid", () => {
    for (const v of [undefined, "", "abc", "-5", "1.5", "1e3"]) expect(dailyTurns(env(v)), String(v)).toBe(400);
  });
});
