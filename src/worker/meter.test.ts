import { describe, expect, it } from "vitest";
import { AudioMeter } from "./meter";

const BPS = 32000; // 16 kHz s16le mono
const FRAME = 2560; // 80 ms

function clock(start = 0) {
  let t = start;
  return {
    now: () => t,
    set: (ms: number) => void (t = ms),
    advance: (ms: number) => void (t += ms),
  };
}

const meterAt = (c: ReturnType<typeof clock>, maxSeconds = 600) =>
  new AudioMeter({ maxSeconds, bytesPerSecond: BPS, now: c.now });

/** Sends `seconds` of 80 ms frames in real time; returns every result. */
function stream(meter: AudioMeter, c: ReturnType<typeof clock>, seconds: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.round(seconds / 0.08); i++) {
    out.push(meter.add(FRAME));
    c.advance(80);
  }
  return out;
}

describe("AudioMeter", () => {
  it("accepts 10 s of audio sent over 10 s and counts 10 s", () => {
    const c = clock();
    const meter = meterAt(c);
    const results = stream(meter, c, 10);
    expect(results.every((r) => r === "ok")).toBe(true);
    expect(meter.seconds).toBe(10);
  });

  it("calls 30 s of audio sent at t = 1 s too fast, and does not count it", () => {
    const c = clock(1000);
    const meter = meterAt(c);
    expect(meter.add(30 * BPS)).toBe("too_fast");
    expect(meter.seconds).toBe(0);
  });

  it("lets a client run at most 5 s ahead of real time", () => {
    const c = clock(1000);
    const meter = meterAt(c);
    const results: string[] = [];
    for (let i = 0; i < 80; i++) results.push(meter.add(FRAME)); // 6.4 s of frames, all at once
    expect(results.filter((r) => r === "ok")).toHaveLength(62); // 62 × 80 ms = 4.96 s
    expect(results.slice(62).every((r) => r === "too_fast")).toBe(true);
    expect(meter.seconds).toBeCloseTo(4.96, 6);

    c.advance(800); // real time catches up by 10 frames
    const later = Array.from({ length: 12 }, () => meter.add(FRAME));
    expect(later.filter((r) => r === "ok")).toHaveLength(10);
  });

  it("lets a client catch up after a network stall: the backlog arrives at once and is all kept", () => {
    const c = clock();
    const meter = meterAt(c);
    expect(stream(meter, c, 2).every((r) => r === "ok")).toBe(true);
    c.advance(10_000); // a 10 s mobile stall: the client keeps recording, nothing arrives
    const backlog = Array.from({ length: 125 }, () => meter.add(FRAME)); // the 10 s, all at once
    expect(backlog.every((r) => r === "ok")).toBe(true);
    expect(meter.seconds).toBe(12);
    expect(stream(meter, c, 2).every((r) => r === "ok")).toBe(true); // and real time carries on
  });

  it("allows no more than real time since the first frame plus the lead, over the whole conversation", () => {
    const c = clock();
    const meter = meterAt(c);
    meter.add(FRAME); // the first frame starts the clock
    c.advance(60_000);
    // A minute later the client may have sent at most 60 s + 5 s of audio.
    const results = Array.from({ length: 820 }, () => meter.add(FRAME));
    const ok = results.filter((r) => r === "ok").length;
    expect((ok + 1) * 0.08).toBeLessThanOrEqual(65);
    expect((ok + 2) * 0.08).toBeGreaterThan(65);
    expect(results.at(-1)).toBe("too_fast");
  });

  it("says limit once the total would cross maxSeconds, and keeps saying it", () => {
    const c = clock();
    const meter = meterAt(c, 2);
    const results = stream(meter, c, 2.4);
    expect(results.slice(0, 25).every((r) => r === "ok")).toBe(true);
    expect(results[25]).toBe("limit");
    c.advance(60_000);
    expect(meter.add(FRAME)).toBe("limit");
    expect(meter.add(2)).toBe("limit");
    expect(meter.seconds).toBe(2);
  });

  it("refuses a single frame larger than what is left", () => {
    const c = clock();
    const meter = meterAt(c, 1);
    expect(meter.add(BPS / 2)).toBe("ok");
    c.advance(1000);
    expect(meter.add(BPS)).toBe("limit");
    // Sticky: a smaller frame that would still fit is refused too, so the conversation stays over.
    expect(meter.add(FRAME)).toBe("limit");
    expect(meter.seconds).toBe(0.5);
  });

  describe("across reconnects (a restored meter)", () => {
    it("keeps the total, so a new socket cannot reset the limit", () => {
      const c = clock();
      const first = meterAt(c, 10);
      stream(first, c, 9.6);
      const second = new AudioMeter({ maxSeconds: 10, bytesPerSecond: BPS, now: c.now, state: first.state });
      expect(second.seconds).toBeCloseTo(9.6, 6);
      const results = stream(second, c, 1);
      expect(results.slice(0, 5).every((r) => r === "ok")).toBe(true);
      expect(results[5]).toBe("limit");
    });

    it("keeps the real-time allowance, so reconnecting gives no extra burst", () => {
      const c = clock();
      const first = meterAt(c);
      for (let i = 0; i < 62; i++) first.add(FRAME); // spend the whole 5 s lead at once
      const second = new AudioMeter({ maxSeconds: 600, bytesPerSecond: BPS, now: c.now, state: first.state });
      expect(second.add(FRAME)).toBe("too_fast");
    });

    it("state is plain JSON (it is stored in the Durable Object)", () => {
      const c = clock(5);
      const meter = meterAt(c);
      meter.add(FRAME);
      const state = JSON.parse(JSON.stringify(meter.state)) as typeof meter.state;
      const restored = new AudioMeter({ maxSeconds: 600, bytesPerSecond: BPS, now: c.now, state });
      expect(restored.state).toEqual(meter.state);
      expect(restored.seconds).toBe(meter.seconds);
    });
  });
});
