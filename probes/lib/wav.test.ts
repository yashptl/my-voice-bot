import { describe, expect, it } from "vitest";
import { VOICE_FORMAT } from "../../src/protocol/audio";
import { pcmToWav } from "./wav";

const ascii = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));

describe("pcmToWav", () => {
  const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const wav = pcmToWav(pcm, VOICE_FORMAT);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

  it("writes a 44-byte RIFF/WAVE header followed by the PCM", () => {
    expect(wav.byteLength).toBe(44 + pcm.byteLength);
    expect(ascii(wav, 0)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + pcm.byteLength);
    expect(ascii(wav, 8)).toBe("WAVE");
    expect([...wav.subarray(44)]).toEqual([...pcm]);
  });

  it("describes 24 kHz mono 16-bit PCM in the fmt chunk", () => {
    expect(ascii(wav, 12)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // channels
    expect(view.getUint32(24, true)).toBe(24000); // sample rate
    expect(view.getUint32(28, true)).toBe(48000); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
  });

  it("sets the data chunk length to the PCM length", () => {
    expect(ascii(wav, 36)).toBe("data");
    expect(view.getUint32(40, true)).toBe(pcm.byteLength);
  });

  it("uses the format's sample rate", () => {
    const mic = pcmToWav(new Uint8Array(2), { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 });
    expect(new DataView(mic.buffer).getUint32(24, true)).toBe(16000);
  });
});
