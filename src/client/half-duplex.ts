/** "muted" still sends frames (zeroed) so the STT stream stays open; "off" sends nothing. */
export type MicState = "off" | "live" | "muted";

/** Room echo and output latency outlast the last sample, so stay muted a little longer. */
const MUTE_TAIL_MS = 150;
/** How long the mic stays live after a reply before it turns off until the next talk(). */
const LISTEN_WINDOW_MS = 8000;

/**
 * Half-duplex mic policy. The mic is muted while a reply plays, and until both the server has
 * finished replying and playback has drained; 150 ms later it is live again for an 8 s listening
 * window, then off until talk(). Speech heard in the window keeps the mic live.
 */
export class HalfDuplex {
  private current: MicState = "off";
  private playing = false;
  private serverBusy = false;
  private replying = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly onChange: (state: MicState) => void) {}

  get state(): MicState {
    return this.current;
  }

  /** The visitor asked to talk: live now, with no listening window. */
  talk(): void {
    this.clearTimer();
    this.replying = false;
    this.set("live");
  }

  stop(): void {
    this.clearTimer();
    this.replying = false;
    this.set("off");
  }

  /** Reply audio is queued or playing (true), or playback has drained or been stopped (false). */
  setPlaying(playing: boolean): void {
    this.playing = playing;
    if (!playing) return this.settle();
    this.replying = true;
    this.clearTimer();
    if (this.current !== "off") this.set("muted");
  }

  /** The server is thinking or speaking (true), or back to listening (false). */
  setServerBusy(busy: boolean): void {
    this.serverBusy = busy;
    if (!busy) return this.settle();
    this.replying = true;
    this.clearTimer();
  }

  /** The visitor is speaking: keep the mic live past the listening window. */
  heardSpeech(): void {
    if (this.current === "live") this.clearTimer();
  }

  /** Once a reply is fully over: tail, then live, then off after the listening window. */
  private settle(): void {
    if (!this.replying || this.playing || this.serverBusy) return;
    this.replying = false;
    this.clearTimer();
    if (this.current === "off") return;
    this.timer = setTimeout(() => {
      this.set("live");
      this.timer = setTimeout(() => this.set("off"), LISTEN_WINDOW_MS);
    }, MUTE_TAIL_MS);
  }

  private set(state: MicState): void {
    if (state === this.current) return;
    this.current = state;
    this.onChange(state);
  }

  private clearTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
