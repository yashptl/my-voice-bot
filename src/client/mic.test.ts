import { afterEach, describe, expect, it, vi } from "vitest";
import { micFailure, startMic } from "./mic";
import { FakeAnalyser } from "./testing";

const WORKLET_URL = "/assets/capture-worklet.js";

afterEach(() => vi.unstubAllGlobals());

class FakeNode {
  connected: object[] = [];
  connect(node: object): void {
    this.connected.push(node);
  }
  disconnect(): void {
    this.connected = [];
  }
}

class FakeWorkletNode extends FakeNode {
  readonly port = { onmessage: null as unknown, postMessage() {}, close() {} };
}

/** A context, mic and worklet that do nothing, so startMic runs to the end in Node. */
function fakeAudio() {
  const addModule = vi.fn(async () => {});
  const source = new FakeNode();
  const analyser = new FakeAnalyser();
  const track = { stop: vi.fn() };
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  vi.stubGlobal("AudioBufferSourceNode", class {});
  const context = {
    audioWorklet: { addModule },
    destination: {},
    createMediaStreamSource: () => source,
    createAnalyser: () => analyser,
  } as unknown as AudioContext;
  return { context, addModule, source, analyser, track, getUserMedia };
}

describe("startMic", () => {
  it("loads the worklet from the URL it is given", async () => {
    const addModule = vi.fn(async () => {});
    const getUserMedia = vi.fn(async () => {
      throw new Error("stop here");
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const context = { audioWorklet: { addModule } } as unknown as AudioContext;
    await expect(startMic({ context, source: "mic", workletUrl: WORKLET_URL, onFrame() {} })).rejects.toThrow("stop here");
    expect(addModule).toHaveBeenCalledWith(WORKLET_URL);
  });

  it("reads levels from a side branch off the mic that does not reach the speakers", async () => {
    const { context, source, analyser } = fakeAudio();
    const mic = await startMic({ context, source: "mic", workletUrl: WORKLET_URL, onFrame() {} });
    expect(source.connected).toContain(analyser);
    expect(analyser.connected).toEqual([]);
    analyser.bins = new Uint8Array(analyser.frequencyBinCount).fill(255);
    const out = new Float32Array(5);
    mic.readLevels(out);
    expect([...out]).toEqual([1, 1, 1, 1, 1]);
    mic.stop();
    expect(source.connected).toEqual([]);
  });

  it("stops the mic again when building the graph fails after it opened (a context closed meanwhile)", async () => {
    const { context, track } = fakeAudio();
    (context as unknown as { createAnalyser: () => never }).createAnalyser = () => {
      throw new DOMException("closed", "InvalidStateError");
    };
    await expect(startMic({ context, source: "mic", workletUrl: WORKLET_URL, onFrame() {} })).rejects.toMatchObject({ name: "InvalidStateError" });
    expect(track.stop).toHaveBeenCalled();
  });

  it("without navigator.mediaDevices (an insecure page) fails as a missing mic, before loading the worklet", async () => {
    const { context, addModule } = fakeAudio();
    vi.stubGlobal("navigator", {});
    const starting = startMic({ context, source: "mic", workletUrl: WORKLET_URL, onFrame() {} });
    await expect(starting).rejects.toMatchObject({ name: "NotFoundError" });
    expect(micFailure(await starting.catch((e: unknown) => e))).toBe("mic_missing");
    expect(addModule).not.toHaveBeenCalled();
  });
});

describe("micFailure", () => {
  it.each([
    ["NotAllowedError", "mic_blocked"],
    ["SecurityError", "mic_blocked"],
    ["NotFoundError", "mic_missing"],
    ["OverconstrainedError", "mic_missing"],
    ["AbortError", "mic"],
    ["NotReadableError", "mic"],
  ])("reads %s as %s", (name, expected) => {
    expect(micFailure(new DOMException("", name))).toBe(expected);
  });

  it("reads any other failure, such as a missing worklet URL, as mic", () => {
    expect(micFailure(new Error("workletUrl is required for voice"))).toBe("mic");
    expect(micFailure("nope")).toBe("mic");
    expect(micFailure(null)).toBe("mic");
  });
});
