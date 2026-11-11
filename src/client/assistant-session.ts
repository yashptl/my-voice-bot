import type { SessionResponse } from "../protocol/chat";
import type { AssistantMode, ErrorCode, ServerEvent, Source } from "../protocol/events";
import type { DataLine } from "../protocol/data-line";
import type { TurnRecord } from "../protocol/turn-record";
import { AssistantHttpError, ask as chatAsk, startSession, type HttpErrorCode } from "./text-chat";
import { DEFAULT_BASE_URL } from "./urls";
import { VoiceSession, type VoiceSessionEventOf } from "./voice-session";

export interface AssistantSessionOptions {
  /** Where the assistant's routes live. Default: DEFAULT_BASE_URL. */
  baseUrl?: string;
  /** A fresh Turnstile token for each session; the host page renders the widget. */
  turnstileToken(): Promise<string>;
  fetch?: typeof fetch;
  /** For tests. */
  createWebSocket?: (url: string, protocols: string[]) => WebSocket;
  /** For tests. Default: Date.now. */
  now?: () => number;
}

export type AssistantStatus = "idle" | "starting" | "ready" | "resting" | "off" | "error";

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
   * Why the answer is missing or incomplete. "unknown": the connection failed or dropped (what the
   * server refused with is its own code); the sentences before it were still shown.
   */
  error: HttpErrorCode | ErrorCode | null;
  stopped: boolean;
}

export type VoiceState = "off" | "connecting" | "listening" | "thinking" | "speaking";

export interface AssistantSnapshot {
  status: AssistantStatus;
  mode: AssistantMode;
  /** An answer is streaming, in text or voice. */
  busy: boolean;
  /** This conversation used its questions or audio. reset() starts a new one. */
  limitReached: boolean;
  /** One line for the visitor: the conversation was renewed, voice is resting, and so on. */
  notice: string | null;
  voice: { state: VoiceState; transcript: string };
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

const INITIAL: AssistantSnapshot = {
  status: "idle",
  mode: "off",
  busy: false,
  limitReached: false,
  notice: null,
  voice: { state: "off", transcript: "" },
  messages: [],
};

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

  /** Mints the session, if there is not one. Never rejects: a failure is status "error" and a notice. */
  async start(): Promise<void> {
    try {
      await this.ensureSession();
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
    if (!message || this.disposed || busy || limitReached || status === "off" || status === "resting") return;

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
        const session = await this.ensureSession(attempt > 0);
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
      this.patch(assistant.id, (m) => (m.pending ? { ...m, pending: false, error: m.error ?? "unknown" } : m));
    } catch (err) {
      if (this.generation !== generation) return;
      if (controller.signal.aborted) {
        this.patch(assistant.id, (m) => ({ ...m, pending: false, stopped: true }));
      } else {
        const code = err instanceof AssistantHttpError ? err.code : "unknown";
        this.fail(assistant.id, code);
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
   */
  async startVoice(): Promise<void> {
    if (this.disposed || this.snap.mode !== "voice" || this.voice) return;
    const voice = new VoiceSession({ createWebSocket: this.o.createWebSocket });
    this.voice = voice;
    this.set({ voice: { state: "connecting", transcript: "" }, notice: null });
    this.voiceOff = [
      voice.on("connection", (e) => this.onVoiceConnection(voice, e)),
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
        this.set({ busy: true, messages: [...this.snap.messages, visitor, assistant], voice: { ...this.snap.voice, transcript: "" } });
      }),
      voice.on("sentence", (e) => this.onVoiceEvent(e)),
      voice.on("meta", (e) => this.onVoiceEvent(e)),
      voice.on("sources", (e) => this.onVoiceEvent(e)),
      voice.on("turn.end", (e) => this.onVoiceEvent(e)),
      voice.on("turn.interrupted", (e) => this.onVoiceEvent(e)),
      voice.on("error", (e) => this.onVoiceError(e)),
    ];
    try {
      await voice.connect(() => this.ensureSession(), this.baseUrl);
    } catch {
      if (this.voice === voice) this.endVoice(VOICE_FAILED); // a failed mint already set status and notice
    }
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
    if (current) this.patch(current, (m) => (m.pending ? { ...m, stopped: true } : m));
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
    this.endVoice(null, false);
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
        status: session.mode === "off" ? "off" : session.resting ? "resting" : "ready",
        mode: this.voiceRested ? "text" : session.mode,
        ...(renewed && { notice: RENEWED }),
      });
      return session;
    } catch (err) {
      if (this.generation === generation && !hadSession) {
        const reason = err instanceof Error ? err.message : String(err);
        this.set({ status: "error", notice: `Couldn't reach the assistant (${reason}).` });
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
        this.patch(id, (m) => ({ ...m, record: e.record, pending: false, stopped: m.stopped || e.record.interrupted }));
        if (this.voiceCurrent === id) this.finishVoiceTurn();
        break;
      case "turn.interrupted":
        this.patch(id, (m) => ({ ...m, record: e.record, stopped: true }));
        break;
      case "error":
        this.fail(id, e.code);
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
      return this.endVoice(VOICE_RESTING);
    }
    const ends = e.code === "limit" || e.code === "resting" || e.code === "auth" || e.code === "internal";
    if (!ends) return this.set({ notice: e.message });
    if (this.voiceCurrent !== null) return this.fail(this.voiceCurrent, e.code);
    // Outside a turn: the session state still changes.
    if (e.code === "limit") this.set({ limitReached: true, notice: LIMIT_REACHED });
    else if (e.code === "resting") this.set({ status: "resting" });
    else this.set({ notice: e.message });
  }

  private onVoiceEvent(e: Extract<ServerEvent, { turnId: string }>): void {
    this.onEvent(this.voiceTurns.get(e.turnId) ?? null, e);
  }

  private onVoiceConnection(voice: VoiceSession, e: VoiceSessionEventOf<"connection">): void {
    if (this.voice !== voice) return;
    if (e.status === "open") {
      this.setVoice({ state: "listening" });
      voice.talk().catch(() => {
        if (this.voice === voice) this.endVoice(NO_MIC);
      });
    } else if (e.status === "closed") {
      this.endVoice(this.snap.voice.state === "connecting" ? VOICE_FAILED : VOICE_DROPPED);
    }
  }

  /** A text or voice error: on the message, plus what it means for the whole conversation. */
  private fail(id: string, code: HttpErrorCode | ErrorCode): void {
    if (code === "limit") this.set({ limitReached: true });
    if (code === "resting") this.set({ status: "resting" });
    this.patch(id, (m) => (m.error ? m : { ...m, error: code, pending: false }));
  }

  private finishVoiceTurn(): void {
    this.voiceCurrent = null;
    this.set({ busy: this.controller !== null });
  }

  /** Tears voice down; an answer still in progress ends as stopped (by the visitor) or cut off. */
  private endVoice(notice: string | null, announce = true): void {
    const voice = this.voice;
    if (!voice) return;
    this.voice = null;
    for (const off of this.voiceOff) off();
    this.voiceOff = [];
    voice.close();
    if (notice === VOICE_RESTING) this.voiceRested = true;
    const current = this.voiceCurrent;
    this.voiceCurrent = null;
    this.voiceTurns.clear();
    if (!announce) return;
    if (current) {
      const dropped = notice !== null && notice !== VOICE_RESTING;
      this.patch(current, (m) =>
        m.pending ? (dropped ? { ...m, pending: false, error: m.error ?? "unknown" } : { ...m, pending: false, stopped: true }) : m,
      );
    }
    this.set({
      busy: this.controller !== null,
      voice: { state: "off", transcript: "" },
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
