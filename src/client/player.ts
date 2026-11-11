import type { AudioFormat } from "../protocol/audio";

/** Jitter cushion before the first chunk after the queue runs dry. */
const LEAD_MS = 80;

/**
 * When the next chunk should start: right where the queue ends, or `leadMs` from now if the queue
 * has run dry (all times in AudioContext seconds).
 */
export function nextStartTime(now: number, queuedUntil: number, leadMs: number): number {
  return Math.max(queuedUntil, now + leadMs / 1000);
}

/**
 * The parts of an AudioContext the player uses. A real AudioContext satisfies it; the structural
 * type keeps this file free of DOM types so its tests typecheck and run in plain Node.
 */
export interface PlaybackContext {
  readonly currentTime: number;
  readonly destination: object;
  createBuffer(channels: number, length: number, sampleRate: number): PlaybackBuffer;
  createBufferSource(): PlaybackSource;
}

export interface PlaybackBuffer {
  getChannelData(channel: number): Float32Array;
}

export interface PlaybackSource {
  buffer: PlaybackBuffer | null;
  connect(destination: object): unknown;
  start(when?: number): void;
  stop(): void;
  addEventListener(type: "ended", listener: () => void): void;
}

/**
 * Gapless playback of streamed voice chunks (PCM s16le mono). Chunks are scheduled back to back on
 * the context clock; each sentence is reported when its first chunk starts playing.
 */
export class Player {
  private readonly sources = new Set<PlaybackSource>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private queuedUntil = 0;
  private queuedSentenceId: number | null = null;
  private lastStarted: number | null = null;
  private sentenceStarted: (sentenceId: number) => void = () => {};
  private idle: () => void = () => {};

  constructor(
    private readonly ctx: PlaybackContext,
    private readonly format: AudioFormat,
  ) {}

  /** Queues one chunk. `pcm` may be a view at any offset (decodeAudioFrame returns offset 4). */
  enqueue(sentenceId: number, pcm: Uint8Array): void {
    const samples = Math.floor(pcm.byteLength / 2);
    if (samples === 0) return;

    const buffer = this.ctx.createBuffer(1, samples, this.format.sampleRate);
    const channel = buffer.getChannelData(0);
    const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
    for (let i = 0; i < samples; i++) channel[i] = view.getInt16(i * 2, true) / 32768;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    source.addEventListener("ended", () => {
      // Chunks ended by stop() were already forgotten and must not report idle.
      if (!this.sources.delete(source)) return;
      if (this.sources.size === 0) this.idle();
    });

    const startAt = nextStartTime(this.ctx.currentTime, this.queuedUntil, LEAD_MS);
    source.start(startAt);
    this.sources.add(source);
    this.queuedUntil = startAt + samples / this.format.sampleRate;

    if (sentenceId !== this.queuedSentenceId) {
      this.queuedSentenceId = sentenceId;
      const timer = setTimeout(
        () => {
          this.timers.delete(timer);
          this.lastStarted = sentenceId;
          this.sentenceStarted(sentenceId);
        },
        Math.max(0, (startAt - this.ctx.currentTime) * 1000),
      );
      this.timers.add(timer);
    }
  }

  /** Silences everything queued, without reporting idle. */
  stop(): void {
    const sources = [...this.sources];
    this.sources.clear();
    for (const source of sources) source.stop();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.queuedUntil = 0;
    this.queuedSentenceId = null;
    this.lastStarted = null;
  }

  onSentenceStarted(fn: (sentenceId: number) => void): void {
    this.sentenceStarted = fn;
  }

  /** Called when the last queued chunk finishes playing (not after stop()). */
  onIdle(fn: () => void): void {
    this.idle = fn;
  }

  /** The sentence playing now or last played; null before any, and after stop(). */
  get lastStartedSentenceId(): number | null {
    return this.lastStarted;
  }

  /** True while any chunk is queued or playing. */
  get active(): boolean {
    return this.sources.size > 0;
  }
}
