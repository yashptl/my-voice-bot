import { afterEach, describe, expect, it, vi } from "vitest";
import { SITEVERIFY_URL, verifyTurnstile } from "./turnstile";

const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const SECRET = "1x0000000000000000000000000000000AA"; // Cloudflare's published always-pass test secret

/** A fake fetch that answers with `reply` and records each request. */
function fakeFetch(reply: (req: Request) => Promise<Response>) {
  const requests: Request[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    requests.push(req);
    return reply(req);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("verifyTurnstile", () => {
  it("accepts a token siteverify says is valid", async () => {
    const f = fakeFetch(async () => Response.json({ success: true, "error-codes": [], hostname: "localhost" }));
    expect(await verifyTurnstile({ token: TOKEN, secret: SECRET, ip: "203.0.113.7", fetch: f.fetch })).toEqual({
      ok: true,
      codes: [],
    });
  });

  it("form-POSTs the secret, the token and the visitor's IP to siteverify", async () => {
    const f = fakeFetch(async () => Response.json({ success: true }));
    await verifyTurnstile({ token: TOKEN, secret: SECRET, ip: "203.0.113.7", fetch: f.fetch });
    const [req] = f.requests;
    expect(req?.url).toBe(SITEVERIFY_URL);
    expect(SITEVERIFY_URL).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(req?.method).toBe("POST");
    expect(req?.headers.get("content-type")).toMatch(/^application\/x-www-form-urlencoded/);
    const form = new URLSearchParams(await req?.text());
    expect(Object.fromEntries(form)).toEqual({ secret: SECRET, response: TOKEN, remoteip: "203.0.113.7" });
  });

  it("leaves remoteip out when the IP is unknown", async () => {
    const f = fakeFetch(async () => Response.json({ success: true }));
    await verifyTurnstile({ token: TOKEN, secret: SECRET, ip: null, fetch: f.fetch });
    expect(new URLSearchParams(await f.requests[0]?.text()).has("remoteip")).toBe(false);
  });

  it("refuses a token siteverify rejects, with its error codes", async () => {
    const f = fakeFetch(async () => Response.json({ success: false, "error-codes": ["timeout-or-duplicate"] }));
    expect(await verifyTurnstile({ token: TOKEN, secret: SECRET, ip: null, fetch: f.fetch })).toEqual({
      ok: false,
      codes: ["timeout-or-duplicate"],
    });
  });

  it("fails closed on a network error", async () => {
    const f = fakeFetch(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await verifyTurnstile({ token: TOKEN, secret: SECRET, ip: null, fetch: f.fetch })).toEqual({
      ok: false,
      codes: ["network-error"],
    });
  });

  it("fails closed on an HTTP error or a reply that is not JSON", async () => {
    const http = fakeFetch(async () => new Response("oops", { status: 500 }));
    expect(await verifyTurnstile({ token: TOKEN, secret: SECRET, ip: null, fetch: http.fetch })).toEqual({
      ok: false,
      codes: ["http-500"],
    });
    const html = fakeFetch(async () => new Response("<html>", { status: 200 }));
    expect((await verifyTurnstile({ token: TOKEN, secret: SECRET, ip: null, fetch: html.fetch })).ok).toBe(false);
    const odd = fakeFetch(async () => Response.json({ success: "yes" }));
    expect((await verifyTurnstile({ token: TOKEN, secret: SECRET, ip: null, fetch: odd.fetch })).ok).toBe(false);
  });

  it("fails closed after 5 s without a reply, aborting the request", async () => {
    vi.useFakeTimers();
    const f = fakeFetch(
      (req) =>
        new Promise<Response>((_resolve, reject) => {
          req.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const result = verifyTurnstile({ token: TOKEN, secret: SECRET, ip: null, fetch: f.fetch });
    await vi.advanceTimersByTimeAsync(4_900);
    expect(f.requests[0]?.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(await result).toEqual({ ok: false, codes: ["timeout"] });
    expect(f.requests[0]?.signal.aborted).toBe(true);
  });
});
