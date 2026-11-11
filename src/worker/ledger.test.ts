import { afterEach, describe, expect, it, vi } from "vitest";
import { sqliteD1 } from "../../tests/sqlite-d1";
import type { Env } from "./env";
import {
  ceiling,
  pruneDays,
  pruneVisitors,
  refund,
  release,
  releaseAudio,
  reserve,
  reserveAudio,
  restingToday,
  spend,
  spendTurn,
  spendVisitor,
  turnsPerIp,
  used,
  utcDay,
  voiceRestingToday,
  voiceSecondsPerIp,
} from "./ledger";

const DAY = "2026-11-08";
const IP = "203.0.113.7";

const rows = (db: ReturnType<typeof sqliteD1>) => db.sqlite.prepare("SELECT day, unit, used FROM daily ORDER BY day, unit").all();
const visitorRows = (db: ReturnType<typeof sqliteD1>) =>
  db.sqlite.prepare("SELECT day, ip_hash, used FROM daily_ip ORDER BY day, ip_hash").all();

/** A database whose every call fails, as D1 does when it is unavailable. */
const brokenDb = () =>
  ({
    prepare() {
      throw new Error("D1 unavailable");
    },
  }) as unknown as D1Database;

type Vars = Partial<Pick<Env, "DAILY_TURNS" | "DAILY_VOICE_SECONDS" | "DAILY_TTS_CHARS" | "DAILY_TURNS_PER_IP" | "DAILY_VOICE_SECONDS_PER_IP" | "IP_HASH_KEY">>;
const envOf = (DB: D1Database, vars: Vars = {}) => ({ DB, IP_HASH_KEY: "test-key", ...vars }) as unknown as Env;

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

  it("writes nothing for a first spend bigger than the ceiling (a ceiling of 0 pauses)", async () => {
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

  it("counts each unit apart", async () => {
    const db = sqliteD1();
    await spend(db, "turns", 1, 400, DAY);
    await spend(db, "voice_seconds", 15, 1800, DAY);
    await spend(db, "tts_chars", 500, 60_000, DAY);
    expect(rows(db)).toEqual([
      { day: DAY, unit: "tts_chars", used: 500 },
      { day: DAY, unit: "turns", used: 1 },
      { day: DAY, unit: "voice_seconds", used: 15 },
    ]);
  });
});

describe("refund", () => {
  it("subtracts from that day's row and never goes below 0", async () => {
    const db = sqliteD1();
    await spend(db, "tts_chars", 500, 60_000, DAY);
    await refund(db, "tts_chars", 120, DAY);
    expect(await used(db, "tts_chars", DAY)).toBe(380);
    await refund(db, "tts_chars", 1000, DAY);
    expect(await used(db, "tts_chars", DAY)).toBe(0);
  });

  it("touches only the day it names: no other day's row, and no new row", async () => {
    const db = sqliteD1();
    await spend(db, "turns", 3, 400, DAY);
    await refund(db, "turns", 1, "2026-11-09");
    await refund(db, "voice_seconds", 1, DAY);
    expect(rows(db)).toEqual([{ day: DAY, unit: "turns", used: 3 }]);
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

describe("pruneVisitors", () => {
  it("deletes the per-visitor counts of every day that is over, and keeps today's", async () => {
    const db = sqliteD1();
    for (const day of ["2026-11-06", "2026-11-07", DAY]) await spendVisitor(db, "abc", 60, day);
    expect(await pruneVisitors(db, Date.UTC(2026, 10, 8, 0, 30))).toBe(2);
    expect(visitorRows(db)).toEqual([{ day: DAY, ip_hash: "abc", used: 1 }]);
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

describe("ceiling and turnsPerIp", () => {
  const env = (vars: Vars) => vars as unknown as Env;

  it("parse whole numbers, spaces allowed; 0 pauses", () => {
    const log = vi.fn();
    expect(ceiling(env({ DAILY_TURNS: " 25 " }), "turns", log)).toBe(25);
    expect(ceiling(env({ DAILY_VOICE_SECONDS: "900" }), "voice_seconds", log)).toBe(900);
    expect(ceiling(env({ DAILY_TTS_CHARS: "0" }), "tts_chars", log)).toBe(0);
    expect(turnsPerIp(env({ DAILY_TURNS_PER_IP: "10" }), log)).toBe(10);
    expect(log).not.toHaveBeenCalled();
  });

  it("accept a JSON number, as wrangler.jsonc passes it, the same as the string", () => {
    const log = vi.fn();
    // Env types vars as strings; wrangler passes a JSON number through as a number.
    const asVar = (v: unknown) => v as string;
    expect(ceiling(env({ DAILY_TURNS: asVar(400) }), "turns", log)).toBe(400);
    expect(ceiling(env({ DAILY_TTS_CHARS: asVar(0) }), "tts_chars", log)).toBe(0);
    expect(turnsPerIp(env({ DAILY_TURNS_PER_IP: asVar(10) }), log)).toBe(10);
    expect(log).not.toHaveBeenCalled();
  });

  it("count a number that is not a whole number, or any other non-string, as 0 (paused), logged", () => {
    for (const v of [1.5, -5, NaN, 1e21, null, true, {}]) {
      const log = vi.fn();
      expect(ceiling(env({ DAILY_TURNS: v as unknown as string }), "turns", log), String(v)).toBe(0);
      expect(log).toHaveBeenCalledWith("error", expect.stringMatching(/^DAILY_TURNS is not a whole number/));
    }
  });

  it("use the default when the var is missing", () => {
    const log = vi.fn();
    expect(ceiling(env({}), "turns", log)).toBe(400);
    expect(ceiling(env({}), "voice_seconds", log)).toBe(1800);
    expect(ceiling(env({}), "tts_chars", log)).toBe(60_000);
    expect(turnsPerIp(env({}), log)).toBe(60);
    expect(log).not.toHaveBeenCalled();
  });

  it("count a var that is set but not a whole number as 0 (paused), and log an error naming it", () => {
    for (const v of ["", "abc", "-5", "1.5", "1e3", "400 turns"]) {
      const log = vi.fn();
      expect(ceiling(env({ DAILY_TURNS: v }), "turns", log), JSON.stringify(v)).toBe(0);
      expect(turnsPerIp(env({ DAILY_TURNS_PER_IP: v }), log)).toBe(0);
      expect(log.mock.calls).toEqual([
        ["error", expect.stringMatching(/^DAILY_TURNS is not a whole number/)],
        ["error", expect.stringMatching(/^DAILY_TURNS_PER_IP is not a whole number/)],
      ]);
    }
  });
});

describe("spendTurn", () => {
  it("spends one of the visitor's turns and one of everyone's, keyed by a hash, never the IP", async () => {
    const db = sqliteD1();
    expect(await spendTurn(envOf(db), IP, vi.fn())).toBe("ok");
    expect(await used(db, "turns", utcDay(Date.now()))).toBe(1);
    expect(visitorRows(db)).toEqual([{ day: utcDay(Date.now()), ip_hash: expect.stringMatching(/^[0-9a-f]{64}$/), used: 1 }]);
    expect(JSON.stringify(db.sqlite.prepare("SELECT * FROM daily_ip").all())).not.toContain(IP);
  });

  it("counts each visitor apart: one visitor's day does not end another's", async () => {
    const db = sqliteD1();
    const e = envOf(db, { DAILY_TURNS_PER_IP: "2" });
    const results = [];
    for (const ip of [IP, IP, IP, "203.0.113.8"]) results.push(await spendTurn(e, ip, vi.fn()));
    expect(results).toEqual(["ok", "ok", "limit", "ok"]);
  });

  it("refused for the visitor while everyone's succeeds: limit, and everyone's turn is given back", async () => {
    const db = sqliteD1();
    const e = envOf(db, { DAILY_TURNS_PER_IP: "1" });
    expect(await spendTurn(e, IP, vi.fn())).toBe("ok");
    expect(await spendTurn(e, IP, vi.fn())).toBe("limit");
    expect(await used(db, "turns", utcDay(Date.now()))).toBe(1);
    expect(visitorRows(db).map((r) => r.used)).toEqual([1]);
  });

  it("refused for everyone while the visitor's succeeds: resting, and the visitor's turn is given back", async () => {
    const db = sqliteD1();
    const e = envOf(db, { DAILY_TURNS: "1" });
    expect(await spendTurn(e, "203.0.113.8", vi.fn())).toBe("ok");
    expect(await spendTurn(e, IP, vi.fn())).toBe("resting");
    expect(await used(db, "turns", utcDay(Date.now()))).toBe(1);
    expect(visitorRows(db).map((r) => r.used).sort()).toEqual([0, 1]);
  });

  it("is resting when both are refused", async () => {
    const e = envOf(sqliteD1(), { DAILY_TURNS: "0", DAILY_TURNS_PER_IP: "0" });
    expect(await spendTurn(e, IP, vi.fn())).toBe("resting");
  });

  it("fails closed as resting without IP_HASH_KEY, giving everyone's turn back, and logs why", async () => {
    const db = sqliteD1();
    const log = vi.fn();
    expect(await spendTurn(envOf(db, { IP_HASH_KEY: " " }), IP, log)).toBe("resting");
    expect(await used(db, "turns", utcDay(Date.now()))).toBe(0);
    expect(visitorRows(db)).toEqual([]);
    expect(log).toHaveBeenCalledWith("error", "ledger failed: IP_HASH_KEY is not set");
  });

  it("fails closed as resting when the database fails, and logs why", async () => {
    const log = vi.fn();
    expect(await spendTurn(envOf(brokenDb()), IP, log)).toBe("resting");
    expect(log).toHaveBeenCalledWith("error", "ledger failed: D1 unavailable");
  });

  it("runs the two spends concurrently: one D1 round trip of wall time, not two", async () => {
    const db = sqliteD1();
    const pending: (() => void)[] = [];
    const held = {
      prepare(sql: string) {
        const stmt = db.prepare(sql);
        return {
          bind: (...values: unknown[]) => {
            const bound = stmt.bind(...values);
            return {
              first: () => new Promise((resolve) => pending.push(() => resolve(bound.first()))),
              run: () => bound.run(),
            };
          },
        };
      },
    } as unknown as D1Database;
    const result = spendTurn(envOf(held), IP, vi.fn());
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    for (const release of pending) release();
    expect(await result).toBe("ok");
  });

  it("gives a refused turn back to the day it was spent from, even when the refund runs after UTC midnight", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 8, 23, 59, 59, 900), toFake: ["Date"] });
    const db = sqliteD1();
    await spend(db, "turns", 5, 400, "2026-11-09"); // the new day already has turns of its own
    // The clock passes midnight while the spends are in flight, so the refund runs on the new day.
    const crossing = {
      prepare(sql: string) {
        const stmt = db.prepare(sql);
        return {
          bind: (...values: unknown[]) => {
            const bound = stmt.bind(...values);
            return {
              first: async () => {
                const row = await bound.first();
                vi.setSystemTime(Date.UTC(2026, 10, 9, 0, 0, 0, 100));
                return row;
              },
              run: () => bound.run(),
            };
          },
        };
      },
    } as unknown as D1Database;
    expect(await spendTurn(envOf(crossing, { DAILY_TURNS_PER_IP: "0" }), IP, vi.fn())).toBe("limit");
    expect(utcDay(Date.now())).toBe("2026-11-09");
    expect(rows(db)).toEqual([
      { day: DAY, unit: "turns", used: 0 },
      { day: "2026-11-09", unit: "turns", used: 5 },
    ]);
  });
});

describe("reserve and release", () => {
  it("reserve takes n of today's unit and says which day; null once it would pass the ceiling", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 8, 12), toFake: ["Date"] });
    const db = sqliteD1();
    const e = envOf(db, { DAILY_VOICE_SECONDS: "30" });
    expect(await reserve(e, "voice_seconds", 15, vi.fn())).toBe(DAY);
    expect(await reserve(e, "voice_seconds", 15, vi.fn())).toBe(DAY);
    expect(await reserve(e, "voice_seconds", 15, vi.fn())).toBeNull();
    expect(await used(db, "voice_seconds", DAY)).toBe(30);
  });

  it("release gives back to the day reserved from, never the new day after midnight", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 8, 23, 59, 59), toFake: ["Date"] });
    const db = sqliteD1();
    const e = envOf(db);
    const day = await reserve(e, "tts_chars", 500, vi.fn());
    vi.setSystemTime(Date.UTC(2026, 10, 9, 0, 0, 1));
    await reserve(e, "tts_chars", 500, vi.fn());
    await release(e, "tts_chars", 420, day ?? "", vi.fn());
    expect(rows(db)).toEqual([
      { day: DAY, unit: "tts_chars", used: 80 },
      { day: "2026-11-09", unit: "tts_chars", used: 500 },
    ]);
  });

  it("fail closed: reserve is null and release only logs when the database fails", async () => {
    const log = vi.fn();
    expect(await reserve(envOf(brokenDb()), "voice_seconds", 15, log)).toBeNull();
    await release(envOf(brokenDb()), "voice_seconds", 15, DAY, log);
    expect(log.mock.calls).toEqual([
      ["error", "ledger failed: D1 unavailable"],
      ["error", "ledger failed: D1 unavailable"],
    ]);
  });
});

describe("restingToday", () => {
  it("rests once today's (UTC) turns are used, so the ceiling resets at UTC midnight", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 8, 23, 59, 59) });
    const e = envOf(sqliteD1(), { DAILY_TURNS: "1" });
    const log = vi.fn();
    expect(await restingToday(e, log)).toBe(false);
    expect(await spendTurn(e, IP, log)).toBe("ok");
    expect(await spendTurn(e, IP, log)).toBe("resting");
    expect(await restingToday(e, log)).toBe(true);
    vi.setSystemTime(Date.UTC(2026, 10, 9, 0, 0, 0));
    expect(await restingToday(e, log)).toBe(false);
    expect(await spendTurn(e, IP, log)).toBe("ok");
    expect(log).not.toHaveBeenCalled();
  });

  it("rests when DAILY_TURNS is 0, or is not a whole number", async () => {
    expect(await restingToday(envOf(sqliteD1(), { DAILY_TURNS: "0" }), vi.fn())).toBe(true);
    expect(await restingToday(envOf(sqliteD1(), { DAILY_TURNS: "40O" }), vi.fn())).toBe(true);
  });

  it("fails closed as resting when the database fails, and logs why", async () => {
    const log = vi.fn();
    expect(await restingToday(envOf(brokenDb()), log)).toBe(true);
    expect(log.mock.calls).toEqual([["error", "ledger failed: D1 unavailable"]]);
  });
});

describe("voiceRestingToday", () => {
  const today = () => utcDay(Date.now());

  it("is false while another audio block and another reply's speech both fit today", async () => {
    expect(await voiceRestingToday(envOf(sqliteD1()), IP, vi.fn())).toBe(false);
  });

  it("is true once less than one 15 s audio block is left", async () => {
    const db = sqliteD1();
    await spend(db, "voice_seconds", 6, 1800, today());
    expect(await voiceRestingToday(envOf(db, { DAILY_VOICE_SECONDS: "21" }), IP, vi.fn())).toBe(false);
    expect(await voiceRestingToday(envOf(db, { DAILY_VOICE_SECONDS: "20" }), IP, vi.fn())).toBe(true);
  });

  it("is true once less than one reply's 500 spoken characters is left", async () => {
    const db = sqliteD1();
    await spend(db, "tts_chars", 100, 60_000, today());
    expect(await voiceRestingToday(envOf(db, { DAILY_TTS_CHARS: "600" }), IP, vi.fn())).toBe(false);
    expect(await voiceRestingToday(envOf(db, { DAILY_TTS_CHARS: "599" }), IP, vi.fn())).toBe(true);
  });

  it("is true when either ceiling is 0, and when the database fails (fails closed)", async () => {
    expect(await voiceRestingToday(envOf(sqliteD1(), { DAILY_VOICE_SECONDS: "0" }), IP, vi.fn())).toBe(true);
    expect(await voiceRestingToday(envOf(sqliteD1(), { DAILY_TTS_CHARS: "0" }), IP, vi.fn())).toBe(true);
    const log = vi.fn();
    expect(await voiceRestingToday(envOf(brokenDb()), IP, log)).toBe(true);
    expect(log).toHaveBeenCalledWith("error", "ledger failed: D1 unavailable");
  });
});

const voiceKeyRows = (db: ReturnType<typeof sqliteD1>) => visitorRows(db).map((r) => ({ day: r.day, used: r.used }));

describe("voiceSecondsPerIp", () => {
  it("is 600 when missing, the number when whole, and 0 with an error logged when invalid", () => {
    const log = vi.fn();
    expect(voiceSecondsPerIp({} as Env, log)).toBe(600);
    expect(voiceSecondsPerIp({ DAILY_VOICE_SECONDS_PER_IP: " 90 " } as Env, log)).toBe(90);
    expect(voiceSecondsPerIp({ DAILY_VOICE_SECONDS_PER_IP: 90 as unknown as string } as Env, log)).toBe(90);
    expect(log).not.toHaveBeenCalled();
    expect(voiceSecondsPerIp({ DAILY_VOICE_SECONDS_PER_IP: "6OO" } as Env, log)).toBe(0);
    expect(log).toHaveBeenCalledWith("error", expect.stringContaining("DAILY_VOICE_SECONDS_PER_IP"));
  });
});

describe("reserveAudio and releaseAudio", () => {
  const at = (hour: number) => vi.useFakeTimers({ now: Date.UTC(2026, 10, 8, hour), toFake: ["Date"] });

  it("takes a block from everyone's seconds and the visitor's, keyed by a hash, never the IP", async () => {
    at(12);
    const db = sqliteD1();
    expect(await reserveAudio(envOf(db), IP, 15, vi.fn())).toBe(DAY);
    expect(await used(db, "voice_seconds", DAY)).toBe(15);
    expect(visitorRows(db)).toEqual([{ day: DAY, ip_hash: expect.stringMatching(/^[0-9a-f]{64}$/), used: 15 }]);
    expect(JSON.stringify(visitorRows(db))).not.toContain(IP);
  });

  it("keeps its row apart from the visitor's turns row, with no schema change", async () => {
    at(12);
    const db = sqliteD1();
    const e = envOf(db);
    await spendTurn(e, IP, vi.fn());
    await reserveAudio(e, IP, 15, vi.fn());
    expect(voiceKeyRows(db).map((r) => r.used).sort()).toEqual([1, 15]);
  });

  it("refuses once the visitor's own seconds run out while everyone's remain, and gives everyone's block back", async () => {
    at(12);
    const db = sqliteD1();
    const e = envOf(db, { DAILY_VOICE_SECONDS_PER_IP: "30" });
    expect(await reserveAudio(e, IP, 15, vi.fn())).toBe(DAY);
    expect(await reserveAudio(e, IP, 15, vi.fn())).toBe(DAY);
    expect(await reserveAudio(e, IP, 15, vi.fn())).toBeNull();
    expect(await used(db, "voice_seconds", DAY)).toBe(30);
    expect(voiceKeyRows(db)).toEqual([{ day: DAY, used: 30 }]);
    expect(await reserveAudio(e, "203.0.113.8", 15, vi.fn())).toBe(DAY); // another visitor still has the day
    expect(await used(db, "voice_seconds", DAY)).toBe(45);
  });

  it("refuses once everyone's seconds run out while the visitor's remain, and gives the visitor's block back", async () => {
    at(12);
    const db = sqliteD1();
    const e = envOf(db, { DAILY_VOICE_SECONDS: "30" });
    expect(await reserveAudio(e, IP, 15, vi.fn())).toBe(DAY);
    expect(await reserveAudio(e, IP, 15, vi.fn())).toBe(DAY);
    expect(await reserveAudio(e, "203.0.113.8", 15, vi.fn())).toBeNull();
    expect(await used(db, "voice_seconds", DAY)).toBe(30);
    expect(voiceKeyRows(db).map((r) => Number(r.used)).sort((a, b) => a - b)).toEqual([0, 30]);
  });

  it("fails closed without IP_HASH_KEY or when the database fails, giving back what succeeded, and logs why", async () => {
    at(12);
    const db = sqliteD1();
    const log = vi.fn();
    expect(await reserveAudio(envOf(db, { IP_HASH_KEY: "" }), IP, 15, log)).toBeNull();
    expect(await used(db, "voice_seconds", DAY)).toBe(0);
    expect(log).toHaveBeenCalledWith("error", "ledger failed: IP_HASH_KEY is not set");
    expect(await reserveAudio(envOf(brokenDb()), IP, 15, log)).toBeNull();
  });

  it("releases the unused part of both to the day reserved from, never the new day after midnight", async () => {
    at(23);
    vi.setSystemTime(Date.UTC(2026, 10, 8, 23, 59, 59));
    const db = sqliteD1();
    const e = envOf(db);
    const day = await reserveAudio(e, IP, 15, vi.fn());
    vi.setSystemTime(Date.UTC(2026, 10, 9, 0, 0, 1));
    await reserveAudio(e, IP, 15, vi.fn()); // the new day's own block
    await releaseAudio(e, IP, 11, day ?? "", vi.fn());
    expect(rows(db)).toEqual([
      { day: DAY, unit: "voice_seconds", used: 4 },
      { day: "2026-11-09", unit: "voice_seconds", used: 15 },
    ]);
    expect(voiceKeyRows(db)).toEqual([
      { day: DAY, used: 4 },
      { day: "2026-11-09", used: 15 },
    ]);
  });

  it("logs a failed release without throwing", async () => {
    const log = vi.fn();
    await releaseAudio(envOf(brokenDb()), IP, 5, DAY, log);
    expect(log).toHaveBeenCalledWith("error", "ledger failed: D1 unavailable");
  });
});

describe("voiceRestingToday for a visitor", () => {
  it("is true once the visitor has less than one block left, though everyone's seconds remain", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 8, 12), toFake: ["Date"] });
    const db = sqliteD1();
    const e = envOf(db, { DAILY_VOICE_SECONDS_PER_IP: "30" });
    await reserveAudio(e, IP, 15, vi.fn());
    expect(await voiceRestingToday(e, IP, vi.fn())).toBe(false);
    await reserveAudio(e, IP, 15, vi.fn());
    expect(await voiceRestingToday(e, IP, vi.fn())).toBe(true);
    expect(await voiceRestingToday(e, "203.0.113.8", vi.fn())).toBe(false);
  });

  it("is true when the cap is 0, and fails closed without IP_HASH_KEY", async () => {
    expect(await voiceRestingToday(envOf(sqliteD1(), { DAILY_VOICE_SECONDS_PER_IP: "0" }), IP, vi.fn())).toBe(true);
    const log = vi.fn();
    expect(await voiceRestingToday(envOf(sqliteD1(), { IP_HASH_KEY: "" }), IP, log)).toBe(true);
    expect(log).toHaveBeenCalledWith("error", "ledger failed: IP_HASH_KEY is not set");
  });
});
