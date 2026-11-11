import { describe, expect, it } from "vitest";
import type { SocketLike } from "../ports/websocket";
import { VOICE_FORMAT } from "../protocol/audio";
import { createMiniMaxTts } from "./minimax-tts";

type Listener = (e: unknown) => void;

/** A scripted MiniMax server on the far end of a SocketLike. */
class FakeServer implements SocketLike {
  sent: Record<string, unknown>[] = [];
  closedWith: { code?: number } | null = null;
  private fns: Record<"message" | "close" | "error", Listener[]> = { message: [], close: [], error: [] };

  send(data: string | ArrayBuffer): void {
    this.sent.push(JSON.parse(data as string) as Record<string, unknown>);
  }
  close(code?: number): void {
    if (this.closedWith) return;
    this.closedWith = { code };
    queueMicrotask(() => this.emit("close", { code: code ?? 1005, reason: "" }));
  }
  addEventListener(type: "message" | "close" | "error", fn: Listener): void {
    this.fns[type].push(fn);
  }
  emit(type: "message" | "close" | "error", e: unknown): void {
    for (const fn of this.fns[type]) fn(e);
  }
  push(msg: object): void {
    this.emit("message", { data: JSON.stringify(msg) });
  }
  events(): unknown[] {
    return this.sent.map((m) => m.event);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function recorder() {
  const log: string[] = [];
  const audio: { id: number; bytes: number[] }[] = [];
  const errors: Error[] = [];
  return {
    log,
    audio,
    errors,
    onAudio(id: number, pcm: Uint8Array) {
      log.push(`audio ${id}`);
      audio.push({ id, bytes: [...pcm] });
    },
    onSentenceDone(id: number) {
      log.push(`done ${id}`);
    },
    onError(e: Error) {
      log.push("error");
      errors.push(e);
    },
  };
}

const audioMsg = (hex: string, isFinal = false) => ({
  event: "task_continued",
  data: { audio: hex },
  is_final: isFinal,
  base_resp: { status_code: 0, status_msg: "success" },
});

async function openSession(o: { pronunciation?: string[]; model?: string; url?: string } = {}) {
  const server = new FakeServer();
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const tts = createMiniMaxTts({
    apiKey: "test-key",
    voiceId: "English_FriendlyPerson",
    connect: async (url, headers) => {
      seen.push({ url, headers });
      return server;
    },
    ...o,
  });
  const r = recorder();
  const opening = tts.open(r);
  await tick();
  server.push({ event: "connected_success", session_id: "s1" });
  server.push({ event: "task_started", session_id: "s1" });
  const session = await opening;
  return { tts, server, seen, r, session };
}

describe("createMiniMaxTts: open", () => {
  it("is the 24 kHz minimax-speech port", () => {
    const tts = createMiniMaxTts({ apiKey: "k", voiceId: "v", connect: async () => new FakeServer() });
    expect(tts.id).toBe("minimax-speech");
    expect(tts.format).toEqual(VOICE_FORMAT);
  });

  it("connects to t2a_v2 with a bearer key, waits for connected_success, then sends task_start", async () => {
    const server = new FakeServer();
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const tts = createMiniMaxTts({
      apiKey: "test-key",
      voiceId: "English_FriendlyPerson",
      connect: async (url, headers) => {
        seen.push({ url, headers });
        return server;
      },
    });
    let opened = false;
    const opening = tts.open(recorder()).then((s) => {
      opened = true;
      return s;
    });
    await tick();
    expect(seen).toEqual([{ url: "wss://api.minimax.io/ws/v1/t2a_v2", headers: { Authorization: "Bearer test-key" } }]);
    expect(server.sent).toEqual([]);

    server.push({ event: "connected_success", session_id: "s1" });
    expect(server.sent).toEqual([
      {
        event: "task_start",
        model: "speech-2.8-turbo",
        voice_setting: { voice_id: "English_FriendlyPerson" },
        audio_setting: { sample_rate: 24000, format: "pcm", channel: 1 },
        language_boost: "English",
      },
    ]);
    await tick();
    expect(opened).toBe(false);

    server.push({ event: "task_started", session_id: "s1" });
    await opening;
    expect(opened).toBe(true);
  });

  it("passes the model, url and pronunciation dictionary through", async () => {
    const { server, seen } = await openSession({
      model: "speech-2.8-hd",
      url: "wss://api-uw.minimax.io/ws/v1/t2a_v2",
      pronunciation: ["Yash/yaash"],
    });
    expect(seen[0]?.url).toBe("wss://api-uw.minimax.io/ws/v1/t2a_v2");
    expect(server.sent[0]).toMatchObject({ model: "speech-2.8-hd", pronunciation_dict: { tone: ["Yash/yaash"] } });
  });

  it("rejects open when the task fails to start, naming the status code", async () => {
    const server = new FakeServer();
    const tts = createMiniMaxTts({ apiKey: "bad", voiceId: "v", connect: async () => server });
    const opening = tts.open(recorder());
    await tick();
    server.push({ event: "connected_success" });
    server.push({ event: "task_failed", base_resp: { status_code: 1004, status_msg: "auth failed" } });
    await expect(opening).rejects.toThrow(/1004/);
    expect(server.closedWith).not.toBeNull();
  });

  it("rejects open when the socket closes during the handshake", async () => {
    const server = new FakeServer();
    const tts = createMiniMaxTts({ apiKey: "k", voiceId: "v", connect: async () => server });
    const opening = tts.open(recorder());
    await tick();
    server.emit("close", { code: 1006, reason: "" });
    await expect(opening).rejects.toThrow(/1006/);
  });

  it("rejects open when the handshake takes longer than openTimeoutMs", async () => {
    const server = new FakeServer();
    const tts = createMiniMaxTts({ apiKey: "k", voiceId: "v", connect: async () => server, openTimeoutMs: 20 });
    await expect(tts.open(recorder())).rejects.toThrow(/timed out/);
    expect(server.closedWith).not.toBeNull();
  });

  it("rejects open when connect fails", async () => {
    const tts = createMiniMaxTts({
      apiKey: "k",
      voiceId: "v",
      connect: async () => {
        throw new Error("HTTP 401");
      },
    });
    await expect(tts.open(recorder())).rejects.toThrow("HTTP 401");
  });
});

describe("createMiniMaxTts: speaking", () => {
  it("sends one task_continue per sentence, the next only after is_final", async () => {
    const { server, session, r } = await openSession();
    session.speak(0, "Hello there.");
    session.speak(1, "Second.");
    expect(server.sent.slice(1)).toEqual([{ event: "task_continue", text: "Hello there." }]);

    server.push(audioMsg("0a0b"));
    expect(r.audio).toEqual([{ id: 0, bytes: [0x0a, 0x0b] }]);
    expect(server.sent).toHaveLength(2);

    server.push(audioMsg("", true));
    expect(r.log).toEqual(["audio 0", "done 0"]);
    expect(server.sent.slice(2)).toEqual([{ event: "task_continue", text: "Second." }]);

    server.push(audioMsg("0C0D"));
    server.push(audioMsg("", true));
    expect(r.audio.at(-1)).toEqual({ id: 1, bytes: [0x0c, 0x0d] });
    expect(r.log).toEqual(["audio 0", "done 0", "audio 1", "done 1"]);
  });

  it("sends a sentence spoken after the previous one finished straight away", async () => {
    const { server, session } = await openSession();
    session.speak(0, "One.");
    server.push(audioMsg("", true));
    session.speak(1, "Two.");
    expect(server.sent.slice(1).map((m) => m.text)).toEqual(["One.", "Two."]);
  });

  it("treats frames without an event name but with data or is_final as task_continued", async () => {
    const { server, session, r } = await openSession();
    session.speak(0, "Hi.");
    server.push({ data: { audio: "0102" }, is_final: false });
    server.push({ data: { audio: "" }, is_final: true });
    expect(r.log).toEqual(["audio 0", "done 0"]);
  });

  it("delivers audio carried on the is_final frame before the sentence is done", async () => {
    const { server, session, r } = await openSession();
    session.speak(0, "Hi.");
    server.push(audioMsg("0102", true));
    expect(r.log).toEqual(["audio 0", "done 0"]);
  });

  it("ignores data: null chunks, binary frames and non-JSON text", async () => {
    const { server, session, r } = await openSession();
    session.speak(0, "Hi.");
    server.push({ event: "task_continued", data: null, is_final: false });
    server.emit("message", { data: new ArrayBuffer(4) });
    server.emit("message", { data: "not json" });
    server.push(audioMsg("0102"));
    expect(r.audio).toEqual([{ id: 0, bytes: [1, 2] }]);
    expect(r.errors).toEqual([]);
  });

  it("keeps PCM sample-aligned: an odd trailing byte waits for the next chunk", async () => {
    const { server, session, r } = await openSession();
    session.speak(0, "Hi.");
    server.push(audioMsg("0a0b0c"));
    server.push(audioMsg("0d"));
    server.push(audioMsg("0e", true));
    expect(r.audio).toEqual([
      { id: 0, bytes: [0x0a, 0x0b] },
      { id: 0, bytes: [0x0c, 0x0d] },
    ]);
    expect(r.log.at(-1)).toBe("done 0");
  });

  it.each(["zz", "0a0"])("reports malformed hex audio %j as an error", async (hex) => {
    const { server, session, r } = await openSession();
    session.speak(0, "Hi.");
    server.push(audioMsg(hex));
    expect(r.errors[0]?.message).toMatch(/hex/);
    expect(r.audio).toEqual([]);
    expect(server.closedWith).not.toBeNull();
  });
});

describe("createMiniMaxTts: finish and cancel", () => {
  it("sends task_finish after the last sentence completes and resolves on task_finished", async () => {
    const { server, session } = await openSession();
    session.speak(0, "Hi.");
    let finished = false;
    const finishing = session.finish().then(() => (finished = true));
    expect(server.events()).toEqual(["task_start", "task_continue"]);

    server.push(audioMsg("", true));
    expect(server.events()).toEqual(["task_start", "task_continue", "task_finish"]);
    await tick();
    expect(finished).toBe(false);

    server.push({ event: "task_finished" });
    await finishing;
    expect(server.closedWith).not.toBeNull();
  });

  it("sends task_finish at once when nothing is queued", async () => {
    const { server, session } = await openSession();
    const finishing = session.finish();
    expect(server.events()).toEqual(["task_start", "task_finish"]);
    server.push({ event: "task_finished" });
    await expect(finishing).resolves.toBeUndefined();
  });

  it("resolves finish when the server closes after task_finish without task_finished", async () => {
    const { server, session, r } = await openSession();
    const finishing = session.finish();
    server.emit("close", { code: 1000, reason: "" });
    await expect(finishing).resolves.toBeUndefined();
    expect(r.errors).toEqual([]);
  });

  it("ignores speak after finish", async () => {
    const { server, session } = await openSession();
    void session.finish();
    session.speak(0, "Too late.");
    expect(server.events()).toEqual(["task_start", "task_finish"]);
  });

  it("cancel closes the socket and drops anything the server still sends", async () => {
    const { server, session, r } = await openSession();
    session.speak(0, "One.");
    session.speak(1, "Two.");
    server.push(audioMsg("0102"));
    const finishing = session.finish();
    session.cancel();
    expect(server.closedWith).not.toBeNull();

    server.push(audioMsg("0304"));
    server.push(audioMsg("", true));
    session.speak(2, "Three.");
    await tick();
    await expect(finishing).resolves.toBeUndefined();
    expect(r.log).toEqual(["audio 0"]);
    expect(server.events()).toEqual(["task_start", "task_continue"]);
  });
});

describe("createMiniMaxTts: errors", () => {
  it("reports task_failed with its status code, closes, and settles finish", async () => {
    const { server, session, r } = await openSession();
    session.speak(0, "Hi.");
    const finishing = session.finish();
    server.push({ event: "task_failed", base_resp: { status_code: 1004, status_msg: "authentication failed" } });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.message).toContain("1004");
    expect(server.closedWith).not.toBeNull();
    await expect(finishing).resolves.toBeUndefined();

    server.push(audioMsg("0102"));
    await tick();
    expect(r.log).toEqual(["error"]);
  });

  it("treats a non-zero base_resp status on any frame as a failure", async () => {
    const { server, session, r } = await openSession();
    session.speak(0, "Hi.");
    server.push({ event: "task_continued", data: null, base_resp: { status_code: 2013, status_msg: "invalid params" } });
    expect(r.errors[0]?.message).toContain("2013");
  });

  it("reports a socket that closes before the reply finished", async () => {
    const { server, session, r } = await openSession();
    session.speak(0, "Hi.");
    server.emit("close", { code: 1006, reason: "" });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.message).toContain("1006");
  });

  it("reports a socket error once, then stays quiet", async () => {
    const { server, session, r } = await openSession();
    session.speak(0, "Hi.");
    server.emit("error", { message: "boom" });
    server.emit("close", { code: 1006, reason: "" });
    expect(r.log).toEqual(["error"]);
  });
});
