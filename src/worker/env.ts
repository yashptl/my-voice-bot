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
  /** "1" serves scripted demo replies and silent speech when MINIMAX_API_KEY is missing (config.ts). Never set in production. */
  ASSISTANT_DEMO?: string;
  MINIMAX_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  /** Without it `/assistant/session` refuses every visitor (503), rather than skipping the check. */
  TURNSTILE_SECRET?: string;
  /**
   * The HMAC key for per-visitor daily counts (visitor.ts), so D1 never holds a raw IP. Without it
   * `/assistant/session` refuses every visitor (503) and every model turn fails closed.
   */
  IP_HASH_KEY?: string;
  /** Where alert emails go: the owner's verified Email Routing destination. A secret, never in the repo. Without it, alerts are logged only. */
  ALERT_TO?: string;
  /** The alert sender, on an onboarded Email Service domain. */
  ALERT_FROM?: string;
  /** `send_email` binding without a destination restriction. Without it, alerts are logged only. */
  ALERT_EMAIL?: SendEmail;
}
