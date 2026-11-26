import { decodeAudioFrame, type AudioFormat } from "../protocol/audio";
import type { SessionResponse } from "../protocol/chat";
import type { AssistantMode, ClientMessage, ServerEvent } from "../protocol/events";
import type { ClientMark } from "../protocol/turn-record";
import { PROTOCOL_VERSION, WS_SUBPROTOCOL } from "../protocol/version";
import { HalfDuplex, type MicState } from "./half-duplex";
import { startMic, type Mic, type MicSource } from "./mic";
import { Player } from "./player";
import { assistantUrls, DEFAULT_BASE_URL } from "./urls";

export type ConnectionStatus = "connecting" | "open" | "closed";

/** The sentence whose audio is playing. Sentence ids restart each turn, so it carries its turn. */
export interface NowPlaying {
  turnId: string;
  sentenceId: number;
}

/**
 * Server events as received, plus the session's own: connection (with the close `code` and
 * `reason` when the socket closed), mic state, the listening window, the sentence playing, the
 * interrupts and client marks it sent.
 */
export type VoiceSessionEvent =
  | ServerEvent
  | { type: "connection"; status: ConnectionStatus; mode?: AssistantMode; detail?: string; code?: number; reason?: string }
  | { type: "mic"; state: MicState }
  /** The listening window after a reply opened (true) or closed. */
  | { type: "followUp"; open: boolean }
  /** A sentence's audio started, or (null) nothing is playing any more. */
  | { type: "playing"; playing: NowPlaying | null }
  | { type: "interrupt"; turnId: string; lastHeardSentenceId: number | null }
  | { type: "mark"; turnId: string; mark: ClientMark; at: number };

export interface VoiceSessionOptions {
  /**
   * Where the host serves capture-worklet.js. Required for voice: talk() refuses without it, before
   * the microphone is asked for. The host's bundler resolves it (Vite: `?url&no-inline`).
   */
  workletUrl?: string;
  /** Opens the voice socket; tests pass a fake. */
  createWebSocket?: (url: string, protocols: string[]) => WebSocket;
}

export type VoiceSessionEventType = VoiceSessionEvent["type"];
export type VoiceSessionEventOf<T extends VoiceSessionEventType> = Extract<VoiceSessionEvent, { type: T }>;

/**
 * One voice conversation from the browser (framework-free). connect() opens the session and the
 * voice socket; talk() starts the mic (or a test file); the reply plays as it streams in.
 * Half-duplex: the mic sends zeroed frames while a reply plays and briefly after, stays live for a
 * listening window, then stops until talk(). pauseTalking() lets go of hold-to-talk. Client marks
 * (`at` = Date.now()) go to the server and are emitted as "mark" events.
 */
export class VoiceSession {
  private readonly listeners = new Map<VoiceSessionEventType, Set<(e: VoiceSessionEvent) => void>>();
  private readonly gate = new HalfDuplex(
    (state) => this.onMicState(state),
    (open) => this.emit({ type: "followUp", open }),
  );
  private status: ConnectionStatus = "closed";
  private context: AudioContext | null = null;
  private ws: WebSocket | null = null;
  private player: Player | null = null;
  private mic: Mic | null = null;
  private micGeneration = 0;
  private connectGeneration = 0;
  private serverBusy = false;
  private turnId: string | null = null;
  private turnEndAt: number | null = null;
  private firstAudioMarked = false;
  private dropAudio = false;
  private nowPlaying: NowPlaying | null = null;
  private speakerMuted = false;

  constructor(private readonly options: VoiceSessionOptions = {}) {}

  /** Subscribes to one event type; returns the unsubscribe function. */
  on<T extends VoiceSessionEventType>(type: T, fn: (e: VoiceSessionEventOf<T>) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const listener = fn as (e: VoiceSessionEvent) => void;
    set.add(listener);
    return () => set.delete(listener);
  }

  /**
   * Call from a click: the AudioContext is created and resumed before the first await, and only then
   * is `getSession` called (it may wait for a Turnstile token; see startSession in text-chat.ts).
   * `baseUrl` is where the voice route lives (`<baseUrl>/voice`), absolute or relative to the page.
   */
  async connect(getSession: () => Promise<SessionResponse>, baseUrl: string = DEFAULT_BASE_URL): Promise<void> {
    this.shutdown();
    const generation = this.connectGeneration;
    const context = (this.context ??= new AudioContext());
    void context.resume();
    this.setStatus("connecting");
    const urls = assistantUrls(baseUrl, globalThis.location?.href ?? baseUrl);

    let session: SessionResponse;
    try {
      session = await getSession();
      if (session.mode !== "voice") throw new Error(`voice is not enabled (mode: ${session.mode})`);
    } catch (err) {
      if (generation === this.connectGeneration) this.setStatus("closed", { detail: errorMessage(err) });
      throw err;
    }
    if (generation !== this.connectGeneration) return; // close() or another connect() ran meanwhile

    const ws = (this.options.createWebSocket ?? ((url, protocols) => new WebSocket(url, protocols)))(urls.voice.href, [
      WS_SUBPROTOCOL,
      session.token,
    ]);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.addEventListener("open", () => {
      if (this.ws === ws) this.setStatus("open", { mode: session.mode });
    });
    ws.addEventListener("message", (e: MessageEvent<string | ArrayBuffer>) => {
      if (this.ws === ws) this.onMessage(e.data);
    });
    ws.addEventListener("close", (e) => {
      if (this.ws !== ws) return;
      this.teardown();
      this.setStatus("closed", {
        detail: `socket closed (code ${e.code}${e.reason ? `: ${e.reason}` : ""})`,
        code: e.code,
        reason: e.reason,
      });
    });
  }

  /** The voice socket is open (not connecting, closing or closed). */
  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Starts listening, interrupting the reply in progress (thinking or playing), whose audio would
   * otherwise mute the mic. Call from a click or key press.
   */
  async talk(source: MicSource = "mic"): Promise<void> {
    const context = this.context;
    if (!context || this.ws?.readyState !== WebSocket.OPEN) throw new Error("not connected");
    const workletUrl = this.options.workletUrl;
    if (!workletUrl) throw new Error("workletUrl is required for voice");
    void context.resume();
    if (this.serverBusy || this.player?.active) this.interrupt();
    this.stopMic();
    const generation = this.micGeneration;
    this.gate.talk();

    let mic: Mic;
    try {
      mic = await startMic({ context, source, workletUrl, onFrame: (frame) => this.sendFrame(frame) });
    } catch (err) {
      if (generation === this.micGeneration) this.gate.stop();
      throw err;
    }
    if (generation !== this.micGeneration) return mic.stop(); // stopped while starting
    this.mic = mic;
    mic.setMuted(this.gate.state === "muted");
  }

  /**
   * Lets go of hold-to-talk: the mic sends zeroed frames, so the turn can end with the last words,
   * until the server starts the turn (at most 6 s), then turns off; no listening window follows that
   * answer. The next talk() starts the mic again.
   */
  pauseTalking(): void {
    this.gate.pause();
  }

  /**
   * Fills `out` (any length) with band levels from 0 to 1: the mic's while it is live, the reply's
   * while it plays; otherwise zeros, and null. Allocates nothing; meant for every animation frame.
   */
  readLevels(out: Float32Array): "mic" | "voice" | null {
    if (this.mic && this.gate.state === "live") {
      this.mic.readLevels(out);
      return "mic";
    }
    if (this.player?.active) {
      this.player.readLevels(out);
      return "voice";
    }
    out.fill(0);
    return null;
  }

  /** Silences the reply, which still plays on (timing and the "playing" events as if audible). */
  setSpeakerMuted(muted: boolean): void {
    this.speakerMuted = muted;
    this.player?.setMuted(muted);
  }

  /** Stops the mic, and any reply in progress. */
  stop(): void {
    this.interrupt();
    this.gate.stop();
  }

  /** Stops playback now and tells the server which sentence was last heard. */
  interrupt(): void {
    const player = this.player;
    const lastHeardSentenceId = player?.lastStartedSentenceId ?? null;
    const replying = this.serverBusy || (player?.active ?? false);
    this.stopPlayer();
    if (replying && this.turnId !== null) {
      this.send({ type: "interrupt", turnId: this.turnId, lastHeardSentenceId });
      this.emit({ type: "interrupt", turnId: this.turnId, lastHeardSentenceId });
      this.dropAudio = true; // frames already in flight for this turn
    }
    this.serverBusy = false;
    this.gate.setPlaying(false);
    this.gate.setServerBusy(false);
  }

  /** Closes the socket, stops the mic and playback, and releases the audio context. connect() may be called again. */
  close(): void {
    this.shutdown();
    const context = this.context;
    this.context = null;
    context?.close().catch(() => {});
  }

  private shutdown(detail?: string): void {
    this.connectGeneration++;
    const ws = this.ws;
    this.teardown();
    ws?.close(1000, "client closed");
    this.setStatus("closed", { detail });
  }

  private teardown(): void {
    this.ws = null;
    this.gate.stop();
    this.stopMic();
    this.stopPlayer();
    this.player = null;
    this.serverBusy = false;
    this.turnId = null;
    this.turnEndAt = null;
    this.firstAudioMarked = false;
    this.dropAudio = false;
  }

  private onMessage(data: string | ArrayBuffer): void {
    if (typeof data !== "string") return this.onAudio(data);
    const event = parseServerEvent(data);
    if (!event) return;
    this.emit(event);

    switch (event.type) {
      case "ready":
        if (event.protocol !== PROTOCOL_VERSION) {
          return this.shutdown(`server speaks protocol ${event.protocol}, this client ${PROTOCOL_VERSION}`);
        }
        this.stopPlayer();
        this.player = this.createPlayer(event.audio);
        break;
      case "state":
        this.serverBusy = event.state === "thinking" || event.state === "speaking";
        this.gate.setServerBusy(this.serverBusy);
        break;
      case "transcript":
        if (event.text.trim() === "") break;
        this.gate.heardSpeech();
        // The turn id is not known yet; the mark is sent on turn.start.
        if (event.final) this.turnEndAt = Date.now();
        break;
      case "turn.start":
        // A new turn supersedes anything still playing from the last one.
        this.stopPlayer();
        this.gate.setPlaying(false);
        this.gate.turnStarted();
        this.turnId = event.turnId;
        this.dropAudio = false;
        this.firstAudioMarked = false;
        if (this.turnEndAt !== null) this.mark("clientTurnEnd", this.turnEndAt);
        this.turnEndAt = null;
        break;
    }
  }

  private onAudio(frame: ArrayBuffer): void {
    if (this.dropAudio || !this.player || frame.byteLength < 4) return;
    const { sentenceId, pcm } = decodeAudioFrame(frame);
    this.player.enqueue(sentenceId, pcm);
    this.gate.setPlaying(true);
  }

  private createPlayer(format: AudioFormat): Player {
    if (!this.context) throw new Error("no audio context");
    const player = new Player(this.context, format);
    player.setMuted(this.speakerMuted);
    // The player's callbacks are single-slot: set once here, and fanned out.
    player.onSentenceStarted((sentenceId) => {
      // Audio is only taken after its turn.start, so it belongs to the current turn.
      if (this.turnId !== null) this.setNowPlaying({ turnId: this.turnId, sentenceId });
      if (this.firstAudioMarked) return;
      this.firstAudioMarked = true;
      this.mark("clientFirstAudioPlayed", Date.now());
    });
    player.onIdle(() => {
      this.setNowPlaying(null);
      this.gate.setPlaying(false);
    });
    return player;
  }

  /** Player.stop() reports no idle, so whatever stops the player clears what is playing here. */
  private stopPlayer(): void {
    this.player?.stop();
    this.setNowPlaying(null);
  }

  private setNowPlaying(playing: NowPlaying | null): void {
    if (playing === null && this.nowPlaying === null) return;
    this.nowPlaying = playing;
    this.emit({ type: "playing", playing });
  }

  private onMicState(state: MicState): void {
    if (state === "off") this.stopMic();
    else this.mic?.setMuted(state === "muted");
    this.emit({ type: "mic", state });
  }

  private stopMic(): void {
    this.micGeneration++;
    this.mic?.stop();
    this.mic = null;
  }

  private mark(mark: ClientMark, at: number): void {
    if (this.turnId === null) return;
    this.send({ type: "mark", turnId: this.turnId, mark, at });
    this.emit({ type: "mark", turnId: this.turnId, mark, at });
  }

  private send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private sendFrame(frame: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame);
  }

  private setStatus(
    status: ConnectionStatus,
    extra: { mode?: AssistantMode; detail?: string; code?: number; reason?: string } = {},
  ): void {
    if (status === this.status && status === "closed") return;
    this.status = status;
    this.emit({ type: "connection", status, ...extra });
  }

  private emit(event: VoiceSessionEvent): void {
    for (const fn of this.listeners.get(event.type) ?? []) fn(event);
  }
}

/** Server events come from our own Worker, so only the envelope is checked. */
function parseServerEvent(raw: string): ServerEvent | null {
  try {
    const json: unknown = JSON.parse(raw);
    return isRecord(json) && typeof json.type === "string" ? (json as unknown as ServerEvent) : null;
  } catch {
    return null;
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
