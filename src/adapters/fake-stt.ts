import type { SttEvent, SttOpenOptions, SttPort, SttSession } from "../ports/stt";

export type FakeStt = SttPort & {
  /** Delivers an event to the open session, as Flux would. */
  emit(e: SttEvent): void;
  /** Reports a provider failure to the open session. */
  fail(e: Error): void;
  /** The provider closes the session (as Flux does after ~5 s without audio). */
  drop(): void;
  /** Every frame sent while a session was open, across sessions. */
  frames: ArrayBuffer[];
  /** The keyterms the last open() asked for. */
  keyterms: string[];
  /** How many times open() was called. */
  opens: number;
  /** True once the current session has been closed, by either side. */
  closed: boolean;
  /** The callbacks of the latest open(), so a test can play a stale session. */
  current: SttOpenOptions | null;
  /** When set, open() reports this through onError (as Flux does for a refused upgrade) and returns a dead session. */
  failOpens: Error | null;
};

/** Keyless STT for tests: records frames and lets the test script the events. */
export function createFakeStt(): FakeStt {
  const fake: FakeStt = {
    id: "fake",
    frames: [],
    keyterms: [],
    opens: 0,
    closed: false,
    current: null,
    failOpens: null,
    async open(o): Promise<SttSession> {
      fake.current = o;
      fake.opens++;
      if (fake.failOpens) {
        fake.closed = true;
        o.onError(fake.failOpens);
        return { send() {}, close() {} };
      }
      fake.keyterms = [...o.keyterms];
      fake.closed = false;
      let closed = false;
      return {
        send(frame) {
          if (!closed && !fake.closed && fake.current === o) fake.frames.push(frame);
        },
        close() {
          closed = true;
          if (fake.current === o) fake.closed = true;
        },
      };
    },
    emit(e) {
      if (!fake.closed) fake.current?.onEvent(e);
    },
    fail(e) {
      if (!fake.closed) fake.current?.onError(e);
    },
    drop() {
      if (fake.closed) return;
      fake.closed = true;
      fake.current?.onClose();
    },
  };
  return fake;
}
