import { describe, expect, it } from "vitest";
import { decodeAudioFrame, encodeAudioFrame } from "./audio";

describe("audio frames", () => {
  it("round-trips a sentence id and PCM", () => {
    const frame = decodeAudioFrame(encodeAudioFrame(7, new Uint8Array([1, 2, 3, 4])));
    expect(frame.sentenceId).toBe(7);
    expect([...frame.pcm]).toEqual([1, 2, 3, 4]);
  });

  it("round-trips the largest u32 sentence id", () => {
    expect(decodeAudioFrame(encodeAudioFrame(2 ** 32 - 1, new Uint8Array())).sentenceId).toBe(2 ** 32 - 1);
  });

  it("writes the sentence id as a little-endian u32 header", () => {
    expect([...new Uint8Array(encodeAudioFrame(258, new Uint8Array([9])))]).toEqual([2, 1, 0, 0, 9]);
  });

  it.each([-1, 2 ** 32, 1.5, Number.NaN])("rejects sentence id %d", (id) => {
    expect(() => encodeAudioFrame(id, new Uint8Array())).toThrow(RangeError);
  });

  it("rejects a frame shorter than the header", () => {
    expect(() => decodeAudioFrame(new ArrayBuffer(3))).toThrow(RangeError);
  });
});
