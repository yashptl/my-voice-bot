export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const TIMEOUT_MS = 5_000;

export interface TurnstileCheck {
  ok: boolean;
  /** Siteverify's `error-codes`, or ours: `timeout`, `network-error`, `http-<status>`, `bad-response`. */
  codes: string[];
}

/** The codes siteverify gives for a visitor's own token: missing, bad, or already used or expired. */
const VISITOR_CODES = new Set(["missing-input-response", "invalid-input-response", "timeout-or-duplicate"]);

/**
 * Whether a failed check says our side is broken (a wrong secret, siteverify down, a changed reply)
 * rather than the visitor's token. True for no codes, and for any code that is not the visitor's.
 */
export function turnstileBroken(codes: string[]): boolean {
  return codes.length === 0 || codes.some((c) => !VISITOR_CODES.has(c));
}

/**
 * Checks a Turnstile token with siteverify. Fails closed: a timeout, a network error or a reply that
 * is not a clear `success: true` is `ok: false`, so a visitor is never let in on an unverified token.
 */
export async function verifyTurnstile(o: {
  token: string;
  secret: string;
  /** The visitor's IP (`cf-connecting-ip`), when known; siteverify uses it as an extra signal. */
  ip: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<TurnstileCheck> {
  const doFetch = o.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const form = new URLSearchParams({ secret: o.secret, response: o.token });
  if (o.ip) form.set("remoteip", o.ip);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? TIMEOUT_MS);
  try {
    const res = await doFetch(SITEVERIFY_URL, { method: "POST", body: form, signal: controller.signal });
    if (!res.ok) return { ok: false, codes: [`http-${res.status}`] };
    const body = (await res.json()) as { success?: unknown; "error-codes"?: unknown };
    const codes = Array.isArray(body["error-codes"]) ? body["error-codes"].filter((c) => typeof c === "string") : [];
    return { ok: body.success === true, codes };
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, codes: ["timeout"] };
    return { ok: false, codes: [err instanceof SyntaxError ? "bad-response" : "network-error"] };
  } finally {
    clearTimeout(timer);
  }
}
