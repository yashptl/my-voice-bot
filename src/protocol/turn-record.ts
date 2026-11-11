import type { DataLine, DataLineStatus } from "./data-line";

/** Marks the client measures and reports with a `mark` message. */
export const CLIENT_MARKS = ["clientTurnEnd", "clientFirstAudioPlayed"] as const;

export type ClientMark = (typeof CLIENT_MARKS)[number];

export type Mark =
  | "received"
  | "eagerEndOfTurn"
  | "endOfTurn"
  | "firstReasoning"
  | "firstAnswerToken"
  | "firstSentence"
  | "firstAudio"
  | "done"
  | ClientMark;

/** Why the output gate dropped a sentence before it was shown or spoken. */
export const GATE_REASONS = ["url", "email", "phone", "code", "profanity", "copied", "too_long"] as const;
export type GateReason = (typeof GATE_REASONS)[number];

/** What the gate let through but noted: markdown it stripped, hype words it found, he or she it replaced with Yash. */
export const GATE_FLAGS = ["markdown", "hype", "pronoun"] as const;
export type GateFlag = (typeof GATE_FLAGS)[number];

export interface GateSummary {
  /** Sentences dropped. */
  dropped: number;
  /** Each reason once, in GATE_REASONS order. */
  reasons: GateReason[];
  /** Each flag once, in GATE_FLAGS order. */
  flags: GateFlag[];
}

/**
 * The deterministic grounding check: claims in the answer that the cited sections do not support,
 * split by how bad that is. An invented claim is wrong; an uncited one is true but cited badly.
 */
export interface GroundingResult {
  /** Claims checked (numbers, known names, unknown proper names). */
  checked: number;
  /**
   * Claims found nowhere in the knowledge and not taken from the visitor's message (inventions), as
   * they appear in the answer; empty when grounded. A number counts unless the cited sections or the
   * visitor's message hold it, since one from an uncited section is easily the wrong one.
   */
  unsupported: string[];
  /** Names the knowledge holds, but not in the sections the answer cited (a missing citation). */
  uncited: string[];
}

/** One answered (or interrupted) turn, as measured by the server. */
export interface TurnRecord {
  turnId: string;
  conversationId: string;
  mode: "text" | "voice";
  protocol: number;
  model: string;
  promptHash: string;
  knowledgeHash: string;
  /** Milliseconds since the "received" mark. */
  marks: Partial<Record<Mark, number>>;
  tokens: { input: number; cachedInput: number; reasoning: number; reasoningEstimated: boolean; output: number };
  ttsChars: number;
  audioInSeconds: number;
  /** Voice only: mic frames the server dropped since the previous record (too fast, or queued too long). */
  droppedFrames?: number;
  /** Estimated from the profile's prices; null when usage or prices are unknown (the demo). */
  costUsd: number | null;
  coverage: DataLine["coverage"] | null;
  /**
   * How the reply's data line came out: "ok"; "missing" when the reply had none, so no sources and
   * no contact flag; "invalid" when it would not parse or was a bare `<refs>` list (then only the
   * sources survive). Null when the turn ended before the reply was complete (interrupted, aborted
   * or failed first), as there was no data line to check yet.
   */
  dataLine: DataLineStatus | null;
  gate: GateSummary;
  /** Null when the turn ended before the answer finished (interrupted, aborted or failed). */
  grounding: GroundingResult | null;
  interrupted: boolean;
  error: string | null;
}
