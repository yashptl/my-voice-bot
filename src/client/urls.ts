/** Where the assistant's routes live unless the host page says otherwise. */
export const DEFAULT_BASE_URL = "/assistant";

/**
 * The session and voice endpoints under `baseUrl` (absolute, or relative to `pageUrl`), which names
 * the folder the routes live in: "/assistant" and "https://host/assistant/" both give
 * ".../assistant/session" and ".../assistant/voice". The voice URL uses ws: or wss: to match.
 */
export function assistantUrls(baseUrl: string, pageUrl: string): { session: URL; voice: URL } {
  const base = new URL(baseUrl, pageUrl);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const session = new URL("session", base);
  const voice = new URL("voice", base);
  voice.protocol = voice.protocol === "https:" ? "wss:" : "ws:";
  return { session, voice };
}
