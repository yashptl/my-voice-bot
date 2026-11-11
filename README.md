# YashOS Assistant

A voice and text assistant that answers recruiters' questions about Yash's work, grounded only in Yash's published portfolio content. It runs as one Cloudflare Worker: a Durable Object per conversation streams speech-to-text (Deepgram Flux on Workers AI), the language model and text-to-speech (MiniMax) in a server-side turn loop, and a React playground exercises it locally. Vendors sit behind small ports with fakes, so the tests run without API keys, and a fresh clone runs in demo mode (below). The design is in the [assistant blueprint](docs/design/assistant-blueprint.html).

```sh
npm install
npm run dev     # applies the local D1 migrations, then the playground and Worker on the Vite dev server
npm run check   # typecheck, lint, tests, knowledge bundle check
```

Keys go in `.dev.vars` (see `.dev.vars.example`, which sets `ASSISTANT_DEMO=1` so a fresh clone runs without a MiniMax key).

Voice under `npm run dev` needs `npx wrangler login` first: speech-to-text (Flux) always runs on Workers AI, even locally, and bills $0.0077 per audio minute.

## Running the text assistant locally

1. `cp .dev.vars.example .dev.vars`. It carries Cloudflare's published Turnstile test secret
   (`TURNSTILE_SECRET=1x0000000000000000000000000000000AA`), which accepts only the test token
   `XXXX.DUMMY.TOKEN.XXXX`; the playground's test site key `1x00000000000000000000BB` produces that
   token. These are safe in a public repo; production uses a real secret set as a Worker secret.
   Without `TURNSTILE_SECRET`, `/assistant/session` refuses everyone with 503. Without
   `MINIMAX_API_KEY`, the answers are scripted only because the example sets `ASSISTANT_DEMO=1` (see Demo mode).
2. `npm run dev` and open the URL Vite prints. It first runs `npm run db:migrate:local`, which applies
   `migrations/` to the local D1 database in `playground/.wrangler/state` (where the Vite plugin keeps
   local state, since Vite's root is `playground/`); with new migrations it asks once to confirm.
   The **Text** tab comes first. Each finished answer has
   an **Under the hood** panel (the inspector): marks, tokens, estimated cost, the data line, what the
   output gate dropped or flagged, and the grounding check. `playground/README.md` has the details.
3. Or from a shell (the port is the one Vite prints):

   ```sh
   TOKEN=$(curl -s -X POST localhost:5173/assistant/session -H 'content-type: application/json' \
     -d '{"turnstile":"XXXX.DUMMY.TOKEN.XXXX"}' | jq -r .token)
   curl -N -X POST localhost:5173/assistant/chat -H "authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' -d '{"message":"Where does Yash work now?"}'
   ```

   The reply is a stream of server-sent events: `turn.start`, `sentence`…, `meta`, `turn.end`.

## Limits

All counts are per UTC day and live in D1. If D1 can't be reached, the assistant rests rather than answer uncounted. A ceiling var set to anything but a whole number counts as 0 (paused) and logs an error; `"0"` pauses on purpose.

| Limit | Value | When it is hit |
| --- | --- | --- |
| Session requests, per IP | 10 a minute (separate keys for `/session`, `/chat` and `/voice`) | 429 `rate_limited` |
| One answer at a time, per conversation | 1 | `/chat`: 409 `busy` |
| Questions per conversation, text and voice together | 30 | `/chat`: 429 `limit`; voice: `error` event `limit`, then the socket closes (1008) |
| Mic audio per conversation | 600 s | voice: `error` `limit`, socket closes |
| Model turns per visitor (client IP), text and voice | `DAILY_TURNS_PER_IP` = 60 | `/chat`: 429 `limit`; voice: `error` `limit`, socket closes |
| Model turns, everyone | `DAILY_TURNS` = 400 | `/session` reports `resting: true`; `/chat`: 503 `resting`; voice: `error` `resting`, socket closes |
| Mic seconds sent to Flux, everyone | `DAILY_VOICE_SECONDS` = 1800, reserved 15 s at a time | voice rests: `/session` returns `mode: "text"`; an open socket gets `error` `voice_resting` and closes; text carries on |
| Characters sent to MiniMax speech, everyone | `DAILY_TTS_CHARS` = 60000, reserved 500 (one reply) at a time | voice rests, as above |
| Mic seconds per visitor (client IP) | `DAILY_VOICE_SECONDS_PER_IP` = 600, reserved 15 s at a time with everyone's block | voice rests for that visitor, as for everyone's seconds, above |
| Spoken reply | 500 characters | sentences past it arrive with `spoken: false`: captions only, never spoken |

The visitor is the client IP, kept only as an HMAC of the day and IP under `IP_HASH_KEY`, so D1 never holds a raw IP. A turn is counted for the conversation first, then the visitor and everyone together at once; any refusal gives the others back. Each 15 s block of mic audio is reserved from everyone's seconds and the visitor's own at once, under a second `daily_ip` row keyed by an HMAC that includes the unit; if either refuses, voice rests as above (at upgrade: the socket is accepted, gets `voice_resting` and closes 1008; `/session` says `mode: "text"` for that visitor), and the one that succeeded is given back. On close the unused part goes back to both, only to the same UTC day. `ASSISTANT_MODE` is `voice` by default, `text` turns voice off, and `off` refuses everything (503).

## Where data lives

| Where | Holds | Kept |
| --- | --- | --- |
| Conversation object (Durable Object) | Visitor text and answers (history), the token's secret hash, the session expiry | Deleted 30 days after the session expires |
| D1 `turns` | Measurements per turn: ids, timings, tokens, cost, coverage, gate and grounding counts. No question or answer text | 30 days |
| D1 `gaps` | Questions the knowledge only partly covered, as the visitor sent or said them, unredacted, with the first 8 characters of the conversation id, mode, coverage and cited refs. No answers | 30 days |
| D1 `daily` | Counts per unit per day, and the alert claims (`alert:<kind>`) | 7 days |
| D1 `daily_ip` | Turns and mic seconds per visitor per day, each keyed by an HMAC of the day and IP (seconds: with the unit too) | Until its UTC day ends |
| Worker logs | Operational lines (status codes, error codes, counts). Never visitor or answer text, keys or addresses | Per the account's Workers Logs retention |

Every vendor's handling of visitor data is in [docs/decisions/0002-data-handling.md](docs/decisions/0002-data-handling.md). The hourly cron does all the deleting except the Durable Object's own alarm.

**Turn log.** After every answer ends, the Worker writes one row to `turns`, off the visitor's path: a failed write is logged, and the answer is unaffected. The row holds measurements only: the turn and conversation ids, mode, model, protocol, prompt and knowledge hashes, timings, tokens, estimated cost, coverage, whether the data line came out ok, missing or invalid, the mic seconds and spoken characters a voice turn used, what the output gate dropped or flagged, how many claims the grounding check found unsupported or uncited, whether the visitor stopped it, and any error code. Canary rows are tagged `source = 'canary'`.

**Gap log.** "What is missing": when a reply's data line parsed with coverage `adjacent` or `none` (the pressed-answer rule's filled-in line included), the Worker writes the question to `gaps`, off the visitor's path like the turn log; the canary's questions are skipped. A failed write is logged without the question. Read the last 30 days, newest first, then write the missing knowledge:

```sh
npm run gaps         # the deployed database (wrangler d1 execute DB --remote)
npm run gaps:local   # the local one in playground/.wrangler/state
```

## Demo mode

`ASSISTANT_DEMO=1` serves a few scripted replies and silent speech instead of MiniMax. It applies only while `MINIMAX_API_KEY` is missing: a key always wins. Without the key and without the flag the Worker is misconfigured, never quietly a demo: `/assistant/session` answers 503 `not_configured`, the canary fails with `not configured`, and `/assistant/health` says what is missing. `.dev.vars.example` sets the flag; production `wrangler.jsonc` never does.

## Health, canary and alerts

`GET /assistant/health` returns `ok`, `mode`, `demo`, and `missing`: the names, never the values, of missing required config (`TURNSTILE_SECRET`, `IP_HASH_KEY`, and `MINIMAX_API_KEY` outside demo mode) and, separately, of optional config (`ALERT_TO`). `ok` is false, with status 503, while anything required is missing.

**Canary.** Every hour (cron `17 * * * *`) the Worker asks "Where does Yash work now?" through `/assistant/chat`, the way a visitor does, and logs `canary ok in <ms> ms` or `canary failed: <reason>`. The reason is an HTTP status, an error code, a missing event, `not configured` or `assistant is off` (it does not ask while `ASSISTANT_MODE` is `off`), never answer text. It spends one of the day's turns; once they are used up it does not ask, logs `canary skipped: resting` and that is not a failure. A 503 `resting` from the ask itself is a failure, `ledger unavailable` (the database is down). It sends no `cf-connecting-ip`, so it counts against the per-IP bucket `"unknown"` (24 a day, well under 60). Its turns are tagged `source = 'canary'`. To run it under `npm run dev`, open `/cdn-cgi/local/scheduled` on the dev server.

**Alerts.** The cron emails the owner through the `ALERT_EMAIL` binding, from `ALERT_FROM` to the `ALERT_TO` secret, at most once per kind per UTC day (claimed in `daily` as `alert:<kind>` before sending):

| Kind | When |
| --- | --- |
| `canary_failed` | the canary failed, with its reason |
| `slow` | the canary took more than 10 s end to end |
| `resting` | the day's shared turns are used up |
| `misconfigured` | required config is missing (names listed) |

The body is the kind, the UTC time and the reason, never visitor text. Without `ALERT_TO` or the binding, a warning is logged instead. If sending fails the claim is given back, so the next hour tries again. If the claim itself fails (the database is down), the email is sent anyway and the failure logged: at most one an hour during an outage. An assistant switched `off` on purpose raises nothing.

## Deploying

Deploy with `npm run deploy` (or `npm run deploy:staging`), never a bare `wrangler deploy`. The Vite plugin builds the Worker into `dist/yashos_assistant/` with its own `wrangler.json`, and the scripts deploy that file. Because Vite's root is `playground/`, the plugin's redirect file lands in `playground/.wrangler/deploy/`, where `wrangler` won't use it. Other `wrangler` commands (`secret put`, `d1 migrations apply`, `d1 execute`) read `wrangler.jsonc` directly; add `--env staging` for the staging copy.

**Staging** is a separate Worker, `yashos-assistant-staging` on workers.dev, defined under `env.staging` in `wrangler.jsonc`. It has its own D1 database, Turnstile's test secret, voice on, with ceilings of 100 answers, 1,200 s of listening and 30,000 spoken characters a day (and 600 s of listening per visitor), and no alert email. Anyone with its URL can use it, within those limits. Remove it with `npx wrangler delete --env staging`. `npm run gaps -- --env staging` reads its gap log.

1. Create the production database once with `npx wrangler d1 create yashos-assistant`, and put its id in `wrangler.jsonc` as `database_id`. Then apply every migration, through the newest (`0006_gaps.sql`): `npx wrangler d1 migrations apply DB --remote`. Until the migrations are applied the assistant rests, because the ledger fails closed.
2. Set the secrets with `npx wrangler secret put <NAME>`:
   - `TURNSTILE_SECRET`: the real secret for the site key, not the test one;
   - `IP_HASH_KEY`: `openssl rand -hex 32 | npx wrangler secret put IP_HASH_KEY`;
   - `MINIMAX_API_KEY`;
   - `ALERT_TO`: the address of the verified Email Routing destination.
3. Verify that Email Routing destination in the Cloudflare dashboard, and keep `yashos.dev` onboarded for sending (`ALERT_FROM` is `assistant@yashos.dev`).
4. Put a real Turnstile site key in the host page; the playground's test key only works with the test secret.
5. Do not set `ASSISTANT_DEMO` in production. After `npm run deploy`, check that `/assistant/health` says `ok: true` with nothing required missing.
6. Check that the Rate Limiting binding works on the account's plan: an 11th `POST /assistant/session` from one IP within a minute should get `429`.
7. `ASSISTANT_MODE` is `voice` in `wrangler.jsonc`, so **Workers Paid** ($5 a month) is needed now: on Free, Flux gets about 14 minutes a day, a voice socket is one invocation with 50 subrequests (about 17 to 25 spoken turns), and a cold turn can pass the 10 ms CPU limit. Details in [docs/research/stt-options.md](docs/research/stt-options.md). Confirm the voice ceilings against the Workers AI and MiniMax dashboards; after the first live week, compare the Workers AI neurons with the sum of `audio_in_seconds` in `turns`.
