import { describe, expect, it } from "vitest";
import { SPEECH_OUTPUT_FAILED, VOICE_CLOSE } from "./voice";

// Clients already deployed match these strings, so they are part of the wire.
describe("voice wire strings", () => {
  it("keeps the speech failure message", () => {
    expect(SPEECH_OUTPUT_FAILED).toBe("Speech output failed; the answer continues as text.");
  });

  it("keeps the close reasons", () => {
    expect(VOICE_CLOSE).toEqual({
      idle: "idle",
      turnLimit: "turn limit",
      audioLimit: "audio limit",
      speechRecognitionFailed: "speech recognition failed",
    });
  });
});
