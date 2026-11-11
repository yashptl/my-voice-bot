/**
 * Cloudflare's published always-pass invisible test site key. Its token is `XXXX.DUMMY.TOKEN.XXXX`,
 * which only the matching test secret accepts, so it is safe in a public repo and fine for local dev
 * and staging. Production passes the real site key instead.
 */
export const TEST_SITE_KEY = "1x00000000000000000000BB";

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const TOKEN_TIMEOUT_MS = 15_000;

/** The part of Cloudflare's `window.turnstile` this file uses. */
interface TurnstileApi {
  render(
    container: HTMLElement,
    params: {
      sitekey: string;
      callback(token: string): void;
      "error-callback"(code: string): void;
      retry: "never";
    },
  ): string | null | undefined;
  remove(widgetId: string): void;
}

let loading: Promise<TurnstileApi> | null = null;

/** Adds Cloudflare's script once; a failed load is forgotten so the next call tries again. */
function loadTurnstile(): Promise<TurnstileApi> {
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      const api = (window as { turnstile?: TurnstileApi }).turnstile;
      if (api) resolve(api);
      else reject(new Error("Turnstile loaded without its API"));
    };
    script.onerror = () => reject(new Error("could not load Turnstile"));
    document.head.append(script);
  }).catch((err: unknown) => {
    loading = null;
    throw err;
  });
  return loading;
}

/**
 * One fresh Turnstile token (they are single use). Renders an invisible widget off screen, waits for
 * its token, then removes it. Browser only. Meant for invisible site keys: a key that may ask the
 * visitor to click would have nowhere visible to do it.
 */
export async function getTurnstileToken(siteKey: string): Promise<string> {
  const api = await loadTurnstile();
  const container = document.createElement("div");
  container.setAttribute("aria-hidden", "true");
  // Off screen rather than display: none, so the widget's frame always runs.
  container.style.cssText = "position:fixed;left:-10000px;top:0;width:300px;height:65px;overflow:hidden";
  document.body.append(container);

  let widgetId: string | null | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Turnstile timed out")), TOKEN_TIMEOUT_MS);
      widgetId = api.render(container, {
        sitekey: siteKey,
        callback: resolve,
        "error-callback": (code) => reject(new Error(`Turnstile failed (${code})`)),
        retry: "never",
      });
    });
  } finally {
    clearTimeout(timer);
    if (widgetId) api.remove(widgetId);
    container.remove();
  }
}
