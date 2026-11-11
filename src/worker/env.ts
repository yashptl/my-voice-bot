import type { Conversation } from "./conversation";

/** Bindings and vars from wrangler.jsonc; secrets come from .dev.vars locally and Worker secrets in prod. */
export interface Env {
  AI: Ai;
  ASSETS: Fetcher;
  /** Typed so `stub.init(...)` is checked RPC. */
  CONVERSATION: DurableObjectNamespace<Conversation>;
  /** The day's shared ceilings (ledger.ts) and the turn log (turn-log.ts); schema in migrations/. */
  DB: D1Database;
  RL_SESSION: RateLimit;
  ASSISTANT_MODE: "voice" | "text" | "off";
  LLM_PROFILE: string;
  TTS_VOICE: string;
  /** Model turns per UTC day, all visitors together (see `dailyTurns`). */
  DAILY_TURNS: string;
  MINIMAX_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  /** Without it `/assistant/session` refuses every visitor (503), rather than skipping the check. */
  TURNSTILE_SECRET?: string;
}
