/** How far ahead of real time a client may send audio, in seconds of audio. */
const LEAD_SECONDS = 5;

/** Plain JSON, so the Durable Object can store it and a reconnect resumes the same meter. */
export interface AudioMeterState {
  /** Accepted bytes, all sockets of the conversation together. */
  bytes: number;
  /** When the conversation's first frame arrived (`now()` time), or null before it. */
  firstAt: number | null;
  /** Set once the total would cross `maxSeconds`; never cleared. */
  limited: boolean;
}

export type MeterResult = "ok" | "too_fast" | "limit";

/**
 * Counts the mic audio a conversation sends to speech-to-text, which bills per audio minute.
 *
 * - "limit": accepting the frame would take the total past `maxSeconds`. Sticky: every later frame
 *   is refused too, and the state carries it across reconnects.
 * - "too_fast": accepting the frame would put the total more than 5 s of audio ahead of the real
 *   time since the conversation's first frame. A client that fell behind (a mobile network stall
 *   delivers its backlog in one burst) may catch up to real time, so no real speech is dropped.
 *   The server cannot tell a stall from a quiet spell, so a client that was silent may also send
 *   up to that much at once; `maxSeconds` is what bounds the cost either way.
 *
 * Refused frames are not counted; the caller drops them.
 */
export class AudioMeter {
  private readonly maxBytes: number;
  private readonly leadBytes: number;
  private readonly bytesPerSecond: number;
  private readonly now: () => number;
  private s: AudioMeterState;

  constructor(o: { maxSeconds: number; bytesPerSecond: number; now: () => number; state?: AudioMeterState }) {
    this.bytesPerSecond = o.bytesPerSecond;
    this.maxBytes = o.maxSeconds * o.bytesPerSecond;
    this.leadBytes = LEAD_SECONDS * o.bytesPerSecond;
    this.now = o.now;
    const saved = o.state;
    this.s = { bytes: saved?.bytes ?? 0, firstAt: saved?.firstAt ?? null, limited: saved?.limited ?? false };
  }

  add(bytes: number): MeterResult {
    const s = this.s;
    if (s.limited) return "limit";
    const t = this.now();
    s.firstAt ??= t;
    const realTimeBytes = (Math.max(0, t - s.firstAt) * this.bytesPerSecond) / 1000;
    if (s.bytes + bytes > realTimeBytes + this.leadBytes) return "too_fast";
    if (s.bytes + bytes > this.maxBytes) {
      s.limited = true;
      return "limit";
    }
    s.bytes += bytes;
    return "ok";
  }

  /** Seconds of audio accepted so far. */
  get seconds(): number {
    return this.s.bytes / this.bytesPerSecond;
  }

  /** A copy of the state, for storage. */
  get state(): AudioMeterState {
    return { ...this.s };
  }
}
