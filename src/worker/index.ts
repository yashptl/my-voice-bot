import { SessionRequestSchema, tokenFromAuthorization, type SessionResponse } from "../protocol/chat";
import { PROTOCOL_VERSION } from "../protocol/version";
import { mintToken, parseToken, tokenFromProtocols } from "./auth";
import { runCanary } from "./canary";
import { readJson } from "./conversation";
import type { Env } from "./env";
import { pruneDays, pruneVisitors, restingToday, voiceRestingToday } from "./ledger";
import { buildProviders } from "./providers";
import { pruneTurns } from "./turn-log";
import { verifyTurnstile } from "./turnstile";
import { clientIp } from "./visitor";

export { Conversation } from "./conversation";

const SESSION_TTL_MS = 30 * 60_000;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

const notAllowed = (allow: string) => json({ error: "method_not_allowed" }, 405, { allow });

const log = (level: "info" | "warn" | "error", line: string) => console[level](line);
const rateLimited = () => json({ error: "rate_limited" }, 429, { "retry-after": "60" });

/**
 * Mints a conversation and its token for a visitor who passed Turnstile. Rate limited per client
 * IP. Without a Turnstile secret or IP_HASH_KEY it refuses everyone rather than skipping a check.
 * `resting` tells the client the day's shared turns are already used (or the ledger cannot be read,
 * which fails closed), so it can show the static card. `mode` is "text" instead of "voice" while
 * voice rests for the day (its audio or speech ceiling), so the client starts in text.
 */
async function createSession(request: Request, env: Env): Promise<Response> {
  if (env.ASSISTANT_MODE === "off") return json({ mode: "off" }, 503);
  const { success } = await env.RL_SESSION.limit({ key: clientIp(request) });
  if (!success) return rateLimited();
  const body = await readJson(request, SessionRequestSchema);
  if (!body) return json({ error: "bad_request" }, 400);
  const secret = env.TURNSTILE_SECRET?.trim();
  if (!secret) return json({ error: "turnstile_not_configured" }, 503);
  if (!env.IP_HASH_KEY?.trim()) return json({ error: "not_configured" }, 503);
  const check = await verifyTurnstile({ token: body.turnstile, secret, ip: request.headers.get("cf-connecting-ip") });
  if (!check.ok) {
    console.warn(`turnstile refused: ${check.codes.join(", ") || "no codes"}`);
    return json({ error: "turnstile_failed" }, 403);
  }

  const { token, conversationId, secretHash } = mintToken();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const [, resting, voiceResting] = await Promise.all([
    secretHash.then((hash) => env.CONVERSATION.get(env.CONVERSATION.idFromName(conversationId)).init(hash, expiresAt)),
    restingToday(env, log),
    env.ASSISTANT_MODE === "voice" && voiceRestingToday(env, log),
  ]);
  const mode = voiceResting ? "text" : env.ASSISTANT_MODE;
  const session: SessionResponse = { token, protocol: PROTOCOL_VERSION, mode, expiresAt, resting };
  return json(session);
}

/**
 * Hands the upgrade to the conversation's Durable Object, which checks the secret. Any well-formed
 * token reaches an object (one per id, created on demand), so upgrades are rate limited per client
 * IP first. It reuses RL_SESSION's binding under its own `voice:` key: the same 10 a minute, counted
 * apart from /session, which is plenty for a visitor reconnecting.
 */
async function openVoice(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "upgrade_required" }, 426);
  if (env.ASSISTANT_MODE !== "voice") return json({ mode: env.ASSISTANT_MODE }, 503);
  const parsed = parseToken(tokenFromProtocols(request.headers.get("Sec-WebSocket-Protocol")) ?? "");
  if (!parsed) return json({ error: "unauthorized" }, 401);
  const { success } = await env.RL_SESSION.limit({ key: `voice:${clientIp(request)}` });
  if (!success) return rateLimited();
  return env.CONVERSATION.get(env.CONVERSATION.idFromName(parsed.conversationId)).fetch(request);
}

/**
 * Hands a text question to the conversation's Durable Object, which checks the secret, the body
 * and the limits and streams the answer. Rate limited per client IP first, under its own `chat:`
 * key, for the same reason as openVoice.
 */
async function chat(request: Request, env: Env): Promise<Response> {
  if (env.ASSISTANT_MODE === "off") return json({ mode: "off" }, 503);
  const parsed = parseToken(tokenFromAuthorization(request.headers.get("Authorization")) ?? "");
  if (!parsed) return json({ error: "auth" }, 401);
  const { success } = await env.RL_SESSION.limit({ key: `chat:${clientIp(request)}` });
  if (!success) return rateLimited();
  return env.CONVERSATION.get(env.CONVERSATION.idFromName(parsed.conversationId)).fetch(request);
}

/** Deletes what is past its retention; logs the counts, or why it failed. */
async function prune(db: D1Database, now: number): Promise<void> {
  try {
    const [turns, days, visitors] = await Promise.all([pruneTurns(db, now), pruneDays(db, now), pruneVisitors(db, now)]);
    console.info(`retention: deleted ${turns} turns, ${days} daily counts and ${visitors} visitor counts`);
  } catch (err) {
    console.error(`retention failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function health(env: Env): Response {
  const base = { protocol: PROTOCOL_VERSION, mode: env.ASSISTANT_MODE };
  try {
    return json({ ok: true, ...base, providers: buildProviders(env).label });
  } catch (err) {
    return json({ ok: false, ...base, error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    switch (pathname) {
      case "/assistant/session":
        return request.method === "POST" ? createSession(request, env) : notAllowed("POST");
      case "/assistant/chat":
        return request.method === "POST" ? chat(request, env) : notAllowed("POST");
      case "/assistant/voice":
        return request.method === "GET" ? openVoice(request, env) : notAllowed("GET");
      case "/assistant/health":
        return request.method === "GET" ? health(env) : notAllowed("GET");
    }
    if (pathname === "/assistant" || pathname.startsWith("/assistant/")) return json({ error: "not_found" }, 404);
    return env.ASSETS.fetch(request);
  },

  /**
   * Hourly (cron in wrangler.jsonc): the canary, which logs only its outcome, never answer text;
   * and retention, which deletes turn log rows after 30 days, daily counts after 7, and per-visitor
   * counts once their UTC day is over.
   */
  scheduled(_controller, env, ctx): void {
    ctx.waitUntil(
      runCanary(env).then((r) => {
        if (r.ok) console.info(`canary ok in ${r.ms} ms`);
        else console.error(`canary failed: ${r.reason}`);
      }),
    );
    ctx.waitUntil(prune(env.DB, Date.now()));
  },
} satisfies ExportedHandler<Env>;
