import { WS_SUBPROTOCOL } from "../protocol/version";

/**
 * Conversation tokens: `<conversation uuid>.<secret>`, where the secret is 32 random bytes in
 * base64url (43 characters). The Worker hands the token to the browser once; the Conversation
 * Durable Object keeps only the secret's SHA-256, so storage never holds a usable token. Every
 * character is legal in a WebSocket subprotocol, which is how the browser presents it.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TOKEN = new RegExp(`^(${UUID})\\.([A-Za-z0-9_-]{43})$`);
const HEX_SHA256 = /^[0-9a-f]{64}$/;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** SHA-256 of the UTF-8 text, as 64 lowercase hex characters. */
export async function sha256Hex(text: string): Promise<string> {
  return Array.from(await sha256(text), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function mintToken(): { token: string; conversationId: string; secretHash: Promise<string> } {
  const conversationId = crypto.randomUUID();
  const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  return { token: `${conversationId}.${secret}`, conversationId, secretHash: sha256Hex(secret) };
}

export function parseToken(t: string): { conversationId: string; secret: string } | null {
  const m = TOKEN.exec(t);
  return m?.[1] && m[2] ? { conversationId: m[1], secret: m[2] } : null;
}

/** The token from a `Sec-WebSocket-Protocol` header of exactly `assistant.v1, <token>`. */
export function tokenFromProtocols(header: string | null): string | null {
  const parts = (header ?? "").split(",").map((p) => p.trim());
  if (parts.length !== 2 || parts[0] !== WS_SUBPROTOCOL || !parts[1]) return null;
  return parts[1];
}

/** Constant-time for equal lengths; the lengths here are always 32 bytes. */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean };
  if (a.byteLength !== b.byteLength) return false;
  if (typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(a, b);
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** True when `secret` hashes to `hash` (a stored `sha256Hex`). */
export async function verifySecret(secret: string, hash: string): Promise<boolean> {
  if (!HEX_SHA256.test(hash)) return false;
  return equalBytes(await sha256(secret), hexToBytes(hash));
}
