# Phase 1 unblockers: status signals, alerts, the long paste, shared copy, going live

Date: 2026-11-16. Branch: `hardening`. Agenda items 1 to 5.

## Intent

YashOS is about to build the assistant's window on top of this repo's client. Its spec
(`../portfolio-os/docs/superpowers/specs/2026-11-16-assistant-integration-design.md`, "Needs from the
voice bot" items 2a, 5, 6 and 7) lists what the window cannot do until this repo changes. This design
covers those changes, so the window can show every state from the client alone, without reading
notice text, and so the first production deploy is a checklist, not a project.

## Goals

- The client reports, as typed values, every state the window has to tell apart: ready, resting (and
  why), switched off, outdated, unreachable; and on a failed answer, whether it timed out, the model
  failed, or the connection dropped.
- A failure that will not fix itself rests the assistant for everyone until the hourly check passes,
  and Yash gets one email about it.
- Yash is emailed about any failure a visitor could have seen, at most once per kind per day.
- A pasted job description of up to 12,000 characters is accepted, without making abuse cheaper.
- The greeting and starter questions live in one module both repos use.
- The client can be copied into YashOS unedited and bundled by Next.js.
- Production config (route, blueprint page, checklist) is written and checked locally.

## Non-goals

- Deploying. Nothing in this design deploys to staging or production. The first production deploy
  needs Yash to set secrets, and happens with Yash.
- Anything in the portfolio-os repo (the sync script, the window, Turnstile widget).
- A credit or XP system for more questions (dropped by Yash: no real value).
- A "quota running low" warning. MiniMax's remaining-quota endpoint has no documented response
  format. The outage flag below covers running out.
- Switching from the Token Plan to pay-as-you-go. Yash launches on the Token Plan for now.
- Reading MiniMax speech (T2A) failure codes. They are undocumented for credit and quota; a rejected
  key or empty quota also fails the model call, which is classified.
- Dev CORS. YashOS may not need it (a Next.js rewrite may do); it is added when it does.

## Anti-goals

- The visitor never sees money, credit, a quota, a count of questions left, or the word "error".
  This repo's client carries codes; the window owns the wording.
- No alert email ever holds visitor text. Reasons are codes, statuses and durations only.
- No email spam: one email per outage, and at most one per kind per UTC day for everything else.
- The assistant must not rest for an hour because one check hiccuped.

## Constraints

- The repo is public. `.dev.vars` is never printed or copied. Commits are local only.
- Nothing has been deployed to production and the playground is the only client, so a breaking
  protocol change is free today.
- Layer import rules (`tests/import-rules.test.ts`, `eslint.config.js`) stay as they are.
- `npm run check` passes after every piece.
- Copy has no em or en dashes and never says "he" or "she" for Yash.

## Approaches

For the status signals (the other items have one sensible way):

1. **One typed answer from the session, protocol version 2 (chosen).** The session reply and every
   refusal carry the same small vocabulary: a status, and for resting a reason. The per-visitor cap
   stops sharing the `limit` code with a full conversation. Costs a protocol bump, which is free now
   and exercises the new `outdated` status.
2. **Stay on version 1 with optional fields.** No bump, but `limit` keeps two meanings and the
   client keeps special cases, which is the problem item 1 exists to remove.
3. **A separate status endpoint the window polls.** Shows an outage without a new session, but adds
   a request to every open and a second source of truth.

Yash handed the how to Fable; Fable picked 1.

## Design

### 1. Status signals (protocol 2)

`PROTOCOL_VERSION` becomes 2. `WS_SUBPROTOCOL` stays `assistant.v1`: changing it would make an old
client's voice handshake fail before it could learn it is outdated.

**Vocabulary** (in `src/protocol`, zod-free where the client needs it at runtime):

```ts
/** Why the assistant is resting. The window says "back tomorrow" for the first two, "back soon" for the third. */
export type RestingReason = "ceiling" | "visitor" | "outage";
```

- `ceiling`: the day's shared turns are used up.
- `visitor`: this visitor's own daily turns are used up.
- `outage`: the outage flag is set (below), or the ledger or the flag cannot be read (fails closed).

When more than one applies, the order is `ceiling`, `visitor`, `outage`: a daily cap means "tomorrow"
whatever else is true. A database that cannot be read is `outage`, not `ceiling`.

**Session reply.** `SessionResponse.resting` changes from `boolean` to `RestingReason | null`.
`POST /assistant/session` now also checks this visitor's turns for today and the outage flag, in the
same parallel batch as today's checks. It still mints a token when resting.

**Refusals.**

| Case | Today | Protocol 2 |
| --- | --- | --- |
| Switched off (`/session`, `/chat`) | 503 `{ mode: "off" }` | 503 `{ error: "off" }` |
| Shared ceiling | 503 `{ error: "resting" }` | 503 `{ error: "resting", reason: "ceiling" }` |
| Visitor's daily turns | 429 `{ error: "limit" }` | 503 `{ error: "resting", reason: "visitor" }` |
| Outage flag set, or ledger unreadable | 503 `{ error: "resting" }` | 503 `{ error: "resting", reason: "outage" }` |
| This conversation is full | 429 `{ error: "limit" }` | unchanged; `limit` now means only this |

Voice follows the same rule: the `error` event gains an optional `reason?: RestingReason`, sent with
code `resting`. A voice turn refused for the visitor's daily turns sends `resting` with reason
`visitor` and ends the socket the way `resting` does today. `voice_resting` is unchanged.

`TurnSpend` in `ledger.ts` becomes `"ok" | RestingReason`: visitor refused and everyone ok is
`visitor`; everyone refused is `ceiling`; a failed spend (database, `IP_HASH_KEY`) is `outage`.

**Failed answers.** The `error` event's code separates the cases; the record keeps the detail.

| What happened | Event code | `record.error` |
| --- | --- | --- |
| No complete answer in 30 s | `timeout` (new) | `llm_timeout_total` |
| Nothing from the model for 10 s | `timeout` | `llm_timeout_idle` |
| Rejected key, or no credit or quota | `resting`, reason `outage` | `llm_auth`, `llm_quota` |
| Any other model failure | `provider` | `llm_<kind>` as today |
| The connection failed or dropped | none; set by the client | n/a |

The same mapping applies to voice turns. The client marks a message whose stream or socket failed or
dropped with `connection` (today `unknown`). `unknown` remains only for an HTTP refusal with a code
the client does not know.

**Client** (`AssistantSession`):

- `AssistantStatus` gains `"outdated"`. The snapshot gains `resting: RestingReason | null`, non-null
  exactly when `status` is `"resting"`.
- 503 `off` from `/session` or `/chat` sets status `off` (today `mint()` sets `error`).
- A session whose `protocol` differs, and a voice `ready` event whose `protocol` differs, both set
  status `outdated`. It stays until `reset()`.
- `off`, `resting` and `outdated` apply whether or not a session already existed (a renewal can
  discover them too).
- `ChatMessage.error` can be `timeout`, `provider`, `connection`, and the rest as today.
- The playground shows each new state in a plain way (a resting card whose second sentence follows
  the reason, an off line, an outdated line), so each can be seen locally.

### 2. The outage flag and alerts

**The flag.** One row in a new D1 table (migration `0007`):

```sql
CREATE TABLE flags (name TEXT PRIMARY KEY, reason TEXT NOT NULL, set_at INTEGER NOT NULL);
```

The only flag is `outage`. A small module (`src/worker/outage.ts`) reads it, sets it (returning
whether it was newly set) and clears it (returning whether it was set). `reason` is a code such as
`llm_quota` or the canary's failure reason.

**Set by two triggers:**

- **A visitor's answer fails for a reason that will not fix itself.** The model adapter gains an
  `LlmErrorKind` of `quota` and reads MiniMax's numeric status code: 1008 and 2053 (no credit), 2056
  and 2067 (the plan's window is used up) are `quota`; 1004 and 2049 (key) are `auth`. Burst codes
  (2062, 1002 and the like) stay `rate_limit`. A failure of kind `auth` or `quota`, in text or voice,
  sets the flag at once, and that visitor's answer ends with `resting`, reason `outage`.
  - Only the 2062 burst refusal has ever been recorded (0001). Where the code sits in the response on
    the Anthropic-compatible endpoint is unverified, so the adapter looks in the documented field
    (`base_resp.status_code`) and wherever the recorded 2062 response shows it; an unrecognised
    response keeps today's status-based kinds. The failure log line includes the code number, so the
    first real case teaches us.
- **The hourly check fails twice in a row.** `watch()` runs the canary; if it fails for a reason other
  than "assistant is off" or "not configured", it runs it once more straight away. Two failures set
  the flag. One failure followed by a pass sets nothing and raises `answer_failed`. This covers every
  failure the code list misses, at the cost of up to an hour of unfinished answers first.

**Read at:** `/session` (the card shows on open) and the start of every visitor turn, text and voice,
concurrently with the turn's spend so a turn still waits one database round trip. A turn refused by
the flag costs nothing. The canary's own conversation (`source = "canary"`) skips the flag check, so
it can find out the provider is back.

**Cleared when** the hourly canary passes. No "it's back" email.

**Alerts.** `raiseAlert` keeps its once per kind per UTC day rule. Kinds:

| Kind | Raised when |
| --- | --- |
| `outage` (replaces `canary_failed`) | the flag is newly set, by either trigger. While it stays set, later failed checks send nothing, so one outage is one email even across days. |
| `answer_failed` (new) | a visitor's answer ends with any other error (timeout, overloaded after its retry, rate limit, unknown), or the canary fails once and then passes |
| `voice_failed` (new) | speech recognition or speech output fails during a visitor's voice session |
| `slow`, `resting`, `misconfigured` | as today |

Alerts from a visitor's turn run in `waitUntil`, never in the answer's path.

### 3. The long paste

- `MAX_MESSAGE_CHARS` becomes 12,000. `MAX_BODY_BYTES` becomes 65,536 (12,000 characters can be
  36,000 bytes of UTF-8 before JSON escaping).
- A message longer than 4,000 characters (`LONG_MESSAGE_CHARS`) counts as three turns
  (`LONG_MESSAGE_TURNS`) against the visitor's day and the shared day (agreed with Yash), and against
  the conversation's 30 (Fable's call: the paste stays in history and is re-read on every later
  question, so this caps a conversation at ten pastes).
- If three do not fit, the turn is refused exactly as a single turn would be, and costs nothing.
- Voice is unaffected; a transcript never gets that long.
- One new safety eval case: a job description of about 11,000 characters with an instruction buried
  in the middle.

### 4. Shared start-screen copy

A new client module beside `disclosure.ts` exports the copy Yash approved; the playground uses it
and drops its own.

- Greeting: "Hi, I'm Yash's AI assistant. Ask about Yash's work and I'll show where each answer comes from."
- Starters, each with a stable `id` so the window can attach behaviour:
  - `fit`: "Is Yash a fit for my role?"
  - `ai`: "What has Yash built with AI?"
  - `built`: "How were you built?" with the note "for engineers"
- More questions: "What does Yash do now?", "Why hire Yash?", "What is Yash's strongest project?",
  "Where is Yash based, and is remote OK?", "What is Yash still learning?"

The canary's question is separate and does not change.

### 5. Going live

- **The mic worklet's URL becomes an option.** `src/client` no longer imports the worklet with
  Vite's `?url`. `AssistantSession` takes `workletUrl`; starting voice without it fails with a clear
  error; text needs nothing. The playground does its own `?url&no-inline` import and passes it.
  YashOS serves its vendored copy of `capture-worklet.js` from its own `public/`, so the client and
  the worklet always come from the same copy. The Worker does not serve it.
- **A test guards the vendoring contract.** Every runtime import reachable from the non-test files in
  `src/client` stays inside `src/client` or the zod-free protocol files, and no import uses a bundler
  query (`?url`, `?raw`). Note for YashOS: the vendored protocol files import `zod` for types only,
  so YashOS needs `zod` installed as a dev dependency to typecheck; none of it reaches its bundle.
- **The route.** Production gets `routes: [{ pattern: "yashos.dev/assistant/*", zone_name: "yashos.dev" }]`,
  with `workers_dev` and `preview_urls` off, so the route is the only door. Cloudflare's docs list
  `routes` as a key environments inherit, so staging sets `routes: []` beside its
  `workers_dev: true` and must end up with no route. Checked by building both and reading the
  generated `dist/yashos_assistant/wrangler.json`.
  - From Cloudflare's docs (read 2026-11-16): a route takes precedence over a Custom Domain on the
    same hostname, and the most specific route pattern wins, so this Worker gets `/assistant/*`
    whichever way the site is attached. The pattern does not match the bare path `/assistant`;
    nothing lives there. That WebSocket upgrades follow the same route is inferred, not documented,
    and is confirmed at the first deploy.
- **The blueprint page.** `GET /assistant/blueprint` serves `docs/design/assistant-blueprint.html` as
  HTML, from one copy in the repo.
- **A go-live checklist** in the README's "Deploying" section: create the database and apply
  migrations, set each secret (names only), pair the Turnstile secret with the site's key, verify the
  alert address in Email Routing, deploy, then check `/assistant/health` and one canary run.
- **Docs kept true.** Any statement Phase 1 makes false is corrected (README limits and alerts, the
  blueprint's numbers if it quotes them). 0001's Token Plan line is corrected: the plan's page
  recommends pay-as-you-go for production and throttles bursts, it does not forbid a public site, and
  Yash launches on it for now.

## Left to the builder

- File and function names not given above, and where the vocabulary types live.
- How the flag read is combined with the turn spend, within "one round trip, a refused turn costs nothing".
- How the blueprint file reaches the Worker (a static asset or an import), within "one copy in the repo".
- How `LlmError` carries which deadline fired.
- The exact wording of alert reasons and log lines, within "no visitor text".

## Checks

- `npm run check` passes.
- Tests cover: each row of the two tables in section 1, server and client; reason order; the flag's
  two triggers, the canary bypass, clearing, and one email per outage; each alert kind and its
  once-a-day rule; the 4,000 and 12,000 boundaries and the three-turn count with its refund; the
  status-code classification; the vendoring contract; the route in the built config.
- `npm run eval` is run once at the end against the real provider; the result is reported as it is.
- Not checked here: anything on Cloudflare's network. The route and the alert email are confirmed at
  the first production deploy.

## Calls Fable made

Each is easy to change.

- A long paste also counts three against the conversation's 30.
- The canary must fail twice in a row before the assistant rests.
- A second outage on the same UTC day rests the assistant but sends no second email (the existing
  once-a-day rule).
- The worklet is served by YashOS, not by this Worker.
- `workers_dev` is off in production.
- The blueprint is served as it is, including its Google Fonts link.
- Dev CORS waits until YashOS needs it.
