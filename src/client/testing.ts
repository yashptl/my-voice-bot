/** Fakes for the client tests: a WebSocket the test drives by hand, and an AudioContext that does nothing. */

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void;

export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  readonly sent: (string | ArrayBuffer)[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}

  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  /** The JSON messages the client sent. */
  get sentJson(): unknown[] {
    return this.sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d) as unknown);
  }

  close(code?: number, reason?: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.closedWith = { code, reason };
  }

  /** The server accepts the upgrade. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.fire("open", {});
  }

  /** The server sends a JSON event (or, with a string or buffer, the raw frame). */
  receive(data: unknown): void {
    this.fire("message", { data: typeof data === "string" || data instanceof ArrayBuffer ? data : JSON.stringify(data) });
  }

  /** The socket ends from the server's side. */
  serverClose(code = 1000, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.fire("close", { code, reason });
  }

  private fire(type: string, event: Parameters<Listener>[0]): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

/** An AnalyserNode whose spectrum the test sets: getByteFrequencyData copies `bins` out. */
export class FakeAnalyser {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  readonly context = { sampleRate: 48_000 };
  bins = new Uint8Array(0);
  /** Every buffer getByteFrequencyData was handed, in order. */
  readonly reads: Uint8Array[] = [];
  readonly connected: object[] = [];
  get frequencyBinCount(): number {
    return this.fftSize / 2;
  }
  getByteFrequencyData(out: Uint8Array): void {
    this.reads.push(out);
    out.fill(0);
    out.set(this.bins.subarray(0, out.length));
  }
  connect(node: object): void {
    this.connected.push(node);
  }
}

export class FakeGain {
  readonly gain = { value: 1 };
  readonly connected: object[] = [];
  connect(node: object): void {
    this.connected.push(node);
  }
}

export class FakeAudioContext {
  currentTime = 0;
  readonly destination = {};
  closed = false;
  readonly analysers: FakeAnalyser[] = [];
  readonly gains: FakeGain[] = [];
  resume(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
  createAnalyser(): FakeAnalyser {
    const analyser = new FakeAnalyser();
    this.analysers.push(analyser);
    return analyser;
  }
  readonly sources: FakeBufferSource[] = [];
  createBuffer(_channels: number, length: number) {
    return { getChannelData: () => new Float32Array(length) };
  }
  createBufferSource(): FakeBufferSource {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source;
  }
}

/** A playing chunk: end() is what the browser does when it finishes. */
export class FakeBufferSource {
  buffer: unknown = null;
  private readonly ended: (() => void)[] = [];
  connect(): void {}
  start(): void {}
  stop(): void {}
  addEventListener(_type: "ended", fn: () => void): void {
    this.ended.push(fn);
  }
  end(): void {
    for (const fn of this.ended) fn();
  }
}
