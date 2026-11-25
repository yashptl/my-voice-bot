import type { Env } from "./env";

/** Demo mode (scripted replies, silent speech) is on only by explicit choice: ASSISTANT_DEMO is "1". */
export function demoMode(env: Env): boolean {
  return env.ASSISTANT_DEMO === "1";
}

const set = (value: string | undefined) => (value?.trim() ?? "") !== "";

/**
 * The names (never the values) of config that is missing. Required: without it the assistant cannot
 * serve visitors; MINIMAX_API_KEY only when not in demo mode. Optional: without it something
 * operational is off (alert emails).
 */
export function missingConfig(env: Env): { required: string[]; optional: string[] } {
  const required = [
    ["TURNSTILE_SECRET", set(env.TURNSTILE_SECRET)],
    ["IP_HASH_KEY", set(env.IP_HASH_KEY)],
    ["MINIMAX_API_KEY", set(env.MINIMAX_API_KEY) || demoMode(env)],
  ] as const;
  return {
    required: required.filter(([, ok]) => !ok).map(([name]) => name),
    optional: set(env.ALERT_TO) ? [] : ["ALERT_TO"],
  };
}
