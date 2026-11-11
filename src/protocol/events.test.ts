import { describe, expect, it } from "vitest";
import { parseClientMessage } from "./events";

describe("parseClientMessage", () => {
  it.each([
    [{ type: "interrupt", turnId: "t1", lastHeardSentenceId: 0 }],
    [{ type: "interrupt", turnId: "t1", lastHeardSentenceId: null }],
    [{ type: "mark", turnId: "t1", mark: "clientFirstAudioPlayed", at: 1234.5 }],
  ])("accepts %j", (message) => {
    expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
  });

  it.each([
    ["not json"],
    ['{"type":"hello"}'],
    ['{"type":"interrupt","lastHeardSentenceId":0}'],
    ['{"type":"interrupt","turnId":"t1","lastHeardSentenceId":-1}'],
    ['{"type":"interrupt","turnId":"t1","lastHeardSentenceId":0.5}'],
    ['{"type":"mark","turnId":"t1","mark":"done","at":1}'],
    [`{"type":"mark","turnId":"${"t".repeat(129)}","mark":"clientTurnEnd","at":1}`],
  ])("rejects %s", (raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });
});
