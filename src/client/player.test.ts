import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VOICE_FORMAT } from "../protocol/audio";
import { Player, nextStartTime } from "./player";

/** 24 kHz s16le PCM: `samples` samples of value `value`. */
function pcm(samples: number, value = 0): Uint8Array {
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, value, true);
  return bytes;
}

class FakeBuffer {
  readonly data: Float32Array;
  constructor(
    length: number,
    readonly sampleRate: number,
  ) {
    this.data = new Float32Array(length);
  }
  getChannelData(): Float32Array {
    return this.data;
  }
}

class FakeSource {
  buffer: FakeBuffer | null = null;
  destination: object | null = null;
  startedAt: number | null = null;
  stopped = false;
  private readonly endedListeners: (() => void)[] = [];
  connect(destination: object): void {
    this.destination = destination;
  }
  start(when = 0): void {
    this.startedAt = when;
  }
  stop(): void {
    this.stopped = true;
  }
  addEventListener(_type: "ended", fn: () => void): void {
    this.endedListeners.push(fn);
  }
  /** What the browser does when the chunk finishes (or after stop()). */
  end(): void {
    for (const fn of this.endedListeners) fn();
  }
}

class FakeContext {
  currentTime = 1;
  readonly destination = {};
  readonly sources: FakeSource[] = [];
  createBuffer(_channels: number, length: number, sampleRate: number): FakeBuffer {
    return new FakeBuffer(length, sampleRate);
  }
  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
}

describe("nextStartTime", () => {
  it("starts a lead after now when the queue is empty", () => {
    expect(nextStartTime(1.0, 0.5, 80)).toBeCloseTo(1.08, 9);
  });

  it("starts where the queue ends when audio is still queued", () => {
    expect(nextStartTime(1.0, 1.5, 80)).toBe(1.5);
  });
});

describe("Player", () => {
  let ctx: FakeContext;
  let player: Player;

  beforeEach(() => {
    vi.useFakeTimers();
    ctx = new FakeContext();
    player = new Player(ctx, VOICE_FORMAT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("decodes s16le PCM into float samples at the voice sample rate", () => {
    const bytes = new Uint8Array(8);
    const view = new DataView(bytes.buffer);
    [0, 16384, -32768, 32767].forEach((s, i) => view.setInt16(i * 2, s, true));
    player.enqueue(0, bytes);
    const buffer = ctx.sources[0]?.buffer;
    expect(buffer?.sampleRate).toBe(24000);
    expect([...(buffer?.data ?? [])]).toEqual([0, 0.5, -1, 32767 / 32768]);
  });

  it("reads PCM from a view at an offset, as decodeAudioFrame returns it", () => {
    const frame = new Uint8Array([9, 9, 9, 9, 0, 64]);
    player.enqueue(0, frame.subarray(4));
    expect([...(ctx.sources[0]?.buffer?.data ?? [])]).toEqual([0.5]);
  });

  it("plays the first chunk after the lead and later chunks back to back", () => {
    player.enqueue(0, pcm(2400));
    player.enqueue(0, pcm(2400));
    expect(ctx.sources.map((s) => s.startedAt)).toEqual([expect.closeTo(1.08, 9), expect.closeTo(1.18, 9)]);
    expect(ctx.sources[0]?.destination).toBe(ctx.destination);
  });

  it("starts after the lead again once the queue has run dry", () => {
    player.enqueue(0, pcm(2400));
    ctx.currentTime = 2;
    player.enqueue(1, pcm(2400));
    expect(ctx.sources[1]?.startedAt).toBeCloseTo(2.08, 9);
  });

  it("ignores an empty chunk", () => {
    player.enqueue(0, new Uint8Array());
    expect(ctx.sources).toHaveLength(0);
    expect(player.active).toBe(false);
  });

  it("reports each sentence when its first chunk starts playing", () => {
    const started: number[] = [];
    player.onSentenceStarted((id) => started.push(id));
    player.enqueue(0, pcm(2400));
    player.enqueue(0, pcm(2400));
    player.enqueue(1, pcm(2400));
    expect(player.lastStartedSentenceId).toBeNull();

    vi.advanceTimersByTime(79);
    expect(started).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(started).toEqual([0]);
    expect(player.lastStartedSentenceId).toBe(0);

    vi.advanceTimersByTime(200);
    expect(started).toEqual([0, 1]);
    expect(player.lastStartedSentenceId).toBe(1);
  });

  it("goes idle once every queued chunk has ended", () => {
    const onIdle = vi.fn();
    player.onIdle(onIdle);
    player.enqueue(0, pcm(2400));
    player.enqueue(1, pcm(2400));
    expect(player.active).toBe(true);

    ctx.sources[0]?.end();
    expect(onIdle).not.toHaveBeenCalled();
    ctx.sources[1]?.end();
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(player.active).toBe(false);
  });

  it("stop() stops every queued chunk and forgets the last started sentence", () => {
    player.enqueue(0, pcm(2400));
    player.enqueue(1, pcm(2400));
    vi.advanceTimersByTime(80);
    expect(player.lastStartedSentenceId).toBe(0);

    player.stop();
    expect(ctx.sources.map((s) => s.stopped)).toEqual([true, true]);
    expect(player.lastStartedSentenceId).toBeNull();
    expect(player.active).toBe(false);
  });

  it("stop() cancels reports for sentences that had not started", () => {
    const started: number[] = [];
    player.onSentenceStarted((id) => started.push(id));
    player.enqueue(0, pcm(2400));
    player.enqueue(1, pcm(2400));
    player.stop();
    vi.advanceTimersByTime(1000);
    expect(started).toEqual([]);
  });

  it("does not report idle for chunks that end because of stop()", () => {
    const onIdle = vi.fn();
    player.onIdle(onIdle);
    player.enqueue(0, pcm(2400));
    player.stop();
    ctx.sources[0]?.end();
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("starts fresh after stop()", () => {
    player.enqueue(0, pcm(24000));
    player.stop();
    player.enqueue(0, pcm(2400));
    expect(ctx.sources[1]?.startedAt).toBeCloseTo(1.08, 9);
  });
});
