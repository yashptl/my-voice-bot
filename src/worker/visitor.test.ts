import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { clientIp, visitorKey } from "./visitor";

const IP = "203.0.113.7";

describe("clientIp", () => {
  it("is cf-connecting-ip, or unknown without it", () => {
    expect(clientIp(new Request("https://example.test/", { headers: { "cf-connecting-ip": IP } }))).toBe(IP);
    expect(clientIp(new Request("https://example.test/"))).toBe("unknown");
  });
});

describe("visitorKey", () => {
  it("is HMAC-SHA256 of `<day>|<ip>` under the secret, as hex", async () => {
    const expected = createHmac("sha256", "test-key").update(`2026-11-08|${IP}`).digest("hex");
    expect(await visitorKey("test-key", "2026-11-08", IP)).toBe(expected);
  });

  it("never holds the IP, and changes with the day, the IP and the secret", async () => {
    const key = await visitorKey("test-key", "2026-11-08", IP);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain(IP);
    const others = await Promise.all([
      visitorKey("test-key", "2026-11-09", IP),
      visitorKey("test-key", "2026-11-08", "203.0.113.8"),
      visitorKey("other-key", "2026-11-08", IP),
    ]);
    for (const other of others) expect(other).not.toBe(key);
  });

  it("with a unit, is a different key for the same day and IP, so one table holds both", async () => {
    const expected = createHmac("sha256", "test-key").update(`2026-11-08|${IP}|voice_seconds`).digest("hex");
    expect(await visitorKey("test-key", "2026-11-08", IP, "voice_seconds")).toBe(expected);
    expect(expected).not.toBe(await visitorKey("test-key", "2026-11-08", IP));
  });
});
