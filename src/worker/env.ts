import type { Conversation } from "./conversation";

/** Bindings and vars from wrangler.jsonc; secrets come from .dev.vars locally and Worker secrets in prod. */
export interface Env {
  AI: Ai;
  ASSETS: Fetcher;
  /** Typed so `stub.init(...)` is checked RPC. */
  CONVERSATION: DurableObjectNamespace<Conversation>;
  /** The day's ceilings (ledger.ts) and the turn log (turn-log.ts); schema in migrations/. */
  DB: D1Database;
  RL_SESSION: RateLimit;
  ASSISTANT_MODE: "voice" | "text" | "off";
  LLM_PROFILE: string;
  TTS_VOICE: string;
  // The daily ceilings, per UTC day, as whole numbers (ledger.ts `ceiling`). Missing: the default in
  // ledger.ts. Set to anything but a whole number: 0, which pauses what it counts, and an error log.
  /** Model turns, all visitors together. */
  DAILY_TURNS?: string;
  /** Mic seconds sent to Flux, all visitors together. Voice rests (text carries on) past it. */
  DAILY_VOICE_SECONDS?: string;
  /** Characters sent to MiniMax speech, all visitors together. Voice rests past it. */
  DAILY_TTS_CHARS?: string;
  /** Model turns per visitor (client IP), text and voice together. */
  DAILY_TURNS_PER_IP?: string;
  MINIMAX_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  /** Without it `/assistant/session` refuses every visitor (503), rather than skipping the check. */
  TURNSTILE_SECRET?: string;
  /**
   * The HMAC key for per-visitor daily counts (visitor.ts), so D1 never holds a raw IP. Without it
   * `/assistant/session` refuses every visitor (503) and every model turn fails closed.
   */
  IP_HASH_KEY?: string;
}
