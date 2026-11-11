import { describe, expect, it } from "vitest";
import { assistantUrls, DEFAULT_BASE_URL } from "./urls";

const PAGE = "https://yashos.dev/apps/assistant?x=1";

describe("assistantUrls", () => {
  it("resolves session and voice under the default base, /assistant", () => {
    const { session, voice } = assistantUrls(DEFAULT_BASE_URL, PAGE);
    expect(session.href).toBe("https://yashos.dev/assistant/session");
    expect(voice.href).toBe("wss://yashos.dev/assistant/voice");
  });

  it.each([
    ["https://yashos.dev/assistant", "https://yashos.dev/assistant/session"],
    ["https://yashos.dev/assistant/", "https://yashos.dev/assistant/session"],
    ["/staging/assistant", "https://yashos.dev/staging/assistant/session"],
    ["https://api.example.test/v2/assistant", "https://api.example.test/v2/assistant/session"],
  ])("keeps the base's path: %s", (base, expected) => {
    expect(assistantUrls(base, PAGE).session.href).toBe(expected);
  });

  it("uses ws: for an http base", () => {
    expect(assistantUrls("http://localhost:5199/assistant", PAGE).voice.href).toBe("ws://localhost:5199/assistant/voice");
  });
});
