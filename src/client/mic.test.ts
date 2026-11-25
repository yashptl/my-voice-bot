import { afterEach, describe, expect, it, vi } from "vitest";
import { startMic } from "./mic";

const WORKLET_URL = "/assets/capture-worklet.js";

afterEach(() => vi.unstubAllGlobals());

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
});
