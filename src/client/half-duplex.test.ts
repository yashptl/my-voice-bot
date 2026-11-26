import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HalfDuplex, type MicState } from "./half-duplex";

describe("HalfDuplex", () => {
  let changes: MicState[];
  let followUps: boolean[];
  let gate: HalfDuplex;

  beforeEach(() => {
    vi.useFakeTimers();
    changes = [];
    followUps = [];
    gate = new HalfDuplex(
      (s) => changes.push(s),
      (open) => followUps.push(open),
    );
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

  describe("followUp", () => {
    it("is open while the mic is live in the listening window after a reply", () => {
      expect(gate.followUp).toBe(false);
      talkAndReply();
      vi.advanceTimersByTime(149);
      expect(gate.followUp).toBe(false);
      vi.advanceTimersByTime(1);
      expect(gate.followUp).toBe(true);
      expect(followUps).toEqual([true]);
      vi.advanceTimersByTime(8000);
      expect(gate.state).toBe("off");
      expect(gate.followUp).toBe(false);
      expect(followUps).toEqual([true, false]);
    });

    it("is never open while the mic is live after talk()", () => {
      gate.talk();
      vi.advanceTimersByTime(60_000);
      expect(gate.followUp).toBe(false);
      expect(followUps).toEqual([]);
    });

    it.each([
      ["speech is heard", () => gate.heardSpeech()],
      ["the visitor talks", () => gate.talk()],
      ["the next reply starts", () => gate.setServerBusy(true)],
      ["reply audio arrives", () => gate.setPlaying(true)],
      ["the mic stops", () => gate.stop()],
      ["the visitor pauses", () => gate.pause()],
    ])("closes when %s", (_, act) => {
      talkAndReply();
      vi.advanceTimersByTime(150);
      act();
      expect(gate.followUp).toBe(false);
      expect(followUps).toEqual([true, false]);
    });

    it("keeps the mic state changes as before", () => {
      talkAndReply();
      vi.advanceTimersByTime(150 + 4000);
      gate.heardSpeech();
      expect(changes).toEqual(["live", "muted", "live"]);
    });
  });

  describe("pause", () => {
    it("mutes the mic, so frames keep flowing zeroed, until a turn starts, then turns it off", () => {
      gate.talk();
      gate.pause();
      expect(gate.state).toBe("muted");
      vi.advanceTimersByTime(5000);
      gate.turnStarted();
      expect(gate.state).toBe("off");
      expect(changes).toEqual(["live", "muted", "off"]);
    });

    it("turns the mic off after 6 s when no turn starts (nothing was said)", () => {
      gate.talk();
      gate.pause();
      vi.advanceTimersByTime(5999);
      expect(gate.state).toBe("muted");
      vi.advanceTimersByTime(1);
      expect(gate.state).toBe("off");
    });

    it("opens no listening window after the answer to a paused turn", () => {
      gate.talk();
      gate.pause();
      gate.turnStarted();
      gate.setServerBusy(true);
      gate.setPlaying(true);
      gate.setServerBusy(false);
      gate.setPlaying(false);
      vi.advanceTimersByTime(60_000);
      expect(gate.state).toBe("off");
      expect(changes).toEqual(["live", "muted", "off"]);
      expect(followUps).toEqual([]);
    });

    it("opens no listening window when the turn had already started before the pause", () => {
      gate.talk();
      gate.turnStarted();
      gate.setServerBusy(true);
      gate.setPlaying(true);
      gate.pause();
      gate.setServerBusy(false);
      gate.setPlaying(false);
      vi.advanceTimersByTime(60_000);
      expect(gate.state).toBe("off");
      expect(followUps).toEqual([]);
    });

    it("does nothing while the mic is off", () => {
      gate.pause();
      vi.advanceTimersByTime(60_000);
      expect(gate.state).toBe("off");
      expect(changes).toEqual([]);
    });

    it("ends on talk(): live again, and the next answer opens the window as usual", () => {
      gate.talk();
      gate.pause();
      talkAndReply();
      vi.advanceTimersByTime(150);
      expect(gate.state).toBe("live");
      expect(gate.followUp).toBe(true);
    });

    it("leaves a turn that starts without a pause alone", () => {
      gate.talk();
      gate.turnStarted();
      expect(gate.state).toBe("live");
    });
  });
});
