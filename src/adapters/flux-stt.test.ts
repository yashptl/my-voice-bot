import { describe, expect, it } from "vitest";
import type { SttEvent } from "../ports/stt";
import { createFakeStt } from "./fake-stt";
import { createFluxStt } from "./flux-stt";

type Listener = (e: unknown) => void;
type EventType = "message" | "close" | "error";

/** The Workers WebSocket that `env.AI.run(..., { websocket: true })` hands back, faked. */
class FakeFluxSocket {
  log: string[] = [];
  sent: unknown[] = [];
  private bt = "blob";
  private fns: Record<EventType, Listener[]> = { message: [], close: [], error: [] };

  get binaryType(): string {
    return this.bt;
  }
  set binaryType(v: string) {
    this.log.push(`binaryType=${v}`);
    this.bt = v;
  }
  accept(): void {
    this.log.push("accept");
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.log.push(`close ${code ?? ""}`.trim());
  }
  addEventListener(type: EventType, fn: Listener): void {
    this.fns[type].push(fn);
  }
  emit(type: EventType, e: unknown): void {
    for (const fn of this.fns[type]) fn(e);
  }
  push(msg: unknown): void {
    this.emit("message", { data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }
}

function fakeAi(response: { status: number; webSocket: FakeFluxSocket | null; body?: string } | Error) {
  const calls: { model: string; inputs: Record<string, unknown>; options: unknown }[] = [];
  const ai = {
    async run(model: string, inputs: Record<string, unknown>, options: unknown) {
      calls.push({ model, inputs, options });
      if (response instanceof Error) throw response;
      return { status: response.status, webSocket: response.webSocket, text: async () => response.body ?? "" };
    },
  };
  return { ai: ai as unknown as Ai, calls };
}

function recorder() {
  const events: SttEvent[] = [];
  const errors: Error[] = [];
  let closes = 0;
  return {
    events,
    errors,
    get closes() {
      return closes;
    },
    opts(keyterms: string[] = []) {
      return {
        keyterms,
        onEvent: (e: SttEvent) => void events.push(e),
        onError: (e: Error) => void errors.push(e),
        onClose: () => void closes++,
      };
    },
  };
}

describe("createFluxStt", () => {
  it("opens @cf/deepgram/flux over a WebSocket with the planned inputs", async () => {
    const socket = new FakeFluxSocket();
    const { ai, calls } = fakeAi({ status: 101, webSocket: socket });
    const stt = createFluxStt({ ai });
    expect(stt.id).toBe("flux");
    await stt.open(recorder().opts(["Yash", "Magenta Connect"]));
    expect(calls).toEqual([
      {
        model: "@cf/deepgram/flux",
        inputs: {
          encoding: "linear16",
          sample_rate: "16000",
          eot_threshold: "0.7",
          eager_eot_threshold: "0.5",
          eot_timeout_ms: "5000",
          keyterm: ["Yash", "Magenta Connect"],
          mip_opt_out: "true",
        },
        options: { websocket: true },
      },
    ]);
  });

  it("takes threshold overrides and leaves keyterm out when there are none", async () => {
    const { ai, calls } = fakeAi({ status: 101, webSocket: new FakeFluxSocket() });
    await createFluxStt({ ai, eotThreshold: "0.8", eagerEotThreshold: "0.4", eotTimeoutMs: "3000" }).open(
      recorder().opts([]),
    );
    expect(calls[0]?.inputs).toEqual({
      encoding: "linear16",
      sample_rate: "16000",
      eot_threshold: "0.8",
      eager_eot_threshold: "0.4",
      eot_timeout_ms: "3000",
      mip_opt_out: "true",
    });
  });

  it("sets binaryType to arraybuffer before accept()", async () => {
    const socket = new FakeFluxSocket();
    await createFluxStt({ ai: fakeAi({ status: 101, webSocket: socket }).ai }).open(recorder().opts());
    expect(socket.log).toEqual(["binaryType=arraybuffer", "accept"]);
  });

  it("sends audio frames through unchanged", async () => {
    const socket = new FakeFluxSocket();
    const session = await createFluxStt({ ai: fakeAi({ status: 101, webSocket: socket }).ai }).open(recorder().opts());
    const a = new Uint8Array([1, 2, 3, 4]).buffer;
    const b = new ArrayBuffer(2560);
    session.send(a);
    session.send(b);
    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[0]).toBe(a);
    expect(socket.sent[1]).toBe(b);
  });

  it("maps turn events to SttEvents", async () => {
    const socket = new FakeFluxSocket();
    const rec = recorder();
    await createFluxStt({ ai: fakeAi({ status: 101, webSocket: socket }).ai }).open(rec.opts());
    socket.push({ event: "StartOfTurn", transcript: "Where", turn_index: 0, words: [] });
    socket.push({ type: "TurnInfo", event: "Update", transcript: "Where does", turn_index: 0 });
    socket.push({ event: "EagerEndOfTurn", transcript: "Where does Yash work?", turn_index: 0 });
    socket.push({ event: "TurnResumed", transcript: "Where does Yash work", turn_index: 0 });
    socket.push({ event: "EndOfTurn", transcript: "hi", turn_index: 0 });
    socket.push({ event: "EndOfTurn", transcript: "next", turn_index: 1, end_of_turn_confidence: 0.9 });
    expect(rec.events).toEqual([
      { type: "start", transcript: "Where", turnIndex: 0 },
      { type: "update", transcript: "Where does", turnIndex: 0 },
      { type: "eager", transcript: "Where does Yash work?", turnIndex: 0 },
      { type: "resumed", transcript: "Where does Yash work", turnIndex: 0 },
      { type: "end", transcript: "hi", turnIndex: 0 },
      { type: "end", transcript: "next", turnIndex: 1 },
    ]);
  });

  it("ignores other shapes: Connected, warnings, unknown events, bad JSON, binary frames", async () => {
    const socket = new FakeFluxSocket();
    const rec = recorder();
    await createFluxStt({ ai: fakeAi({ status: 101, webSocket: socket }).ai }).open(rec.opts());
    socket.push({ type: "Connected", request_id: "r", sequence_id: 0 });
    socket.push({ type: "Warning", code: "X", description: "y" });
    socket.push({ event: "SomethingNew", transcript: "x", turn_index: 0 });
    socket.push({ event: "EndOfTurn", transcript: 42, turn_index: 0 });
    socket.push("not json");
    socket.push("null");
    socket.emit("message", { data: new ArrayBuffer(8) });
    expect(rec.events).toEqual([]);
    expect(rec.errors).toEqual([]);
  });

  it("tolerates a turn frame without transcript or turn_index", async () => {
    const socket = new FakeFluxSocket();
    const rec = recorder();
    await createFluxStt({ ai: fakeAi({ status: 101, webSocket: socket }).ai }).open(rec.opts());
    socket.push({ event: "EndOfTurn" });
    expect(rec.events).toEqual([{ type: "end", transcript: "", turnIndex: 0 }]);
  });

  it("reports a missing socket through onError with the status and body, and returns an inert session", async () => {
    const rec = recorder();
    const { ai } = fakeAi({ status: 429, webSocket: null, body: '{"errors":[{"message":"AiError: 3040: Capacity"}]}' });
    const session = await createFluxStt({ ai }).open(rec.opts());
    expect(rec.errors).toHaveLength(1);
    expect(rec.errors[0]?.message).toContain("429");
    expect(rec.errors[0]?.message).toContain("3040");
    expect(() => session.send(new ArrayBuffer(4))).not.toThrow();
    expect(() => session.close()).not.toThrow();
  });

  it("reports a failed ai.run through onError", async () => {
    const rec = recorder();
    await createFluxStt({ ai: fakeAi(new Error("network down")).ai }).open(rec.opts());
    expect(rec.errors.map((e) => e.message)).toEqual([expect.stringContaining("network down")]);
  });

  it("reports a Flux fatal error frame through onError", async () => {
    const socket = new FakeFluxSocket();
    const rec = recorder();
    await createFluxStt({ ai: fakeAi({ status: 101, webSocket: socket }).ai }).open(rec.opts());
    socket.push({ type: "Error", sequence_id: 3, code: "INTERNAL_SERVER_ERROR", description: "boom" });
    expect(rec.errors.map((e) => e.message)).toEqual([expect.stringContaining("INTERNAL_SERVER_ERROR")]);
  });

  it("calls onClose when Flux closes the socket, but not after close()", async () => {
    const socket = new FakeFluxSocket();
    const rec = recorder();
    await createFluxStt({ ai: fakeAi({ status: 101, webSocket: socket }).ai }).open(rec.opts());
    socket.emit("close", { code: 1011 });
    socket.emit("close", { code: 1011 });
    expect(rec.closes).toBe(1);

    const socket2 = new FakeFluxSocket();
    const rec2 = recorder();
    const session = await createFluxStt({ ai: fakeAi({ status: 101, webSocket: socket2 }).ai }).open(rec2.opts());
    session.close();
    socket2.emit("close", { code: 1000 });
    socket2.push({ event: "EndOfTurn", transcript: "late", turn_index: 0 });
    session.send(new ArrayBuffer(4));
    expect(socket2.log).toContain("close 1000");
    expect(rec2.closes).toBe(0);
    expect(rec2.events).toEqual([]);
    expect(socket2.sent).toEqual([]);
  });

  it("reports a socket error event through onError", async () => {
    const socket = new FakeFluxSocket();
    const rec = recorder();
    await createFluxStt({ ai: fakeAi({ status: 101, webSocket: socket }).ai }).open(rec.opts());
    socket.emit("error", { message: "reset" });
    expect(rec.errors).toHaveLength(1);
  });
});

describe("createFakeStt", () => {
  it("records frames, emits scripted events, and stops both after close", async () => {
    const stt = createFakeStt();
    const rec = recorder();
    const session = await stt.open(rec.opts(["Yash"]));
    expect(stt.keyterms).toEqual(["Yash"]);
    const frame = new ArrayBuffer(2560);
    session.send(frame);
    stt.emit({ type: "end", transcript: "hi", turnIndex: 0 });
    expect(stt.frames).toEqual([frame]);
    expect(rec.events).toEqual([{ type: "end", transcript: "hi", turnIndex: 0 }]);

    session.close();
    expect(stt.closed).toBe(true);
    session.send(frame);
    stt.emit({ type: "end", transcript: "late", turnIndex: 1 });
    expect(stt.frames).toHaveLength(1);
    expect(rec.events).toHaveLength(1);
  });

  it("can close from the provider side, and counts opens", async () => {
    const stt = createFakeStt();
    const rec = recorder();
    await stt.open(rec.opts());
    stt.drop();
    expect(rec.closes).toBe(1);
    expect(stt.closed).toBe(true);
    const session = await stt.open(rec.opts());
    expect(stt.opens).toBe(2);
    session.send(new ArrayBuffer(4));
    expect(stt.frames).toHaveLength(1);
  });

  it("can fail to open, reporting through onError before open() resolves", async () => {
    const stt = createFakeStt();
    const rec = recorder();
    stt.failOpens = new Error("HTTP 429");
    const session = await stt.open(rec.opts());
    expect(rec.errors.map((e) => e.message)).toEqual(["HTTP 429"]);
    session.send(new ArrayBuffer(4));
    expect(stt.frames).toEqual([]);
  });

  it("can fail like a provider would", async () => {
    const stt = createFakeStt();
    const rec = recorder();
    await stt.open(rec.opts());
    stt.fail(new Error("flux went away"));
    expect(rec.errors.map((e) => e.message)).toEqual(["flux went away"]);
  });
});
