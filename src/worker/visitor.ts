/** The visitor's IP as Cloudflare reports it; "unknown" without it (the canary's internal requests). */
export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

/**
 * The key of a visitor's daily count: HMAC-SHA256 of `<day>|<ip>` under `secret` (IP_HASH_KEY), as
 * hex. D1 never holds the IP itself, and the day in the message means one day's keys cannot be
 * matched to another's.
 */
export async function visitorKey(secret: string, day: string, ip: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${day}|${ip}`)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}
