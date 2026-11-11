# YashOS Assistant

A voice and text assistant that answers recruiters' questions about Yash's work, grounded only in Yash's published portfolio content. It runs as one Cloudflare Worker: a Durable Object per conversation streams speech-to-text (Deepgram Flux on Workers AI), the language model and text-to-speech (MiniMax) in a server-side turn loop, and a React playground exercises it locally. Vendors sit behind small ports with fakes, so everything runs and tests without API keys. The design is in the [assistant blueprint](docs/design/assistant-blueprint.html).

```sh
npm install
npm run dev     # applies the local D1 migrations, then the playground and Worker on the Vite dev server
npm run check   # typecheck, lint, tests, knowledge bundle check
```

Optional keys go in `.dev.vars` (see `.dev.vars.example`).

Voice under `npm run dev` needs `npx wrangler login` first: speech-to-text (Flux) always runs on Workers AI, even locally, and bills $0.0077 per audio minute.

## Running the text assistant locally

1. `cp .dev.vars.example .dev.vars`. It carries Cloudflare's published Turnstile test secret
   (`TURNSTILE_SECRET=1x0000000000000000000000000000000AA`), which accepts only the test token
   `XXXX.DUMMY.TOKEN.XXXX`; the playground's test site key `1x00000000000000000000BB` produces that
   token. These are safe in a public repo; production uses a real secret set as a Worker secret.
   Without `TURNSTILE_SECRET`, `/assistant/session` refuses everyone with 503. `MINIMAX_API_KEY` is
   optional: without it the answers come from a few scripted demo replies.
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

Limits: one answer at a time per conversation (a second gets 409 `busy`), 30 questions per
conversation (429 `limit`), and `DAILY_TURNS` (400) answers per UTC day for all visitors together,
voice included. Past that, `/assistant/session` reports `resting: true` and `/assistant/chat` answers
503 `resting` until UTC midnight. The day's count lives in D1 (table `daily`), one atomic upsert per
answer; if D1 can't be reached, the assistant rests rather than answer uncounted. `DAILY_TURNS` `"0"`
pauses it.

**Turn log.** After every answer ends, the Worker writes one row to D1 (table `turns`, schema in
`migrations/`), off the visitor's path: a failed write is logged, and the answer is unaffected. The
row holds measurements only: the turn and conversation ids, mode, model, protocol, prompt and
knowledge hashes, timings (first token, first sentence, first audio, done), tokens, estimated cost,
coverage, whether the data line came out ok, missing or invalid, the mic seconds and spoken
characters a voice turn used (what Flux and MiniMax speech bill by), what the output gate dropped or
flagged, how many claims the grounding check found unsupported or uncited, whether the visitor
stopped or interrupted it, and any error code.
It never holds the question, the answer or the claims themselves. The hourly cron deletes rows older
than 30 days, and daily counts older than 7.

**Deploying.** Put the Cloudflare account on **Workers Paid** ($5 a month) first. On Workers Free,
voice breaks in three ways: Flux gets about 14 minutes a day from the free Workers AI allowance, a
voice socket is one invocation with 50 subrequests (about 17–25 spoken turns), and a cold turn can
pass the 10 ms CPU limit. Text mostly fits Free, but not reliably on a cold start. Details are in
[docs/research/stt-options.md](docs/research/stt-options.md). Then:

1. The first `wrangler deploy` creates the D1 database (no `database_id` in `wrangler.jsonc`).
2. Apply the schema with `npx wrangler d1 migrations apply DB --remote`. Until it is applied the
   assistant rests, because the ledger fails closed.
3. Check that the Rate Limiting binding works on the account's plan: an 11th `POST /assistant/session`
   from one IP within a minute should get `429`.
4. After the first live week, compare the Workers AI neurons on the dashboard with the sum of
   `audio_in_seconds` in the turn log, to confirm Flux costs about 700 neurons per minute and whether silence is billed.

**Canary.** Every hour (cron `17 * * * *`) the Worker asks "Where does Yash work now?" through
`/assistant/chat`, the way a visitor does (it spends one of the day's answers), and logs either
`canary ok in <ms> ms` or `canary failed: <reason>`. The reason is an HTTP status, an error code, a
missing event or "assistant is off" (it does not ask while `ASSISTANT_MODE` is `off`), never answer
text. Its answers go to the turn log like a visitor's, tagged `source = 'canary'` so they can be left
out of the review. To run it under `npm run dev`, open `/cdn-cgi/local/scheduled` on the dev server
and read its output.
