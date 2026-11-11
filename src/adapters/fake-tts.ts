import type { TtsPort, TtsSession } from "../ports/tts";
import { VOICE_FORMAT } from "../protocol/audio";

const AUDIO_MS_PER_CHAR = 60;
const CHUNK_MS = 100;
const BYTES_PER_MS = (VOICE_FORMAT.sampleRate * VOICE_FORMAT.channels * 2) / 1000;

/**
 * Keyless TTS for tests and the demo: each sentence takes `msPerChar` per character to "synthesize",
 * then yields 60 ms of 24 kHz silence per character in 100 ms chunks. Same session rules as MiniMax:
 * sentences run in order, `finish()` resolves when the queue drains (or on cancel), `speak()` after
 * `finish()` or `cancel()` is ignored.
 */
export function createFakeTts(o: { msPerChar?: number } = {}): TtsPort {
  const msPerChar = o.msPerChar ?? 2;
  return {
    id: "fake",
    format: VOICE_FORMAT,
    async open(cb): Promise<TtsSession> {
      const queue: { id: number; text: string }[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      let busy = false;
      let finishing = false;
      let closed = false;
      let resolveFinished!: () => void;
      const finished = new Promise<void>((resolve) => (resolveFinished = resolve));

      const close = () => {
        closed = true;
        clearTimeout(timer);
        queue.length = 0;
        resolveFinished();
      };

      const synthesize = (s: { id: number; text: string }) => {
        for (let left = s.text.length * AUDIO_MS_PER_CHAR * BYTES_PER_MS; left > 0 && !closed; ) {
          const n = Math.min(left, CHUNK_MS * BYTES_PER_MS);
          cb.onAudio(s.id, new Uint8Array(n));
          left -= n;
        }
        if (!closed) cb.onSentenceDone(s.id);
      };

      const next = () => {
        const s = queue.shift();
        busy = s !== undefined;
        if (!s) {
          if (finishing) close();
          return;
        }
        timer = setTimeout(() => {
          synthesize(s);
          if (!closed) next();
        }, msPerChar * s.text.length);
      };

      return {
        speak(id, text) {
          if (closed || finishing) return;
          queue.push({ id, text });
          if (!busy) next();
        },
        finish() {
          if (!closed) {
            finishing = true;
            if (!busy) close();
          }
          return finished;
        },
        cancel: close,
      };
    },
  };
}
