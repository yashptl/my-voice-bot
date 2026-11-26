import type { SessionResponse } from "../protocol/chat";
import type { AssistantMode, ErrorCode, RestingReason, ServerEvent, Source } from "../protocol/events";
import type { DataLine } from "../protocol/data-line";
import type { TurnRecord } from "../protocol/turn-record";
import { PROTOCOL_VERSION } from "../protocol/version";
import { SPEECH_OUTPUT_FAILED, VOICE_CLOSE } from "../protocol/voice";
import type { MicState } from "./half-duplex";
import { micFailure } from "./mic";
import { AssistantHttpError, ask as chatAsk, OutdatedError, restingReason, startSession, type HttpErrorCode } from "./text-chat";
import { DEFAULT_BASE_URL } from "./urls";
import { VoiceSession, type NowPlaying, type VoiceSessionEventOf } from "./voice-session";

export interface AssistantSessionOptions {
  /** Where the assistant's routes live. Default: DEFAULT_BASE_URL. */
  baseUrl?: string;
  /** A fresh Turnstile token for each session; the host page renders the widget. */
  turnstileToken(): Promise<string>;
  /**
   * Where the host serves capture-worklet.js, for voice. Without it voice ends as soon as it opens
   * (`voice.ended` "mic") and text is unaffected. The host's bundler resolves it (Vite: `?url&no-inline`).
   */
  workletUrl?: string;
  fetch?: typeof fetch;
  /** For tests. */
  createWebSocket?: (url: string, protocols: string[]) => WebSocket;
  /** For tests. Default: Date.now. */
  now?: () => number;
}

/**
 * "resting": the assistant refuses for now (`resting` says why). "off": switched off. "outdated": the
 * server and this client speak different protocol versions, so the page must reload; only reset()
 * leaves it. "error": the assistant could not be reached, however that happened.
 */
export type AssistantStatus = "idle" | "starting" | "ready" | "resting" | "off" | "outdated" | "error";

/** Why an answer is missing: what the server said, or "connection" when it never finished saying it. */
export type MessageError = HttpErrorCode | ErrorCode | "connection";

export interface ChatMessage {
  id: string;
  role: "visitor" | "assistant";
  /** The visitor's text, or the assistant's shown sentences joined by spaces. */
  text: string;
  /** Assistant only; [] for the visitor. `spoken: false` sentences are shown but have no audio. */
  sentences: { id: number; text: string; spoken?: boolean }[];
  /** Assistant: the answer is still streaming. */
  pending: boolean;
  sources: Source[];
  /** meta.data.contact: offer the Messages hand-over. */
  contact: boolean;
  /** meta.data.show: a ref worth showing as a card. */
  show: string | null;
  coverage: DataLine["coverage"] | null;
  /** For "Under the hood". */
  record: TurnRecord | null;
  /**
   * Why the answer is missing or incomplete. "connection": the connection failed or dropped (what
   * the server refused with is its own code; "unknown" is an HTTP refusal this client does not
   * know); the sentences before it were still shown.
   */
  error: MessageError | null;
  stopped: boolean;
  /**
   * Voice: where the visitor cut the spoken answer off. Absent: it was not cut off. null: before any
   * sentence started playing. n: the sentences after n were not heard.
   */
  heardThrough?: number | null;
  /** Voice: speech output failed during this answer, so the rest of it is shown but not spoken. */
  speechFailed: boolean;
}

/** The server's turn state. Whether the answer is being heard is `VoiceSnapshot.playing`. */
export type VoiceState = "off" | "connecting" | "listening" | "thinking" | "speaking";

/**
 * Why voice ended without the visitor ending it. "connect": the socket never opened or connecting
 * failed. "dropped": any other unexpected close (the session expired, a newer tab took over, ...).
 * "idle": the server closed it after 120 s without audio. "mic_blocked": the mic was refused.
 * "mic_missing": there is no mic, or the page cannot use one. "mic": any other mic or worklet
 * failure. "listening": speech recognition failed. "resting": voice is resting for the day.
 * "limit": this conversation used its questions or audio.
 */
export type VoiceEnded = "connect" | "dropped" | "idle" | "mic_blocked" | "mic_missing" | "mic" | "listening" | "resting" | "limit";

export interface VoiceSnapshot {
  state: VoiceState;
  /** The visitor's words as they are recognized; "" once final. */
  transcript: string;
  /** "muted" sends silence: while a reply plays, and after pauseTalking() until the turn starts. */
  mic: MicState;
  /** The mic is live in the 8 s listening window after an answer, and nothing has been heard yet. */
  followUp: boolean;
  /**
   * The answer and sentence whose audio is playing (the page's "speaking"); null while nothing is,
   * including a short gap when speech falls behind.
   */
  playing: { messageId: string; sentenceId: number } | null;
  /** Why voice ended; null while it is on, and when the visitor (or an outdated protocol) ended it. */
  ended: VoiceEnded | null;
}

export interface AssistantSnapshot {
  status: AssistantStatus;
  /** Why the assistant is resting; non-null exactly when `status` is "resting". */
  resting: RestingReason | null;
  mode: AssistantMode;
  /** An answer is streaming, in text or voice. */
  busy: boolean;
  /** This conversation used its questions or audio. reset() starts a new one. */
  limitReached: boolean;
  /** One line for the visitor: the conversation was renewed, voice is resting, and so on. */
  notice: string | null;
  voice: VoiceSnapshot;
  messages: readonly ChatMessage[];
}

/** A session this close to expiring is replaced before the next question rather than failing it. */
const SESSION_MARGIN_MS = 60_000;

const RENEWED = "This conversation was renewed, so earlier questions won't be remembered.";
const VOICE_RESTING = "Voice is resting for today. Answers continue as text.";
const VOICE_FAILED = "Voice couldn't connect. You can keep typing.";
const VOICE_DROPPED = "Voice disconnected. You can keep typing, or start voice again.";
const LIMIT_REACHED = "This conversation is done.";
const NO_MIC = "The microphone isn't available. You can keep typing.";

const VOICE_OFF: VoiceSnapshot = { state: "off", transcript: "", mic: "off", followUp: false, playing: null, ended: null };

const INITIAL: AssistantSnapshot = {
  status: "idle",
  resting: null,
  mode: "off",
  busy: false,
  limitReached: false,
  notice: null,
  voice: VOICE_OFF,
  messages: [],
};

/** Why the server closed the voice socket, from the close code and reason (never the detail text). */
function closeEnded(code?: number, reason?: string): VoiceEnded {
  if (code === 1000 && reason === VOICE_CLOSE.idle) return "idle";
  if (code === 1011 && reason === VOICE_CLOSE.speechRecognitionFailed) return "listening";
  if (code === 1008 && (reason === VOICE_CLOSE.turnLimit || reason === VOICE_CLOSE.audioLimit)) return "limit";
  return "dropped";
}

/** What a turn record's error says about the model: its timeout, any other model failure, or nothing. */
function modelFailure(recordError: string | null): MessageError | null {
  if (recordError === null || !recordError.startsWith("llm_")) return null;
  return recordError.startsWith("llm_timeout") ? "timeout" : "provider";
}

/**
 * The one client object a page binds to: it owns the session, the conversation and, in voice, the
 * socket, mic and speaker. Framework-free; `snapshot` and `subscribe` plug into any store (see
 * useAssistant in react.ts). The page renders the snapshot and calls the methods.
 */
export class AssistantSession {
  private snap: AssistantSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private readonly baseUrl: string;
  private readonly now: () => number;

  private session: SessionResponse | null = null;
  private minting: Promise<SessionResponse> | null = null;
  /** The server has taken a question in the current session, so a new session loses that history. */
  private conversationStarted = false;
  private generation = 0;
  private nextId = 0;
  private disposed = false;

  private controller: AbortController | null = null;

  private voice: VoiceSession | null = null;
  private voiceOff: (() => void)[] = [];
  private voiceTurns = new Map<string, string>();
  private voiceCurrent: string | null = null;
  /** The last voice answer, current or just ended: a speech failure can arrive after its turn.end. */
  private voiceLatest: string | null = null;
  /** The running startVoice()'s wait: resolved once the mic is up or voice has ended. */
  private voiceLive: { done: Promise<void>; resolve: () => void } | null = null;
  /** pauseTalking() came while voice was connecting: applied once the mic goes live. */
  private pauseRequested = false;
  private speakerMuted = false;

  constructor(private readonly o: AssistantSessionOptions) {
    this.baseUrl = o.baseUrl ?? DEFAULT_BASE_URL;
    this.now = o.now ?? Date.now;
  }

  /** Immutable: a new object on every change, the same object otherwise. */
  get snapshot(): AssistantSnapshot {
    return this.snap;
  }

  /** Calls `listener` after each change; returns the unsubscribe function. Stable, for useSyncExternalStore. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /**
   * Mints the session, if there is not one; while resting or off it asks again, to see whether the
   * assistant is back. Never rejects: a failure is status "error" and a notice.
   */
  async start(): Promise<void> {
    const { status } = this.snap;
    if (status === "outdated") return;
    try {
      await this.ensureSession(status === "resting" || status === "off");
    } catch {
      // ensureSession reported it.
    }
  }

  /**
   * Asks one question. Does nothing (resolves at once, changes nothing) while an answer is
   * streaming, when the question is blank, or when the assistant is off, resting or at its limit;
   * a page disables its input on those. Resolves when the answer is complete, stopped or failed.
   */
  async ask(text: string): Promise<void> {
    const message = text.trim();
    const { status, busy, limitReached } = this.snap;
    if (!message || this.disposed || busy || limitReached || status === "off" || status === "resting" || status === "outdated") return;

    const controller = new AbortController();
    this.controller = controller;
    const visitor = this.newMessage("visitor", message);
    const assistant = this.newMessage("assistant", "", true);
    const generation = this.generation;
    this.set({ busy: true, notice: null, messages: [...this.snap.messages, visitor, assistant] });
    const withdraw = () => this.set({ messages: this.snap.messages.filter((m) => m !== visitor && m.id !== assistant.id) });
    let started = false;

    try {
      for (let attempt = 0; ; attempt++) {
        let session: SessionResponse;
        try {
          session = await this.ensureSession(attempt > 0);
        } catch (err) {
          // A renewal that finds the assistant off or outdated has set the status; the question was never asked.
          if (this.generation === generation && (err instanceof OutdatedError || (err instanceof AssistantHttpError && err.code === "off"))) {
            return withdraw();
          }
          throw err;
        }
        if (this.generation !== generation) return;
        if (this.snap.status === "resting" || this.snap.status === "off") return withdraw();
        try {
          await chatAsk({
            baseUrl: this.baseUrl,
            token: session.token,
            message,
            signal: controller.signal,
            fetch: this.o.fetch,
            onEvent: (e) => {
              started = true;
              this.conversationStarted = true;
              this.onEvent(assistant.id, e);
            },
          });
          break;
        } catch (err) {
          const expired = err instanceof AssistantHttpError && err.code === "auth";
          if (attempt === 0 && expired && !started && !controller.signal.aborted) continue;
          throw err;
        }
      }
      // The stream ended without turn.end or an error: the connection was cut.
      this.patch(assistant.id, (m) => (m.pending ? { ...m, pending: false, error: m.error ?? "connection" } : m));
    } catch (err) {
      if (this.generation !== generation) return;
      if (controller.signal.aborted) {
        this.patch(assistant.id, (m) => ({ ...m, pending: false, stopped: true }));
      } else {
        if (err instanceof AssistantHttpError) this.fail(assistant.id, err.code, err.reason);
        else this.fail(assistant.id, "connection");
      }
    } finally {
      if (this.generation === generation) {
        if (this.controller === controller) this.controller = null;
        this.set({ busy: this.voiceCurrent !== null });
      }
    }
  }

  /** Stops the streaming text answer; the message keeps what was shown. */
  stop(): void {
    this.controller?.abort();
  }

  /**
   * Starts a voice conversation: connects, then listens. Call it from a click (the audio context
   * and the microphone prompt need a user gesture). Does nothing unless the session's mode is voice.
   * Resolves once the mic is up, or voice has ended (`voice.ended` says why); never rejects.
   */
  async startVoice(): Promise<void> {
    if (this.disposed || this.snap.mode !== "voice" || this.snap.status === "outdated" || this.voice) return;
    const voice = new VoiceSession({ createWebSocket: this.o.createWebSocket, workletUrl: this.o.workletUrl });
    this.voice = voice;
    voice.setSpeakerMuted(this.speakerMuted);
    let resolve = () => {};
    const done = new Promise<void>((r) => (resolve = r));
    this.voiceLive = { done, resolve };
    this.set({ voice: { ...VOICE_OFF, state: "connecting" }, notice: null });
    this.voiceOff = [
      voice.on("connection", (e) => this.onVoiceConnection(voice, e)),
      voice.on("ready", (e) => {
        if (e.protocol === PROTOCOL_VERSION) return;
        this.set({ status: "outdated", resting: null }); // VoiceSession closes the socket itself
        this.endVoice(null);
      }),
      voice.on("state", (e) => {
        if (this.snap.voice.state === "connecting") return;
        this.setVoice({ state: e.state === "thinking" || e.state === "speaking" ? e.state : "listening" });
      }),
      voice.on("transcript", (e) => this.setVoice({ transcript: e.final ? "" : e.text })),
      voice.on("turn.start", (e) => {
        const visitor = this.newMessage("visitor", e.question);
        const assistant = this.newMessage("assistant", "", true);
        this.voiceTurns.set(e.turnId, assistant.id);
        this.voiceCurrent = assistant.id;
        this.voiceLatest = assistant.id;
        this.set({ busy: true, messages: [...this.snap.messages, visitor, assistant], voice: { ...this.snap.voice, transcript: "" } });
      }),
      voice.on("sentence", (e) => this.onVoiceEvent(e)),
      voice.on("meta", (e) => this.onVoiceEvent(e)),
      voice.on("sources", (e) => this.onVoiceEvent(e)),
      voice.on("turn.end", (e) => this.onVoiceEvent(e)),
      voice.on("turn.interrupted", (e) => this.onVoiceEvent(e)),
      voice.on("error", (e) => this.onVoiceError(e)),
      voice.on("mic", (e) => this.setVoice({ mic: e.state })),
      voice.on("followUp", (e) => this.setVoice({ followUp: e.open })),
      voice.on("playing", (e) => this.onPlaying(e.playing)),
      voice.on("interrupt", (e) => this.onVoiceInterrupt(e)),
    ];
    try {
      await voice.connect(() => this.ensureSession(), this.baseUrl);
    } catch {
      if (this.voice === voice) this.endVoice(VOICE_FAILED, "connect"); // a failed mint already set status and notice
    }
    return done;
  }

  /**
   * The visitor wants to talk; call it from a click or key press. With voice open, the mic goes live
   * now, interrupting the reply in progress. With voice not open (never started, or ended, say by
   * the server's idle close), it reopens voice on the same session first, like startVoice(), so the
   * conversation keeps its history. Clears `voice.ended`. Resolves once the mic is up, or voice has
   * ended (`voice.ended` says why); never rejects.
   */
  async talk(): Promise<void> {
    this.pauseRequested = false;
    const voice = this.voice;
    if (voice && this.snap.voice.state === "connecting") return this.voiceLive?.done;
    // The server's close is in flight (its event has not fired): reopen now rather than fail.
    if (voice && !voice.open) this.endVoice(null);
    if (!this.voice) return this.startVoice(); // no await before it: the audio context starts in the click
    return this.goLive(this.voice);
  }

  /**
   * Hold-to-talk let go: the mic sends silence, so the turn can end with the last words, until the
   * server starts the turn (at most 6 s if nothing was said), then turns off. No listening window
   * opens after that answer; the next talk() starts the mic again. Let go while voice is still
   * connecting, it applies once the mic goes live.
   */
  pauseTalking(): void {
    const voice = this.voice;
    if (!voice) return;
    if (this.snap.voice.state === "connecting") this.pauseRequested = true;
    else voice.pauseTalking();
  }

  /**
   * Fills `out` (any length) with band levels from 0 to 1 and says whose they are: "mic" while the
   * mic is live, "voice" while the answer plays; otherwise zeros, and null. Allocates nothing; read
   * it once per animation frame.
   */
  readLevels(out: Float32Array): "mic" | "voice" | null {
    if (this.voice) return this.voice.readLevels(out);
    out.fill(0);
    return null;
  }

  /** Silences the spoken answer, which plays on as if audible (`voice.playing` and the mic timing). */
  setSpeakerMuted(muted: boolean): void {
    this.speakerMuted = muted;
    this.voice?.setSpeakerMuted(muted);
  }

  /** Ends the voice conversation: closes the socket, the mic and playback. Messages stay. */
  stopVoice(): void {
    this.endVoice(null);
  }

  /** Stops the spoken answer now, and tells the server what was heard. */
  interrupt(): void {
    if (!this.voice) return;
    this.voice.interrupt();
    const current = this.voiceCurrent;
    if (current) this.patch(current, (m) => (m.pending && !m.stopped ? { ...m, stopped: true } : m));
  }

  /** Forgets the session and the conversation, back to idle. Call start() to begin a new one. */
  reset(): void {
    this.cancelWork();
    this.session = null;
    this.minting = null;
    this.conversationStarted = false;
    this.set({ ...INITIAL });
  }

  /** Ends everything and stops notifying. The object is not used again. */
  dispose(): void {
    this.disposed = true;
    this.cancelWork();
    this.listeners.clear();
  }

  private cancelWork(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    this.endVoice(null, null, false);
  }

  private async ensureSession(renew = false): Promise<SessionResponse> {
    const session = this.session;
    if (session && !renew && session.expiresAt - this.now() >= SESSION_MARGIN_MS) return session;
    if (this.minting) return this.minting;
    const minting = this.mint().finally(() => {
      if (this.minting === minting) this.minting = null; // not a newer mint, after reset()
    });
    this.minting = minting;
    return minting;
  }

  private async mint(): Promise<SessionResponse> {
    const generation = this.generation;
    const hadSession = this.session !== null;
    if (!hadSession) this.set({ status: "starting" });
    try {
      const session = await startSession({
        baseUrl: this.baseUrl,
        turnstile: await this.o.turnstileToken(),
        fetch: this.o.fetch,
      });
      if (this.generation !== generation) return session;
      this.session = session;
      const renewed = this.conversationStarted;
      this.conversationStarted = false;
      this.set({
        ...(session.mode === "off"
          ? { status: "off" as const, resting: null }
          : session.resting
            ? { status: "resting" as const, resting: session.resting }
            : { status: "ready" as const, resting: null }),
        mode: this.voiceRested ? "text" : session.mode,
        ...(renewed && { notice: RENEWED }),
      });
      return session;
    } catch (err) {
      if (this.generation === generation) {
        if (err instanceof OutdatedError) this.set({ status: "outdated", resting: null });
        else if (err instanceof AssistantHttpError && err.code === "off") this.set({ status: "off", resting: null, mode: "off" });
        else if (err instanceof AssistantHttpError && err.code === "resting") this.set({ status: "resting", resting: err.reason ?? "outage" });
        else if (!hadSession) {
          const reason = err instanceof Error ? err.message : String(err);
          this.set({ status: "error", notice: `Couldn't reach the assistant (${reason}).` });
        }
      }
      throw err;
    }
  }

  /** Voice rested for the day: a later session keeps the mode at text. */
  private voiceRested = false;

  /** Events for one assistant message: from the text stream, or from a voice turn. */
  private onEvent(id: string | null, e: ServerEvent): void {
    if (id === null) return;
    switch (e.type) {
      case "sentence":
        this.patch(id, (m) => {
          if (m.error || m.stopped) return m;
          const sentences = [...m.sentences, { id: e.id, text: e.text, ...(e.spoken === false && { spoken: false }) }];
          return { ...m, sentences, text: sentences.map((s) => s.text).join(" ") };
        });
        break;
      case "meta":
        this.patch(id, (m) => ({
          ...m,
          sources: e.sources,
          contact: e.data.contact,
          show: e.data.show,
          coverage: e.data.coverage,
        }));
        break;
      case "sources":
        this.patch(id, (m) => ({ ...m, sources: e.sources }));
        break;
      case "turn.end":
        // A voice model failure arrives as an error event without a turnId, so the record is what says it.
        this.patch(id, (m) => ({
          ...m,
          record: e.record,
          pending: false,
          stopped: m.stopped || e.record.interrupted,
          error: m.error ?? modelFailure(e.record.error),
        }));
        if (this.voiceCurrent === id) this.finishVoiceTurn();
        break;
      case "turn.interrupted":
        this.patch(id, (m) => ({ ...m, record: e.record, stopped: true, heardThrough: e.lastHeardSentenceId }));
        break;
      case "error":
        this.fail(id, e.code, e.reason);
        break;
    }
  }

  /**
   * Only these voice errors end the current answer; any other (a failed speech stream, a bad message,
   * a rate limit) is a notice, and the answer's later sentences and turn.end still arrive.
   */
  private onVoiceError(e: Extract<ServerEvent, { type: "error" }>): void {
    if (e.code === "voice_resting") {
      this.set({ mode: "text" });
      return this.endVoice(VOICE_RESTING, "resting");
    }
    // "provider" does not end the answer here: a failed speech stream uses it too, and the answer continues as text.
    // A model failure is read from the turn's record at turn.end instead.
    const ends = e.code === "limit" || e.code === "timeout" || e.code === "resting" || e.code === "auth" || e.code === "internal";
    if (!ends) {
      // Speech-recognition failure shares the code, so the message is what tells them apart.
      const latest = this.voiceLatest;
      if (e.code === "provider" && e.message === SPEECH_OUTPUT_FAILED && latest) {
        this.patch(latest, (m) => (m.speechFailed ? m : { ...m, speechFailed: true }));
      }
      return this.set({ notice: e.message });
    }
    if (this.voiceCurrent !== null) return this.fail(this.voiceCurrent, e.code, e.reason);
    // Outside a turn: the session state still changes.
    if (e.code === "limit") this.set({ limitReached: true, notice: LIMIT_REACHED });
    else if (e.code === "resting") this.set({ status: "resting", resting: restingReason(e.reason) });
    else this.set({ notice: e.message });
  }

  private onVoiceEvent(e: Extract<ServerEvent, { turnId: string }>): void {
    this.onEvent(this.voiceTurns.get(e.turnId) ?? null, e);
  }

  private onPlaying(playing: NowPlaying | null): void {
    const messageId = playing ? this.voiceTurns.get(playing.turnId) : undefined;
    this.setVoice({ playing: playing && messageId ? { messageId, sentenceId: playing.sentenceId } : null });
  }

  /** An interrupt sent to the server, by interrupt() or by talk() over a reply still playing. */
  private onVoiceInterrupt(e: VoiceSessionEventOf<"interrupt">): void {
    const id = this.voiceTurns.get(e.turnId);
    if (id) this.patch(id, (m) => ({ ...m, heardThrough: e.lastHeardSentenceId, stopped: m.stopped || m.pending }));
  }

  private onVoiceConnection(voice: VoiceSession, e: VoiceSessionEventOf<"connection">): void {
    if (this.voice !== voice) return;
    if (e.status === "open") {
      this.setVoice({ state: "listening" });
      void this.goLive(voice);
    } else if (e.status === "closed") {
      if (this.snap.voice.state === "connecting") this.endVoice(VOICE_FAILED, "connect");
      else this.endVoice(VOICE_DROPPED, closeEnded(e.code, e.reason));
    }
  }

  /** Turns the mic live; a mic that cannot start ends voice. Resolves either way. */
  private async goLive(voice: VoiceSession): Promise<void> {
    const talking = voice.talk();
    if (this.pauseRequested) voice.pauseTalking();
    this.pauseRequested = false;
    try {
      await talking;
    } catch (err) {
      if (this.voice === voice) this.endVoice(NO_MIC, micFailure(err));
      return;
    }
    if (this.voice === voice) this.settleVoiceLive();
  }

  private settleVoiceLive(): void {
    this.voiceLive?.resolve();
    this.voiceLive = null;
  }

  /** A text or voice error: on the message, plus what it means for the whole conversation. */
  private fail(id: string, code: MessageError, reason?: RestingReason | null): void {
    if (code === "limit") this.set({ limitReached: true });
    if (code === "resting") this.set({ status: "resting", resting: restingReason(reason) });
    if (code === "off") this.set({ status: "off", resting: null, mode: "off" });
    this.patch(id, (m) => (m.error ? m : { ...m, error: code, pending: false }));
  }

  private finishVoiceTurn(): void {
    this.voiceCurrent = null;
    this.set({ busy: this.controller !== null });
  }

  /**
   * Tears voice down; an answer still in progress ends as stopped (by the visitor) or cut off.
   * `ended` says why voice ended, when the visitor did not end it.
   */
  private endVoice(notice: string | null, ended: VoiceEnded | null = null, announce = true): void {
    const voice = this.voice;
    if (!voice) return;
    this.voice = null;
    for (const off of this.voiceOff) off();
    this.voiceOff = [];
    voice.close();
    this.settleVoiceLive();
    this.pauseRequested = false;
    if (notice === VOICE_RESTING) this.voiceRested = true;
    const current = this.voiceCurrent;
    this.voiceCurrent = null;
    this.voiceLatest = null;
    this.voiceTurns.clear();
    if (!announce) return;
    if (current) {
      const dropped = notice !== null && notice !== VOICE_RESTING;
      this.patch(current, (m) =>
        m.pending ? (dropped ? { ...m, pending: false, error: m.error ?? "connection" } : { ...m, pending: false, stopped: true }) : m,
      );
    }
    this.set({
      busy: this.controller !== null,
      voice: { ...VOICE_OFF, ended },
      ...(notice !== null && { notice }),
    });
  }

  private newMessage(role: ChatMessage["role"], text: string, pending = false): ChatMessage {
    return {
      id: `m${this.nextId++}`,
      role,
      text,
      sentences: [],
      pending,
      sources: [],
      contact: false,
      show: null,
      coverage: null,
      record: null,
      error: null,
      stopped: false,
      speechFailed: false,
    };
  }

  /** Replaces one message with `fn(message)` unless that returns the same object. */
  private patch(id: string, fn: (m: ChatMessage) => ChatMessage): void {
    const messages = this.snap.messages;
    const at = messages.findIndex((m) => m.id === id);
    const old = messages[at];
    if (!old) return;
    const next = fn(old);
    if (next !== old) this.set({ messages: messages.map((m, i) => (i === at ? next : m)) });
  }

  private setVoice(patch: Partial<AssistantSnapshot["voice"]>): void {
    const voice = this.snap.voice;
    if (Object.entries(patch).every(([k, v]) => voice[k as keyof typeof voice] === v)) return;
    this.set({ voice: { ...voice, ...patch } });
  }

  /** Applies a patch, and notifies only if a field actually changed. */
  private set(patch: Partial<AssistantSnapshot>): void {
    if (this.disposed) return;
    const changed = (Object.keys(patch) as (keyof AssistantSnapshot)[]).some((k) => !Object.is(patch[k], this.snap[k]));
    if (!changed) return;
    this.snap = { ...this.snap, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}
