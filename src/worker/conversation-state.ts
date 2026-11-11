import type { NeutralTurn } from "../ports/llm";
import { MIC_FORMAT } from "../protocol/audio";
import { AudioMeter, type AudioMeterState, type MeterResult } from "./meter";

/** Operational log lines: never visitor text or keys. */
export type Log = (level: "info" | "warn" | "error", line: string) => void;

/** The part of Durable Object storage the state needs (`ctx.storage` fits); a Map in tests. */
export interface StateStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export const DEFAULT_MAX_TURNS = 30;
export const DEFAULT_MAX_AUDIO_SECONDS = 600;
const MIC_BYTES_PER_SECOND = MIC_FORMAT.sampleRate * MIC_FORMAT.channels * 2;
/** How much metered audio may go unsaved; a restart of the object loses at most this. */
const SAVE_METER_EVERY_SECONDS = 5;

export interface ConversationStateOptions {
  storage: StateStorage;
  now(): number;
  maxTurns?: number;
  maxAudioSeconds?: number;
  log?: Log;
}

interface Saved {
  meter?: AudioMeterState;
  turnsStarted?: number;
  history?: NeutralTurn[];
}

/**
 * What one conversation keeps whichever socket it is on: the audio meter, the number of turns
 * started and the history. The Durable Object holds one instance and hands it to every VoiceLoop
 * (one per socket), so a reconnect continues the same limits and the same history. Every change is
 * saved to storage, the meter at least every 5 s of audio, so a restart continues them too.
 *
 * Saves are not awaited: Durable Object storage applies writes in order and holds outgoing
 * messages until they are durable. A failed save is logged, never thrown.
 */
export class ConversationState {
  private readonly o: ConversationStateOptions;
  private readonly maxTurns: number;
  private readonly meter: AudioMeter;
  private readonly turns: NeutralTurn[];
  private started: number;
  private savedSeconds: number;

  static async load(o: ConversationStateOptions): Promise<ConversationState> {
    const [meter, turnsStarted, history] = await Promise.all([
      o.storage.get<AudioMeterState>("meter"),
      o.storage.get<number>("turnsStarted"),
      o.storage.get<NeutralTurn[]>("history"),
    ]);
    return new ConversationState(o, { meter, turnsStarted, history });
  }

  constructor(o: ConversationStateOptions, saved: Saved = {}) {
    this.o = o;
    this.maxTurns = o.maxTurns ?? DEFAULT_MAX_TURNS;
    this.meter = new AudioMeter({
      maxSeconds: o.maxAudioSeconds ?? DEFAULT_MAX_AUDIO_SECONDS,
      bytesPerSecond: MIC_BYTES_PER_SECOND,
      now: o.now,
      state: saved.meter,
    });
    this.turns = [...(saved.history ?? [])];
    this.started = saved.turnsStarted ?? 0;
    this.savedSeconds = this.meter.seconds;
  }

  get history(): readonly NeutralTurn[] {
    return this.turns;
  }

  get turnsStarted(): number {
    return this.started;
  }

  /** Seconds of mic audio accepted so far, all sockets together. */
  get audioSeconds(): number {
    return this.meter.seconds;
  }

  /** Meters one mic frame (see AudioMeter); the caller drops it unless "ok". */
  addAudio(bytes: number): MeterResult {
    const result = this.meter.add(bytes);
    if (result === "limit" || this.meter.seconds - this.savedSeconds >= SAVE_METER_EVERY_SECONDS) this.flush();
    return result;
  }

  /** Counts a new turn; false (and nothing counted) once the conversation has used its turns. */
  startTurn(): boolean {
    if (this.started >= this.maxTurns) return false;
    this.started++;
    this.save("turnsStarted", this.started);
    return true;
  }

  /** Appends a question and its answer; returns the answer's index, for replaceAnswer. */
  addExchange(question: string, answer: string): number {
    this.turns.push({ role: "user", text: question }, { role: "assistant", text: answer });
    this.save("history", this.turns);
    return this.turns.length - 1;
  }

  /** Replaces one stored answer, e.g. with only the sentences the visitor heard. */
  replaceAnswer(index: number, answer: string): void {
    if (this.turns[index]?.role !== "assistant") return;
    this.turns[index] = { role: "assistant", text: answer };
    this.save("history", this.turns);
  }

  /** Saves the meter now (a socket closed). */
  flush(): void {
    this.savedSeconds = this.meter.seconds;
    this.save("meter", this.meter.state);
  }

  private save(key: string, value: unknown): void {
    this.o.storage.put(key, structuredClone(value)).catch((err: unknown) => {
      this.o.log?.("error", `could not save ${key}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
