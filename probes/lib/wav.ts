import type { AudioFormat } from "../../src/protocol/audio";

const HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2; // pcm_s16le

/** Wraps raw s16le PCM in a canonical 44-byte RIFF/WAVE header so it plays anywhere. */
export function pcmToWav(pcm: Uint8Array, format: AudioFormat): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + pcm.byteLength);
  const view = new DataView(out.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  const blockAlign = format.channels * BYTES_PER_SAMPLE;

  ascii(0, "RIFF");
  view.setUint32(4, HEADER_BYTES - 8 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, format.channels, true);
  view.setUint32(24, format.sampleRate, true);
  view.setUint32(28, format.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, HEADER_BYTES);
  return out;
}
