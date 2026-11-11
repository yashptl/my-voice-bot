import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Downsampler as DownsamplerType } from "./capture-worklet.js";

/** Stand-in for the processor's MessagePort. */
class FakePort {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  readonly posted: { data: unknown; transfer: unknown[] }[] = [];
  postMessage(data: unknown, transfer: unknown[] = []): void {
    this.posted.push({ data, transfer });
  }
}

interface Processor {
  port: FakePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

const registered = new Map<string, new () => Processor>();
let Downsampler: typeof DownsamplerType;

// The worklet runs in AudioWorkletGlobalScope; provide the globals it reads before loading it.
beforeAll(async () => {
  vi.stubGlobal("sampleRate", 48000);
  vi.stubGlobal(
    "AudioWorkletProcessor",
    class {
      port = new FakePort();
    },
  );
  vi.stubGlobal("registerProcessor", (name: string, cls: new () => Processor) => registered.set(name, cls));
  ({ Downsampler } = await import("./capture-worklet.js"));
});

function tone(hz: number, rate: number, seconds: number, amplitude: number): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

/** Feeds `input` in 128-sample render quanta, as the audio thread does. */
function pushInQuanta(ds: DownsamplerType, input: Float32Array): Int16Array[] {
  const frames: Int16Array[] = [];
  for (let i = 0; i < input.length; i += 128) frames.push(...ds.push(input.subarray(i, i + 128)));
  return frames;
}

function peak(frame: Int16Array): number {
  return Math.max(...frame.map((s) => Math.abs(s)));
}

function zeroCrossings(frame: Int16Array): number {
  let n = 0;
  for (let i = 1; i < frame.length; i++) if (Math.sign(frame[i] ?? 0) !== Math.sign(frame[i - 1] ?? 0)) n++;
  return n;
}

describe("Downsampler", () => {
  it("turns 80 ms of 48 kHz input into one 1280-sample frame", () => {
    const ds = new Downsampler(48000);
    expect(pushInQuanta(ds, new Float32Array(29 * 128))).toEqual([]);
    const frames = ds.push(new Float32Array(128));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toBeInstanceOf(Int16Array);
    expect(frames[0]?.length).toBe(1280);
  });

  it("produces 16 kHz output from 44.1 kHz input", () => {
    const frames = pushInQuanta(new Downsampler(44100), new Float32Array(2 * 44100));
    expect(frames).toHaveLength(25); // 2 s = 32000 samples = 25 frames
  });

  it("keeps a speech-band tone's pitch and level", () => {
    const frame = pushInQuanta(new Downsampler(48000), tone(440, 48000, 1, 0.5))[5];
    if (!frame) throw new Error("expected frame 5");
    expect(zeroCrossings(frame)).toBeGreaterThanOrEqual(69); // 440 Hz over 80 ms ≈ 70.4 crossings
    expect(zeroCrossings(frame)).toBeLessThanOrEqual(72);
    expect(peak(frame)).toBeGreaterThan(0.5 * 32767 * 0.97);
    expect(peak(frame)).toBeLessThan(0.5 * 32767 * 1.03);
  });

  it("filters out a tone above 8 kHz instead of aliasing it", () => {
    const frame = pushInQuanta(new Downsampler(48000), tone(12000, 48000, 1, 0.5))[5];
    if (!frame) throw new Error("expected frame 5");
    expect(peak(frame)).toBeLessThan(0.01 * 0.5 * 32767);
  });

  it("clips input beyond full scale", () => {
    const loud = pushInQuanta(new Downsampler(48000), new Float32Array(2 * 3840).fill(2))[1];
    const quiet = pushInQuanta(new Downsampler(48000), new Float32Array(2 * 3840).fill(-2))[1];
    expect(new Set(loud)).toEqual(new Set([32767]));
    expect(new Set(quiet)).toEqual(new Set([-32768]));
  });
});

describe("capture processor", () => {
  function processor(): Processor {
    const Capture = registered.get("capture");
    if (!Capture) throw new Error("capture processor not registered");
    return new Capture();
  }

  it("posts each 80 ms frame as a transferred 2560-byte buffer", () => {
    const p = processor();
    for (let i = 0; i < 30; i++) p.process([[new Float32Array(128).fill(0.25)]], [[new Float32Array(128)]]);
    expect(p.port.posted).toHaveLength(1);
    const [{ data, transfer } = { data: null, transfer: [] }] = p.port.posted;
    expect(data).toBeInstanceOf(ArrayBuffer);
    expect((data as ArrayBuffer).byteLength).toBe(2560);
    expect(transfer).toEqual([data]);
    expect(new Int16Array(data as ArrayBuffer).at(-1)).toBeCloseTo(0.25 * 32767, -1);
  });

  it("captures silence when the input has no channels, so frames keep flowing in real time", () => {
    const p = processor();
    for (let i = 0; i < 60; i++) expect(p.process([[]], [[new Float32Array(128)]])).toBe(true);
    expect(p.port.posted).toHaveLength(2);
    expect(new Set(new Int16Array(p.port.posted[1]?.data as ArrayBuffer))).toEqual(new Set([0]));
  });

  it("stops processing when told to stop", () => {
    const p = processor();
    p.port.onmessage?.({ data: "stop" });
    expect(p.process([[]], [[new Float32Array(128)]])).toBe(false);
  });
});
