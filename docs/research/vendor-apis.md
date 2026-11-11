# Vendor API reference (checked 2026-11-07)

Facts the code depends on, from official docs. **UNVERIFIED** marks what Phase 0 must confirm.

## Package versions (npm, 2026-11-07)

`@cloudflare/vite-plugin` 1.67.0 (stay on v1; v2 beta can't be deployed by Wrangler) · `wrangler` 4.158.0 · `@cloudflare/workers-types` 5.20261107.1 · `vite` 8.3.6 · `@vitejs/plugin-react` 6.2.1 · `@anthropic-ai/sdk` 1.6.0.

## Deepgram Flux on Workers AI

- Model `@cf/deepgram/flux`, WebSocket only, English only. No multilingual Flux on Workers AI: Hindi needs Deepgram directly (`flux-general-multi`, 10 languages, `language_hint`).
- Open from a Worker:
  ```ts
  const resp = (await env.AI.run("@cf/deepgram/flux",
    { encoding: "linear16", sample_rate: "16000", eot_threshold: "0.7", eager_eot_threshold: "0.5", eot_timeout_ms: "5000", keyterm: "Yash" },
    { websocket: true })) as unknown as Response;
  const flux = resp.webSocket; // missing → HTTP error (e.g. 429 AiError 3040); log status + body
  ```
- Inputs (all strings): `encoding` = `linear16` (required), `sample_rate` (required, 16000 recommended), `eot_threshold` 0.5–0.9 (default 0.7), `eager_eot_threshold` 0.3–0.9 (enables EagerEndOfTurn/TurnResumed), `eot_timeout_ms` (default 5000), `keyterm` (repeatable), `mip_opt_out` (`"true"`/`"false"`, default false), `tag`.
- Server frames: JSON with `event` ∈ `Update | StartOfTurn | EagerEndOfTurn | TurnResumed | EndOfTurn`, `turn_index`, `transcript` (whole turn so far), `words[] {word, confidence}`, `end_of_turn_confidence`, `audio_window_start/end`, `request_id`, `sequence_id`. Cloudflare's schema has no `type`; detect turn frames by `event` and tolerate other shapes (Connected/Warning/Error may appear).
- Guarantees: `Update` every ~0.25 s; `StartOfTurn` and `EagerEndOfTurn` have non-empty transcripts; `EndOfTurn` transcript equals the preceding eager one; eager EOT adds 50–70% more LLM calls.
- Audio up: binary Int16LE frames, **80 ms chunks = 1280 samples = 2560 bytes** at 16 kHz.
- **UNVERIFIED:** whether `CloseStream` / `ForceEndTurn` / `Configure` pass through on Workers AI; the idle timeout (Deepgram v1 closes after ~10 s without audio — keep sending frames, zeroed while the assistant speaks).
- Price $0.0077 per **audio minute**. ASR limit 720 req/min. Zero data retention. AI bindings always run remotely and bill even in local dev (`"ai": {"binding": "AI", "remote": true}`).
- Alternative: browser direct to Deepgram with a token from `POST https://api.deepgram.com/v1/auth/grant` (`{ttl_seconds}`; 30 s default) and subprotocol `["bearer", jwt]`.

## MiniMax text (Anthropic-compatible)

- `POST https://api.minimax.io/anthropic/v1/messages`, `Authorization: Bearer <key>` (or `x-api-key`). Send `anthropic-version: 2023-06-01` to be safe (UNVERIFIED whether required).
- Models: `MiniMax-M3.1-Flash` (thinking **always on**; disabling returns 400 code 2013; `output_config.effort` low|medium|high|xhigh|max, **default max**) and `MiniMax-M3` (thinking **off by default**; enable with `thinking: {type: "adaptive"}`). Context 1M.
- Thinking tokens count toward `max_tokens`; too small gives `stop_reason: "max_tokens"` with no text.
- Ignored: `temperature` (fixed 1), `top_p`, `top_k`, **`stop_sequences`**. `tool_choice` only `auto`. No response-format / JSON mode.
- SSE: `message_start`, `ping`, `content_block_start`, `content_block_delta` (`text_delta` | `thinking_delta` | `signature_delta`), `content_block_stop`, `message_delta` (`stop_reason`, `usage`), `message_stop`, `error` (`{type:"error", error:{type, message}}`). Thinking block streams first (index 0).
- **Caching is automatic prefix caching** for prompts ≥512 tokens (order: tools, system, messages). `cache_control` is **not supported** on M3/M3.1-Flash. **TTL undocumented — measure.** Usage: `input_tokens` (uncached), `cache_read_input_tokens`, `cache_creation_input_tokens` (0).
- Prices per 1M tokens: Flash $0.15 in / $0.60 out / $0.015 cache read. M3 (≤512k input) $0.30 / $1.20 / $0.06.
- Rate limit 200 RPM, 10M TPM.

## MiniMax Speech (bidirectional WebSocket)

- `wss://api.minimax.io/ws/v1/t2a_v2_bidi` (US West: `api-uw.minimax.io`). Auth header `Authorization: Bearer <key>` on the upgrade (from a Worker: `fetch(httpsUrl, {headers: {Upgrade: "websocket", Authorization}})`, then `resp.webSocket.accept()`; UNVERIFIED that MiniMax accepts this from Workers).
- Flow: server `connected_success` → client `task_start` {`model: "speech-2.8-turbo"`, `voice_setting: {voice_id, speed, vol, pitch, emotion?}`, `audio_setting: {sample_rate: 24000, format: "pcm", channel: 1}`, `pronunciation_dict: {tone: ["word/pronunciation"]}`, `language_boost: "English"`, `subtitle_enable`} → server `task_started` → client `task_continue {text}` (any granularity; server splits on `.!?…` and newline) and `task_flush` (synthesize buffered text now) → server per sentence: `sentence_start`, `task_continued {data: {audio: "<hex>"}, is_final}`, `sentence_end` (no index or text — count them) → `task_cancel` → `task_canceled` (discard and abort, session continues) → `task_finish` → `task_finished`, close.
- Errors: `task_failed` with `base_resp.status_code` (1002 rate limit, 1004 auth, 2013 bad params, 2201 idle timeout, 2205 too much queued — resend, 2206 duplicate task_start).
- Idle close ~120 s; the server sends no pings and Workers can't send pings → **one socket per reply**.
- PCM bit depth/endianness **UNVERIFIED** (likely 16-bit LE mono).
- speech-2.8-turbo $60 / 1M characters (HD $100). T2A limit 60 RPM (UNVERIFIED whether per session or per message).
- English stock voices include `English_expressive_narrator`, `English_CalmWoman`, `English_FriendlyPerson`, `English_Steadymentor`, `English_ConfidentWoman`, `English_PatientMan`, `English_Insightful_Speaker`, `English_Graceful_Lady`, `English_Trustworth_Man`.

## Cloudflare platform

- Vite: `plugins: [react(), cloudflare()]`; `vite build` emits `wrangler.json` used by `vite preview` and `wrangler deploy`. Vite dev forwards WebSocket upgrades to the Worker.
- `wrangler.jsonc`: `compatibility_flags: ["enable_request_signal"]` (default only from 2026-11-17); `assets.run_worker_first: ["/assistant", "/assistant/*"]`; `ai` (one binding per Worker); `d1_databases`; `ratelimits: [{name, namespace_id: "<own int>", simple: {limit, period: 10|60}}]` (approximate, per location, local only in dev); `durable_objects.bindings` + `migrations` with `new_sqlite_classes`.
- With compat date ≥ 2026-03-17, **WebSocket `binaryType` defaults to `"blob"`**: set `ws.binaryType = "arraybuffer"` before `accept()`. Close frames auto-reply (≥ 2026-04-07).
- `Request.signal` aborts when the client disconnects; pass it to `fetch()` yourself.
- Limits: no wall-clock limit while connected; CPU 30 s default (`limits.cpu_ms` up to 300000); deploys give existing connections up to 20 min, so clients must reconnect.
- Turnstile: `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` `{secret, response, remoteip?}` → `{success, hostname, "error-codes", action, cdata}`. Tokens single-use, valid 300 s. Test site keys `1x00000000000000000000AA` (pass, visible), `1x00000000000000000000BB` (pass, invisible); test secret `1x0000000000000000000000000000000AA` (pass) accepts only `XXXX.DUMMY.TOKEN.XXXX`.
- AI Gateway: MiniMax only as a custom provider; exact-match caching only. Not used in v1.

## Browser audio

- `echoCancellation: "all"` only in Chrome/Edge 141+; pass `"all"` on Chromium, `true` elsewhere.
- Robust capture: native-rate `AudioContext` created/resumed in the tap handler → `AudioWorkletProcessor` low-pass + decimate to 16 kHz → Int16 (`s < 0 ? s * 0x8000 : s * 0x7fff`) → 1280-sample frames → `port.postMessage(buf, [buf])` → binary WebSocket frame. AudioWorklet: Chrome 66, Firefox 76, Safari 14.1.

Raw copies of the docs: the session scratchpad `docs/` folder (not committed).
