import { afterEach, describe, expect, it, vi } from "vitest";
import { mintToken, parseToken, sha256Hex, tokenFromProtocols, verifySecret } from "./auth";

describe("mintToken / parseToken", () => {
  it("mints a token that parses back to the same conversation id", async () => {
    const minted = mintToken();
    const parsed = parseToken(minted.token);
    expect(parsed?.conversationId).toBe(minted.conversationId);
    expect(minted.token).toBe(`${minted.conversationId}.${parsed?.secret}`);
    expect(await minted.secretHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses a UUID conversation id and a 43-character base64url secret", () => {
    const { token, conversationId } = mintToken();
    expect(conversationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(parseToken(token)?.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("mints a different conversation and secret every time", () => {
    const a = parseToken(mintToken().token);
    const b = parseToken(mintToken().token);
    expect(a?.conversationId).not.toBe(b?.conversationId);
    expect(a?.secret).not.toBe(b?.secret);
  });

  it("hashes the secret, never stores it", async () => {
    const { token, secretHash } = mintToken();
    const secret = parseToken(token)?.secret ?? "";
    expect(await secretHash).toBe(await sha256Hex(secret));
    expect(await secretHash).not.toContain(secret);
  });

  it.each([
    "x",
    "",
    "abc.def",
    // Right shape, wrong parts.
    "not-a-uuid.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "0b6f5a51-3c8e-4f0e-9d7b-6b1c2a9e8f10.short",
    "0b6f5a51-3c8e-4f0e-9d7b-6b1c2a9e8f10.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+",
    "0b6f5a51-3c8e-4f0e-9d7b-6b1c2a9e8f10.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.extra",
    " 0b6f5a51-3c8e-4f0e-9d7b-6b1c2a9e8f10.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  ])("rejects %j", (t) => {
    expect(parseToken(t)).toBeNull();
  });
});

describe("tokenFromProtocols", () => {
  it("reads the token offered after assistant.v1", () => {
    expect(tokenFromProtocols("assistant.v1, abc.def")).toBe("abc.def");
    expect(tokenFromProtocols("assistant.v1,abc.def")).toBe("abc.def");
  });

  it.each([null, "", "other, abc", "assistant.v1", "assistant.v1, ", "abc, assistant.v1", "assistant.v1, a, b"])(
    "returns null for %j",
    (header) => {
      expect(tokenFromProtocols(header)).toBeNull();
    },
  );
});

describe("verifySecret", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts the right secret and rejects a one-character change", async () => {
    const { token, secretHash } = mintToken();
    const secret = parseToken(token)?.secret ?? "";
    const hash = await secretHash;
    const flipped = (secret[0] === "A" ? "B" : "A") + secret.slice(1);
    expect(await verifySecret(secret, hash)).toBe(true);
    expect(await verifySecret(flipped, hash)).toBe(false);
  });

  it("rejects a malformed or empty stored hash", async () => {
    expect(await verifySecret("secret", "")).toBe(false);
    expect(await verifySecret("secret", "zz")).toBe(false);
  });

  it("uses crypto.subtle.timingSafeEqual when the platform has it (Workers)", async () => {
    const calls: number[] = [];
    const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: unknown };
    Object.defineProperty(subtle, "timingSafeEqual", {
      configurable: true,
      value: (a: Uint8Array, b: Uint8Array) => {
        calls.push(a.byteLength, b.byteLength);
        return a.every((x, i) => x === b[i]);
      },
    });
    try {
      const hash = await sha256Hex("s3cret");
      expect(await verifySecret("s3cret", hash)).toBe(true);
      expect(await verifySecret("s3cres", hash)).toBe(false);
      expect(calls).toEqual([32, 32, 32, 32]);
    } finally {
      delete (subtle as { timingSafeEqual?: unknown }).timingSafeEqual;
    }
  });
});
