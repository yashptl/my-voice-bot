/** "muted" still sends frames (zeroed) so the STT stream stays open; "off" sends nothing. */
export type MicState = "off" | "live" | "muted";

/** Room echo and output latency outlast the last sample, so stay muted a little longer. */
const MUTE_TAIL_MS = 150;
/** How long the mic stays live after a reply before it turns off until the next talk(). */
const LISTEN_WINDOW_MS = 8000;
/** How long a paused mic waits, muted, for the turn to start before it turns off (nothing was said). */
const PAUSE_MS = 6000;

/**
 * Half-duplex mic policy. The mic is muted while a reply plays, and until both the server has
 * finished replying and playback has drained; 150 ms later it is live again for an 8 s listening
 * window (the follow-up), then off until talk(). Speech heard in the window keeps the mic live.
 * pause() (hold-to-talk let go) mutes the mic until the turn starts, then turns it off, and no
 * window opens after that answer.
 */
export class HalfDuplex {
  private current: MicState = "off";
  private playing = false;
  private serverBusy = false;
  private replying = false;
  /** pause() was called: the mic turns off rather than opening a window, until talk(). */
  private paused = false;
  private window = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly onChange: (state: MicState) => void,
    private readonly onFollowUp: (open: boolean) => void = () => {},
  ) {}

  get state(): MicState {
    return this.current;
  }

  /** The mic is live in the listening window after a reply, and nothing has been heard yet. */
  get followUp(): boolean {
    return this.window;
  }

  /** The visitor asked to talk: live now, with no listening window. */
  talk(): void {
    this.clearTimer();
    this.replying = false;
    this.paused = false;
    this.set("live");
  }

  /**
   * The visitor let go: muted (zeroed frames, so the speech service can end the turn and keep the
   * last words) until turnStarted(), or for at most 6 s; then off. Does nothing while off.
   */
  pause(): void {
    if (this.current === "off") return;
    this.clearTimer();
    this.paused = true;
    this.set("muted");
    this.timer = setTimeout(() => this.set("off"), PAUSE_MS);
  }

  /** The server started a turn: a paused mic turns off. */
  turnStarted(): void {
    if (!this.paused) return;
    this.clearTimer();
    this.set("off");
  }

  stop(): void {
    this.clearTimer();
    this.replying = false;
    this.paused = false;
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
    if (this.paused) return this.set("off");
    this.timer = setTimeout(() => {
      this.set("live");
      this.setWindow(true);
      this.timer = setTimeout(() => {
        this.setWindow(false);
        this.set("off");
      }, LISTEN_WINDOW_MS);
    }, MUTE_TAIL_MS);
  }

  private set(state: MicState): void {
    if (state === this.current) return;
    this.current = state;
    this.onChange(state);
  }

  private setWindow(open: boolean): void {
    if (open === this.window) return;
    this.window = open;
    this.onFollowUp(open);
  }

  /** Every way out of the listening window cancels its timer, so this closes the window too. */
  private clearTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.setWindow(false);
  }
}
