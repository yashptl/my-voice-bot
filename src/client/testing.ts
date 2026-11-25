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

export class FakeAudioContext {
  currentTime = 0;
  readonly destination = {};
  resume(): Promise<void> {
    return Promise.resolve();
  }
  createBuffer(_channels: number, length: number) {
    return { getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    return {
      buffer: null,
      connect() {},
      start() {},
      stop() {},
      addEventListener() {},
    };
  }
}
