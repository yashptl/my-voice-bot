import { estimateCostUsd, type LlmProfile } from "../adapters/llm-profiles";
import { GateTally } from "../core/output-gate";
import { buildStable, promptHash } from "../core/prompt";
import { respond } from "../core/respond";
import { sanitizeInput } from "../core/sanitize";
import type { Bundle } from "../knowledge/types";
import { LlmError, type LlmPort, type LlmUsage, type NeutralTurn } from "../ports/llm";
import type { SttEvent, SttPort, SttSession } from "../ports/stt";
import type { TtsPort, TtsSession } from "../ports/tts";
import { encodeAudioFrame } from "../protocol/audio";
import type { DataLine, DataLineStatus } from "../protocol/data-line";
import type { ClientMessage, ErrorCode, ServerEvent } from "../protocol/events";
import type { GateSummary, GroundingResult, Mark, TurnRecord } from "../protocol/turn-record";
import { PROTOCOL_VERSION } from "../protocol/version";
import type { ConversationState, Log } from "./conversation-state";
import { LLM_IDLE_MS, LLM_TOTAL_MS, STOPPED, within, withDeadlines } from "./deadlines";
import { sourcesOf } from "./text-turn";

/** Flux sessions per socket; each quiet gap between questions costs one. */
const MAX_STT_SESSIONS = 60;
/** Frames kept while Flux (re)opens: 10 s of audio; older ones are dropped. */
const MAX_PENDING_FRAMES = 125;

// Speech deadlines (the LLM's are in deadlines.ts). Missing one ends the turn with a provider error.
/** Opening speech output, connecting included. */
export const TTS_OPEN_MS = 5_000;
/** From the end of the answer until speech has synthesized all of it. */
export const TTS_FINISH_MS = 15_000;

/** WebSocket close codes the loop asks its owner to use. */
const CLOSE_POLICY = 1008;
const CLOSE_NORMAL = 1000;

/**
 * How long a voice socket may sit with no mic audio, no client message and no answer running before
 * the loop closes it. A forgotten tab would otherwise keep its Durable Object running (and billed)
 * for as long as the tab stays open; a tab whose mic is still streaming is bounded by the audio limit.
 */
export const VOICE_IDLE_CLOSE_MS = 120_000;
const CLOSE_PROVIDER = 1011;

export interface VoiceLoopOptions {
  conversationId: string;
  stt: SttPort;
  llm: LlmPort;
  /** The LLM profile's prices, for `costUsd`; null or omitted for the demo. */
  prices?: LlmProfile["prices"] | null;
  tts: TtsPort;
  bundle: Bundle;
  /** One JSON event or one binary audio frame to the visitor. */
  send(e: ServerEvent | ArrayBuffer): void;
  now(): number;
  /** The conversation's meter, turn count and history, shared by every socket so a reconnect continues them. */
  state: ConversationState;
  /**
   * Spends one of the day's shared turns, called before each answer. False (or a failure) sends a
   * `resting` error and ends the conversation. Omitted: no daily ceiling (tests).
   */
  spendTurn?(): Promise<boolean>;
  /** Called after the loop ends the conversation itself (a limit, or speech recognition failing). */
  closeSocket?(code: number, reason: string): void;
  /** Close the socket after this long idle (see VOICE_IDLE_CLOSE_MS); never when unset. */
  idleCloseMs?: number;
  /** Provider events only, never visitor text or keys: info for routine ones, error for failures. */
  log?: Log;
  /**
   * Called with each turn's record for the turn log: when `turn.end` sends it, again with
   * `interrupted` set after a late interrupt, and for an answer cut off by the socket closing
   * (marked interrupted, though nothing more is sent).
   */
  onRecord?(record: TurnRecord): void;
}

interface Turn {
  id: string;
  question: string;
  receivedAt: number;
  marks: TurnRecord["marks"];
  controller: AbortController;
  /** Opened alongside the LLM call; null when speech failed to open. */
  tts: Promise<TtsSession | null>;
  ttsSession: TtsSession | null;
  sentences: { id: number; text: string }[];
  ttsChars: number;
  usage: LlmUsage | null;
  coverage: DataLine["coverage"] | null;
  /** From `meta`: null until the reply was complete. */
  dataLine: DataLineStatus | null;
  /** Sentences the output gate dropped so far; `done` then brings the full summary. */
  gated: GateTally;
  /** From `done`: null until the answer finished. */
  gate: GateSummary | null;
  grounding: GroundingResult | null;
  error: string | null;
  /** Speech output failed or stalled; reported once, the captions carry on. */
  ttsFailed: boolean;
  speaking: boolean;
  /** The day's turn was spent, so the model was called: a turn cut off by close() is still recorded. */
  spent: boolean;
  interrupted: boolean;
  /** Ended, interrupted or closed: nothing more is sent for this turn. */
  stopped: boolean;
}

/** The latest turn that ended on its own: the client may still interrupt its playback. */
interface EndedTurn {
  id: string;
  sentences: { id: number; text: string }[];
  /** Index of its answer in the history. */
  index: number;
  record: TurnRecord;
}

const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/** Flux's error for the `KeepAlive` the Workers AI proxy sends it after ~5 s without audio (see openStt). */
const WORKERS_AI_KEEPALIVE = /UNPARSABLE_CLIENT_MESSAGE[^]*`KeepAlive`/;

/**
 * The log line for an open Flux session that ended. All of these are expected, so none is an error:
 * the Workers AI KeepAlive close and a plain close are info, any other error a warning.
 */
function sessionEndedLog(session: number, why: string, openForMs: number, idleMs: number | null): Parameters<Log> {
  const reopens = "it reopens on the next audio frame";
  if (WORKERS_AI_KEEPALIVE.test(why)) {
    const quietS = ((idleMs ?? openForMs) / 1000).toFixed(1);
    return [
      "info",
      `stt session ${session} closed by Workers AI after ${quietS} s without audio (known KeepAlive behaviour); ${reopens}`,
    ];
  }
  const audio = idleMs === null ? "with no audio sent" : `${idleMs} ms after its last audio`;
  return [why === "closed" ? "info" : "warn", `stt session ${session} ended (${why}) after ${openForMs} ms, ${audio}; ${reopens}`];
}

/**
 * One voice conversation on one socket: mic frames → STT; each end of turn → `respond` → captions
 * and TTS audio → a TurnRecord.
 *
 * Interrupts (from the client, or a new end of turn while a reply runs) abort the LLM stream,
 * cancel TTS and drop any later audio for that turn; history keeps only the sentences up to the
 * last one the client heard (none when it heard none, or when a new end of turn cut in). An
 * interrupt for the turn that just ended (its audio still playing in the browser, the usual case
 * with real TTS, which runs faster than real time) trims history the same way and sends
 * `turn.interrupted` with the updated record.
 *
 * Each provider has a deadline (LLM_TOTAL_MS, LLM_IDLE_MS, TTS_OPEN_MS, TTS_FINISH_MS), raced
 * against the turn's abort signal: missing one sends a provider error and ends the turn with an
 * error record, and the loop listens again.
 *
 * Flux ending an open session (it does after ~5 s without audio) only drops it, with an `stt`
 * event; the next mic frame opens a new one. Failing to open Flux, the audio limit, the turn limit
 * or the day's shared turns running out (`spendTurn`) ends the conversation. The limits and the
 * history live in the shared ConversationState.
 */
export class VoiceLoop {
  private readonly o: VoiceLoopOptions;
  private session: SttSession | null = null;
  /** When the current Flux session opened, and when it was last sent audio (null: not yet). */
  private sessionOpenedAt = 0;
  private lastAudioAt: number | null = null;
  /** Last mic frame, client message, or turn end; the idle close counts from here. */
  private lastActivityAt = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private opening: Promise<void> | null = null;
  private sttGeneration = 0;
  private sttOpens = 0;
  /** Mic frames waiting for a Flux session to open. */
  private pending: ArrayBuffer[] = [];
  private closed = false;
  private hash = "";
  private current: Turn | null = null;
  private lastEnded: EndedTurn | null = null;
  private eager: { turnIndex: number; at: number } | null = null;
  private partial: { turnIndex: number; text: string } | null = null;
  private tooFastReported = false;
  /** Metered seconds already put in a record; starts at the conversation's total, so only this socket's audio counts. */
  private audioAccounted: number;
  /** Mic frames dropped since the last record. */
  private droppedFrames = 0;

  constructor(o: VoiceLoopOptions) {
    this.o = o;
    this.audioAccounted = o.state.audioSeconds;
  }

  /** The conversation's history (shared with every other socket of the conversation). */
  get history(): readonly NeutralTurn[] {
    return this.o.state.history;
  }

  /** Opens STT; sends `ready` once frames can flow. A failure becomes a provider error instead. */
  async start(): Promise<void> {
    const [, hash] = await Promise.all([this.openStt(), promptHash(buildStable(this.o.bundle))]);
    this.hash = hash;
    if (this.closed) return;
    this.send({ type: "ready", protocol: PROTOCOL_VERSION, mode: "voice", audio: this.o.tts.format });
    this.send({ type: "state", state: "listening" });
    this.lastActivityAt = this.o.now();
    this.armIdle(this.o.idleCloseMs);
  }

  /** Checks for idleness after `delay` ms; one timer at a time, so a frame costs only a timestamp. */
  private armIdle(delay: number | undefined): void {
    if (delay === undefined || this.closed) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.checkIdle(), Math.max(0, delay));
  }

  private checkIdle(): void {
    const limit = this.o.idleCloseMs;
    if (limit === undefined || this.closed) return;
    const idleFor = this.o.now() - this.lastActivityAt;
    if (this.current) return this.armIdle(limit); // an answer is running: not idle
    if (idleFor < limit) return this.armIdle(limit - idleFor);
    this.o.log?.("info", `closing the voice socket after ${Math.round(idleFor / 1000)} s without audio`);
    this.end(CLOSE_NORMAL, "idle");
  }

  onAudio(frame: ArrayBuffer): void {
    if (this.closed) return;
    this.lastActivityAt = this.o.now();
    switch (this.o.state.addAudio(frame.byteLength)) {
      case "limit":
        this.send({ type: "error", code: "limit", message: "This conversation has used its audio allowance." });
        return this.end(CLOSE_POLICY, "audio limit");
      case "too_fast":
        this.droppedFrames++;
        if (!this.tooFastReported) {
          this.tooFastReported = true;
          this.send({ type: "error", code: "protocol", message: "Audio is arriving faster than real time; extra frames are dropped." });
        }
        return;
    }
    if (this.session) {
      this.lastAudioAt = this.o.now();
      return this.session.send(frame);
    }
    if (this.pending.length >= MAX_PENDING_FRAMES) {
      this.pending.shift();
      this.droppedFrames++;
    }
    this.pending.push(frame);
    void this.openStt();
  }

  onMessage(m: ClientMessage): void {
    if (this.closed) return;
    this.lastActivityAt = this.o.now();
    if (m.type === "interrupt") {
      if (this.current?.id === m.turnId) this.interrupt(this.current, m.lastHeardSentenceId);
      else if (this.lastEnded?.id === m.turnId) this.trimEnded(m.lastHeardSentenceId);
      return;
    }
    const t = this.current;
    if (t?.id === m.turnId) this.mark(t, m.mark); // server receipt time; the client keeps its own clock
  }

  /** Stops everything without sending anything more; an answer cut off still goes to onRecord. Safe to call twice. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    this.pending = [];
    this.session?.close();
    this.session = null;
    const t = this.current;
    this.current = null;
    if (!t) return;
    this.stop(t);
    if (t.spent) {
      t.interrupted = true;
      this.o.onRecord?.(this.recordOf(t));
    }
  }

  private send(e: ServerEvent | ArrayBuffer): void {
    if (!this.closed) this.o.send(e);
  }

  private end(code: number, reason: string): void {
    this.close();
    this.o.closeSocket?.(code, reason);
  }

  /**
   * Opens a Flux session (one at a time), then forwards the frames that queued meanwhile. Failing to
   * open ends the conversation. Once open, a session that errors or closes is only dropped and the
   * next frame opens a new one: on Workers AI, Flux dies after ~5 s without audio (the platform sends
   * it a `KeepAlive` it rejects), and the half-duplex client does go quiet between questions.
   */
  private openStt(): Promise<void> {
    this.opening ??= (async () => {
      const number = ++this.sttOpens;
      if (number > MAX_STT_SESSIONS) {
        // Ends the conversation, so `opening` staying set does not matter.
        return this.sttFailed(new Error(`gave up after ${MAX_STT_SESSIONS} speech recognition sessions`));
      }
      const generation = ++this.sttGeneration;
      const live = () => generation === this.sttGeneration && !this.closed;
      let opened = false;
      const lost = (why: string) => {
        if (!live()) return;
        const now = this.o.now();
        const openForMs = now - this.sessionOpenedAt;
        const idleMs = this.lastAudioAt === null ? null : now - this.lastAudioAt;
        this.o.log?.(...sessionEndedLog(number, why, openForMs, idleMs));
        this.dropStt();
        this.send({ type: "stt", status: "closed", session: number, openForMs, idleMs });
      };
      try {
        const session = await this.o.stt.open({
          keyterms: this.o.bundle.keyterms,
          onEvent: (e) => {
            if (live()) this.onSttEvent(e);
          },
          onError: (e) => {
            if (!live()) return;
            if (opened) lost(e.message);
            else this.sttFailed(e);
          },
          onClose: () => lost("closed"),
        });
        if (!live()) return session.close();
        opened = true;
        this.session = session;
        this.sessionOpenedAt = this.o.now();
        this.lastAudioAt = this.pending.length > 0 ? this.sessionOpenedAt : null;
        this.partial = null; // a new session counts turns from 0 again
        this.eager = null;
        if (number > 1) this.send({ type: "stt", status: "reopened", session: number });
        for (const frame of this.pending) session.send(frame);
        this.pending = [];
      } catch (err) {
        if (live()) this.sttFailed(asError(err));
      } finally {
        this.opening = null;
      }
    })();
    return this.opening;
  }

  /** Forgets the current session; anything it still sends is ignored. */
  private dropStt(): void {
    this.sttGeneration++;
    const session = this.session;
    this.session = null;
    session?.close();
  }

  private sttFailed(e: Error): void {
    if (this.closed) return;
    this.o.log?.("error", `stt failed: ${e.message}`);
    this.send({ type: "error", code: "provider", message: "Speech recognition stopped. Please reconnect." });
    this.end(CLOSE_PROVIDER, "speech recognition failed");
  }

  private onSttEvent(e: SttEvent): void {
    if (this.closed) return;
    switch (e.type) {
      case "start":
      case "update": {
        // Flux repeats the whole transcript every ~0.25 s, also during silence: send only changes.
        const last = this.partial?.turnIndex === e.turnIndex ? this.partial.text : "";
        if (e.transcript === last) return;
        this.partial = { turnIndex: e.turnIndex, text: e.transcript };
        return this.send({ type: "transcript", turnIndex: e.turnIndex, text: e.transcript, final: false });
      }
      case "eager":
        this.eager = { turnIndex: e.turnIndex, at: this.o.now() };
        return;
      case "resumed":
        this.eager = null;
        return;
      case "end": {
        this.partial = null;
        this.send({ type: "transcript", turnIndex: e.turnIndex, text: e.transcript, final: true });
        const eagerAt = this.eager?.turnIndex === e.turnIndex ? this.eager.at : null;
        this.eager = null;
        // Stored in history and sent to the LLM again on later turns, so cleaned once here.
        const question = sanitizeInput(e.transcript).trim();
        if (question) this.startTurn(question, eagerAt);
        return;
      }
    }
  }

  private startTurn(question: string, eagerAt: number | null): void {
    if (!this.o.state.startTurn()) {
      this.send({ type: "error", code: "limit", message: "This conversation has reached its question limit." });
      return this.end(CLOSE_POLICY, "turn limit");
    }
    if (this.current) this.interrupt(this.current, null);

    const receivedAt = this.o.now();
    const t: Turn = {
      id: crypto.randomUUID(),
      question,
      receivedAt,
      marks: { received: 0, endOfTurn: 0, ...(eagerAt === null ? {} : { eagerEndOfTurn: eagerAt - receivedAt }) },
      controller: new AbortController(),
      tts: Promise.resolve(null),
      ttsSession: null,
      sentences: [],
      ttsChars: 0,
      usage: null,
      coverage: null,
      dataLine: null,
      gated: new GateTally(),
      gate: null,
      grounding: null,
      error: null,
      ttsFailed: false,
      speaking: false,
      spent: false,
      interrupted: false,
      stopped: false,
    };
    this.current = t;
    this.lastEnded = null;
    this.send({ type: "state", state: "thinking" });
    this.send({ type: "turn.start", turnId: t.id, question });

    const opening = this.o.tts.open({
      onAudio: (id, pcm) => this.onTtsAudio(t, id, pcm),
      onSentenceDone: () => {},
      onError: (err) => this.ttsFailed(t, "tts_failed", err),
    });
    t.tts = within(opening, TTS_OPEN_MS, t.controller.signal).then(
      (s) => {
        if (s === STOPPED) {
          void opening.then((late) => late.cancel(), () => {});
          if (!t.stopped) this.ttsFailed(t, "tts_timeout", new Error(`speech did not open within ${TTS_OPEN_MS} ms`));
          return null;
        }
        if (t.stopped) {
          s.cancel();
          return null;
        }
        t.ttsSession = s;
        return s;
      },
      (err: unknown) => {
        this.ttsFailed(t, "tts_failed", asError(err));
        return null;
      },
    );
    void this.run(t).catch((err: unknown) => this.o.log?.("error", `turn failed: ${asError(err).message}`));
  }

  private async run(t: Turn): Promise<void> {
    if (!(await this.spendTurn(t))) return;
    t.spent = true;
    let prose: string | null = null;
    try {
      const events = respond({
        llm: this.guarded(t),
        bundle: this.o.bundle,
        history: [...this.o.state.history],
        message: t.question,
        mode: "voice",
        signal: t.controller.signal,
      });
      for await (const ev of events) {
        if (t.stopped) return;
        switch (ev.type) {
          case "reasoning":
            this.mark(t, "firstReasoning");
            break;
          case "sentence": {
            this.mark(t, "firstSentence");
            t.sentences.push({ id: ev.id, text: ev.text });
            t.ttsChars += ev.text.length;
            this.send({ type: "sentence", turnId: t.id, id: ev.id, text: ev.text });
            void t.tts.then((s) => s?.speak(ev.id, ev.text));
            break;
          }
          case "gated":
            t.gated.add({ text: "", blocked: ev.reasons, flags: [] });
            break;
          case "meta":
            t.dataLine = ev.dataLine;
            if (ev.data) {
              t.coverage = ev.data.coverage;
              this.send({ type: "meta", turnId: t.id, data: ev.data, sources: sourcesOf(ev.data.refs, this.o.bundle) });
            } else if (ev.refs?.length) {
              this.send({ type: "sources", turnId: t.id, sources: sourcesOf(ev.refs, this.o.bundle) });
            }
            break;
          case "usage":
            t.usage = ev.usage;
            break;
          case "done":
            this.mark(t, "done");
            prose = ev.prose;
            t.gate = ev.gate;
            t.grounding = ev.grounding;
            break;
        }
      }
    } catch (err) {
      if (t.stopped) return; // interrupted or closed: already handled
      t.error = err instanceof LlmError ? `llm_${err.kind}` : "llm_failed";
      this.o.log?.("error", `llm failed: ${err instanceof LlmError ? `${err.kind} ${err.status ?? ""}`.trim() : "unexpected error"}`);
      this.send({ type: "error", code: "provider", message: "The assistant could not finish that answer. Please try again." });
    }
    const tts = await t.tts;
    if (tts && !t.stopped) {
      const finished = await within(tts.finish(), TTS_FINISH_MS, t.controller.signal);
      if (finished === STOPPED && !t.stopped) {
        tts.cancel();
        this.ttsFailed(t, "tts_timeout", new Error(`speech did not finish within ${TTS_FINISH_MS} ms`));
      }
    }
    if (t.stopped) return;
    this.endTurn(t, prose ?? t.sentences.map((s) => s.text).join(" "));
  }

  /**
   * Spends one of the day's shared turns before the LLM is called. Refused, or failing, sends
   * `resting` and ends the conversation (fails closed: an unchecked turn could pass the ceiling).
   */
  private async spendTurn(t: Turn): Promise<boolean> {
    const ok = this.o.spendTurn ? await this.o.spendTurn().catch(() => false) : true;
    if (t.stopped) return false;
    if (!ok) {
      this.sendError("resting", "The assistant is resting for now. Messages is the best way to reach Yash.");
      this.end(CLOSE_POLICY, "resting");
    }
    return ok;
  }

  /** The LLM with the turn's deadlines (see withDeadlines), marking the first answer token as it arrives. */
  private guarded(t: Turn): LlmPort {
    return withDeadlines(this.o.llm, {
      now: this.o.now,
      totalMs: LLM_TOTAL_MS,
      idleMs: LLM_IDLE_MS,
      onFirstText: () => this.mark(t, "firstAnswerToken"),
      onRetry: (err) => this.o.log?.("warn", `llm ${err.kind}, retrying once`),
    });
  }

  private onTtsAudio(t: Turn, sentenceId: number, pcm: Uint8Array): void {
    if (t.stopped || this.closed) return;
    if (!t.speaking) {
      t.speaking = true;
      this.mark(t, "firstAudio");
      this.send({ type: "state", state: "speaking" });
    }
    this.send(encodeAudioFrame(sentenceId, pcm));
  }

  private ttsFailed(t: Turn, error: "tts_failed" | "tts_timeout", e: Error): void {
    if (t.stopped || t.ttsFailed) return;
    t.ttsFailed = true;
    t.error ??= error;
    this.o.log?.("error", `tts failed: ${e.message}`);
    this.sendError("provider", "Speech output failed; the answer continues as text.");
  }

  private sendError(code: ErrorCode, message: string): void {
    this.send({ type: "error", code, message });
  }

  private mark(t: Turn, mark: Mark): void {
    t.marks[mark] ??= this.o.now() - t.receivedAt;
  }

  /** Aborts the LLM and TTS for `t` and stops forwarding its audio. */
  private stop(t: Turn): void {
    t.stopped = true;
    t.controller.abort();
    t.ttsSession?.cancel(); // a session still opening is cancelled when it resolves
  }

  private interrupt(t: Turn, lastHeard: number | null): void {
    if (t.stopped) return;
    this.stop(t);
    t.interrupted = true;
    this.endTurn(t, heardText(t.sentences, lastHeard));
  }

  /** An interrupt after turn.end: trims the answer to what was heard and re-sends the record, marked. */
  private trimEnded(lastHeard: number | null): void {
    const ended = this.lastEnded;
    this.lastEnded = null;
    if (!ended) return;
    const lastId = ended.sentences.at(-1)?.id ?? -1;
    // Heard up to the last sentence: the prose stays whole, but the turn was still cut short.
    if (lastHeard === null || lastHeard < lastId) this.o.state.replaceAnswer(ended.index, heardText(ended.sentences, lastHeard));
    const record: TurnRecord = { ...ended.record, interrupted: true };
    this.send({ type: "turn.interrupted", turnId: ended.id, lastHeardSentenceId: lastHeard, record });
    this.o.onRecord?.(record);
  }

  private endTurn(t: Turn, assistantText: string): void {
    t.stopped = true;
    this.lastActivityAt = this.o.now();
    if (this.current === t) this.current = null;
    const index = this.o.state.addExchange(t.question, assistantText);
    const record = this.recordOf(t);
    if (!t.interrupted) this.lastEnded = { id: t.id, sentences: t.sentences, index, record };
    this.send({ type: "turn.end", turnId: t.id, record });
    // Like close(): a turn interrupted while its spend was pending never called the model, so no row.
    if (t.spent) this.o.onRecord?.(record);
    this.send({ type: "state", state: "listening" });
  }

  /** The turn's record; audio and dropped frames count from the previous record on this socket. */
  private recordOf(t: Turn): TurnRecord {
    const seconds = this.o.state.audioSeconds;
    const audioInSeconds = seconds - this.audioAccounted;
    this.audioAccounted = seconds;
    const droppedFrames = this.droppedFrames;
    this.droppedFrames = 0;
    const u = t.usage;
    return {
      turnId: t.id,
      conversationId: this.o.conversationId,
      mode: "voice",
      protocol: PROTOCOL_VERSION,
      model: this.o.llm.model,
      promptHash: this.hash,
      knowledgeHash: this.o.bundle.hash,
      marks: t.marks,
      tokens: {
        input: u?.input ?? 0,
        cachedInput: u?.cachedInput ?? 0,
        reasoning: u?.reasoning ?? 0,
        reasoningEstimated: u?.reasoningEstimated ?? false,
        output: u?.output ?? 0,
      },
      ttsChars: t.ttsChars,
      audioInSeconds,
      droppedFrames,
      costUsd: estimateCostUsd(u, this.o.prices ?? null),
      coverage: t.coverage,
      dataLine: t.dataLine,
      gate: t.gate ?? t.gated.summary(),
      grounding: t.grounding,
      interrupted: t.interrupted,
      error: t.error,
    };
  }
}

function heardText(sentences: { id: number; text: string }[], lastHeard: number | null): string {
  if (lastHeard === null) return "";
  return sentences
    .filter((s) => s.id <= lastHeard)
    .map((s) => s.text)
    .join(" ");
}
