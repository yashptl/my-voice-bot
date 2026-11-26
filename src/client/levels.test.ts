import { describe, expect, it } from "vitest";
import { Meter } from "./levels";
import { FakeAnalyser } from "./testing";

/** At 48 kHz and fftSize 512, a bin is 93.75 Hz wide; five bands from 100 Hz to 4 kHz take bins 1, 2-4, 5-9, 10-19 and 20-42. */
function meter(bins: Record<number, number> = {}) {
  const analyser = new FakeAnalyser();
  const m = new Meter(analyser);
  analyser.bins = new Uint8Array(analyser.frequencyBinCount);
  for (const [i, v] of Object.entries(bins)) analyser.bins[Number(i)] = v;
  return { m, analyser };
}

const fill = (from: number, to: number, value: number) =>
  Object.fromEntries(Array.from({ length: to - from }, (_, i) => [from + i, value]));

describe("Meter", () => {
  it("sets the analyser to a 512-point FFT smoothed at 0.6", () => {
    const { analyser } = meter();
    expect(analyser.fftSize).toBe(512);
    expect(analyser.smoothingTimeConstant).toBe(0.6);
  });

  it("reads silence as zeros and a full spectrum as ones", () => {
    const out = new Float32Array(5);
    meter().m.read(out);
    expect([...out]).toEqual([0, 0, 0, 0, 0]);
    meter(fill(0, 256, 255)).m.read(out);
    expect([...out]).toEqual([1, 1, 1, 1, 1]);
  });

  it("splits 100 Hz to 4 kHz into log-spaced bands, each the mean of its bins", () => {
    const out = new Float32Array(5);
    meter({ 1: 255 }).m.read(out);
    expect([...out]).toEqual([1, 0, 0, 0, 0]);
    meter({ ...fill(2, 5, 255), 5: 255 }).m.read(out);
    expect(out[1]).toBe(1);
    expect(out[2]).toBeCloseTo(0.2, 6);
    meter(fill(20, 43, 51)).m.read(out);
    expect([...out.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    expect(out[4]).toBeCloseTo(0.2, 6);
  });

  it("ignores the DC bin and everything above 4 kHz", () => {
    const out = new Float32Array(5);
    meter({ 0: 255, ...fill(43, 256, 255) }).m.read(out);
    expect([...out]).toEqual([0, 0, 0, 0, 0]);
  });

  it("fills any number of bands, each from 0 to 1", () => {
    const { m } = meter(fill(0, 256, 128));
    for (const n of [1, 3, 64]) {
      const out = new Float32Array(n).fill(-1);
      m.read(out);
      expect(out.every((v) => v >= 0 && v <= 1)).toBe(true);
    }
    expect(() => m.read(new Float32Array(0))).not.toThrow();
  });

  it("reads into the same buffer every time", () => {
    const { m, analyser } = meter();
    m.read(new Float32Array(5));
    m.read(new Float32Array(5));
    expect(analyser.reads).toHaveLength(2);
    expect(analyser.reads[0]).toBe(analyser.reads[1]);
  });
});
