export type AudioFormat = { encoding: "pcm_s16le"; sampleRate: number; channels: 1 };

/** Mic up: what Flux expects. */
export const MIC_FORMAT: AudioFormat = { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 };

/** Voice down: what MiniMax TTS produces. */
export const VOICE_FORMAT: AudioFormat = { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 };

/** 80 ms of MIC_FORMAT audio (1280 samples). */
export const MIC_FRAME_BYTES = 2560;

const HEADER_BYTES = 4;

/** Server → client voice frame: a little-endian u32 sentence id, then PCM. */
export function encodeAudioFrame(sentenceId: number, pcm: Uint8Array): ArrayBuffer {
  if (!Number.isInteger(sentenceId) || sentenceId < 0 || sentenceId > 0xffffffff) {
    throw new RangeError(`sentence id must be a u32, got ${sentenceId}`);
  }
  const buf = new ArrayBuffer(HEADER_BYTES + pcm.byteLength);
  new DataView(buf).setUint32(0, sentenceId, true);
  new Uint8Array(buf, HEADER_BYTES).set(pcm);
  return buf;
}

/** The returned `pcm` is a view into `buf` (offset 4, so Int16 views stay aligned). */
export function decodeAudioFrame(buf: ArrayBuffer): { sentenceId: number; pcm: Uint8Array } {
  if (buf.byteLength < HEADER_BYTES) {
    throw new RangeError(`audio frame needs a ${HEADER_BYTES}-byte header, got ${buf.byteLength} bytes`);
  }
  return { sentenceId: new DataView(buf).getUint32(0, true), pcm: new Uint8Array(buf, HEADER_BYTES) };
}
