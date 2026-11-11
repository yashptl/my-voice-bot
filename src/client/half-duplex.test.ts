import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HalfDuplex, type MicState } from "./half-duplex";

describe("HalfDuplex", () => {
  let changes: MicState[];
  let gate: HalfDuplex;

  beforeEach(() => {
    vi.useFakeTimers();
    changes = [];
    gate = new HalfDuplex((s) => changes.push(s));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Talk, then a full reply: the server thinks and speaks, audio plays, both finish. */
  function talkAndReply(): void {
    gate.talk();
    gate.setServerBusy(true);
    gate.setPlaying(true);
    gate.setServerBusy(false);
    gate.setPlaying(false);
  }

  it("starts off", () => {
    expect(gate.state).toBe("off");
  });

  it("goes live on talk()", () => {
    gate.talk();
    expect(gate.state).toBe("live");
    expect(changes).toEqual(["live"]);
  });

  it("reports a state only when it changes", () => {
    gate.talk();
    gate.talk();
    expect(changes).toEqual(["live"]);
  });

  it("mutes while a reply plays", () => {
    gate.talk();
    gate.setPlaying(true);
    expect(gate.state).toBe("muted");
  });

  it("stays muted when playback runs dry while the server is still replying", () => {
    gate.talk();
    gate.setServerBusy(true);
    gate.setPlaying(true);
    gate.setPlaying(false);
    vi.advanceTimersByTime(1000);
    expect(gate.state).toBe("muted");
  });

  it("unmutes 150 ms after the reply has finished playing", () => {
    talkAndReply();
    vi.advanceTimersByTime(149);
    expect(gate.state).toBe("muted");
    vi.advanceTimersByTime(1);
    expect(gate.state).toBe("live");
  });

  it("unmutes the same way when playback ends before the server goes back to listening", () => {
    gate.talk();
    gate.setServerBusy(true);
    gate.setPlaying(true);
    gate.setPlaying(false);
    gate.setServerBusy(false);
    vi.advanceTimersByTime(150);
    expect(gate.state).toBe("live");
  });

  it("turns off after an 8 s listening window", () => {
    talkAndReply();
    vi.advanceTimersByTime(150 + 7999);
    expect(gate.state).toBe("live");
    vi.advanceTimersByTime(1);
    expect(gate.state).toBe("off");
    expect(changes).toEqual(["live", "muted", "live", "off"]);
  });

  it("keeps listening once the visitor starts speaking in the window", () => {
    talkAndReply();
    vi.advanceTimersByTime(150 + 4000);
    gate.heardSpeech();
    vi.advanceTimersByTime(60_000);
    expect(gate.state).toBe("live");
  });

  it("still unmutes when speech is reported during the mute tail", () => {
    talkAndReply();
    vi.advanceTimersByTime(100);
    gate.heardSpeech();
    vi.advanceTimersByTime(50);
    expect(gate.state).toBe("live");
  });

  it("opens the listening window after a reply that played no audio", () => {
    gate.talk();
    gate.setServerBusy(true);
    gate.setServerBusy(false);
    vi.advanceTimersByTime(150 + 8000);
    expect(gate.state).toBe("off");
  });

  it("cancels the window when the next reply starts", () => {
    talkAndReply();
    vi.advanceTimersByTime(150 + 4000);
    gate.setServerBusy(true);
    vi.advanceTimersByTime(60_000);
    expect(gate.state).toBe("live");
  });

  it("cancels the window on talk()", () => {
    talkAndReply();
    vi.advanceTimersByTime(150 + 4000);
    gate.talk();
    vi.advanceTimersByTime(60_000);
    expect(gate.state).toBe("live");
  });

  it("stop() turns the mic off and cancels pending timers", () => {
    talkAndReply();
    gate.stop();
    expect(gate.state).toBe("off");
    vi.advanceTimersByTime(60_000);
    expect(changes).toEqual(["live", "muted", "off"]);
  });

  it("does not turn on for playback while off", () => {
    gate.setPlaying(true);
    gate.setPlaying(false);
    vi.advanceTimersByTime(60_000);
    expect(gate.state).toBe("off");
    expect(changes).toEqual([]);
  });
});
