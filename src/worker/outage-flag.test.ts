import { describe, expect, it } from "vitest";
import { sqliteD1 } from "../../tests/sqlite-d1";
import { clearOutage, markOutageAlerted, readOutage, setOutage } from "./outage-flag";

describe("the outage flag", () => {
  it("reads null while unset", async () => {
    expect(await readOutage(sqliteD1())).toBeNull();
  });

  it("is set once: true the first time, with the first reason and time kept after", async () => {
    const db = sqliteD1();
    expect(await setOutage(db, "llm_quota", 1000)).toBe(true);
    expect(await readOutage(db)).toEqual({ reason: "llm_quota", setAt: 1000, alerted: false });
    expect(await setOutage(db, "other", 2000)).toBe(false);
    expect(await readOutage(db)).toEqual({ reason: "llm_quota", setAt: 1000, alerted: false });
  });

  it("records that the owner's email went out", async () => {
    const db = sqliteD1();
    await setOutage(db, "llm_auth", 1000);
    await markOutageAlerted(db, 1500);
    expect(await readOutage(db)).toEqual({ reason: "llm_auth", setAt: 1000, alerted: true });
  });

  it("clears: true when it was set, false when not, and reads null after", async () => {
    const db = sqliteD1();
    await setOutage(db, "llm_auth", 1000);
    expect(await clearOutage(db)).toBe(true);
    expect(await clearOutage(db)).toBe(false);
    expect(await readOutage(db)).toBeNull();
  });
});
