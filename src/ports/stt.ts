export type SttEventType = "update" | "start" | "eager" | "resumed" | "end";

/** `transcript` is the whole turn so far. */
export interface SttEvent {
  type: SttEventType;
  transcript: string;
  turnIndex: number;
}

export interface SttSession {
  /** One MIC_FORMAT frame (80 ms, 2560 bytes). */
  send(frame: ArrayBuffer): void;
  close(): void;
}

export interface SttOpenOptions {
  keyterms: string[];
  onEvent(e: SttEvent): void;
  onError(e: Error): void;
  onClose(): void;
}

export interface SttPort {
  readonly id: string;
  open(o: SttOpenOptions): Promise<SttSession>;
}
