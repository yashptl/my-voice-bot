import { afterEach, describe, expect, it, vi } from "vitest";
import { VOICE_FORMAT } from "../protocol/audio";
import { createFakeTts } from "./fake-tts";

function recorder() {
  const log: string[] = [];
  const bytes = new Map<number, number>();
  const chunks: number[] = [];
  return {
    log,
    bytes,
    chunks,
    onAudio(id: number, pcm: Uint8Array) {
      log.push(`audio ${id}`);
      chunks.push(pcm.byteLength);
      bytes.set(id, (bytes.get(id) ?? 0) + pcm.byteLength);
    },
    onSentenceDone(id: number) {
      log.push(`done ${id}`);
    },
    onError(e: Error) {
      log.push(`error ${e.message}`);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createFakeTts", () => {
  it("is a 24 kHz port with id fake", () => {
    const tts = createFakeTts();
    expect(tts.id).toBe("fake");
    expect(tts.format).toEqual(VOICE_FORMAT);
  });

  it("emits 60 ms of silence per character in 100 ms chunks, then one sentence-done", async () => {
    const r = recorder();
    const session = await createFakeTts({ msPerChar: 0 }).open(r);
    session.speak(0, "abcd");
    await session.finish();
    expect(r.bytes.get(0)).toBe(11_520); // 4 × 60 ms × 24000 × 2 / 1000
    expect(r.chunks).toEqual([4800, 4800, 1920]);
    expect(r.log.filter((l) => l === "done 0")).toHaveLength(1);
    expect(r.log.at(-1)).toBe("done 0");
  });

  it("emits silence (all zero bytes)", async () => {
    const pcm: number[] = [];
    const session = await createFakeTts({ msPerChar: 0 }).open({
      onAudio: (_id, chunk) => pcm.push(...chunk),
      onSentenceDone: () => {},
      onError: () => {},
    });
    session.speak(0, "a");
    await session.finish();
    expect(pcm.length).toBe(2880);
    expect(pcm.every((b) => b === 0)).toBe(true);
  });

  it("synthesizes queued sentences one after another, in order", async () => {
    const r = recorder();
    const session = await createFakeTts({ msPerChar: 0 }).open(r);
    session.speak(0, "ab");
    session.speak(1, "c");
    await session.finish();
    expect(r.log).toEqual(["audio 0", "audio 0", "done 0", "audio 1", "done 1"]);
  });

  it("takes msPerChar per character before a sentence's audio", async () => {
    vi.useFakeTimers();
    const r = recorder();
    const session = await createFakeTts({ msPerChar: 2 }).open(r);
    session.speak(0, "abcd");
    await vi.advanceTimersByTimeAsync(7);
    expect(r.log).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.log).toContain("done 0");
  });

  it("resolves finish at once when nothing was spoken", async () => {
    const session = await createFakeTts().open(recorder());
    await expect(session.finish()).resolves.toBeUndefined();
  });

  it("stops on cancel: no audio afterwards, and finish resolves", async () => {
    vi.useFakeTimers();
    const r = recorder();
    const session = await createFakeTts({ msPerChar: 2 }).open(r);
    session.speak(0, "abcd");
    session.speak(1, "efgh");
    const finished = session.finish();
    await vi.advanceTimersByTimeAsync(8);
    session.cancel();
    session.speak(2, "late");
    await vi.advanceTimersByTimeAsync(100);
    await expect(finished).resolves.toBeUndefined();
    expect(r.log.some((l) => l.endsWith(" 1") || l.endsWith(" 2"))).toBe(false);
  });
});
