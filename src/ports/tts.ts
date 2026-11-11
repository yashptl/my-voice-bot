import type { AudioFormat } from "../protocol/audio";

export interface TtsSession {
  /** May be called before earlier sentences finish; the session queues them in order. */
  speak(sentenceId: number, text: string): void;
  /** Resolves once every queued sentence has been synthesized. */
  finish(): Promise<void>;
  /** Stops at once; no `onAudio` calls follow. */
  cancel(): void;
}

export interface TtsOpenOptions {
  onAudio(sentenceId: number, pcm: Uint8Array): void;
  onSentenceDone(sentenceId: number): void;
  onError(e: Error): void;
}

export interface TtsPort {
  readonly id: string;
  readonly format: AudioFormat;
  open(o: TtsOpenOptions): Promise<TtsSession>;
}
