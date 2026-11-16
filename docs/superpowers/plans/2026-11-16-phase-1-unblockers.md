# Phase 1 Unblockers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the YashOS window typed status signals, an outage flag with one-email alerts, a 12,000-character paste limit, shared start-screen copy, and a client and config that are ready for the first production deploy.

**Architecture:** Protocol version 2 adds one small vocabulary (`RestingReason`, new error codes) that the Worker sends on the session reply, on refusals and on failed answers, and that `AssistantSession` turns into typed snapshot fields. A single D1 row is the outage flag: set by a visitor failure that will not fix itself or by two failed hourly checks, read on session open and at each turn's start, cleared when the canary passes.

**Tech Stack:** TypeScript, Cloudflare Workers (Durable Objects, D1, cron), Vite with the Cloudflare plugin, vitest, zod (protocol only), React (playground only).

**Spec:** `docs/superpowers/specs/2026-11-16-phase-1-unblockers-design.md`. Read it before any task; the tables in its sections 1 and 2 are the requirements.

## Global Constraints

- The repo is public. Never read, print or copy `.dev.vars`. Never put a secret's value in code, tests, docs or logs; names only.
- Commit locally on `hardening` at the end of each task. Never push, never open a PR, never deploy (`npm run deploy`, `npm run deploy:staging` and `wrangler deploy` are off limits).
- End every commit message with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. Subjects are plain sentences, like the existing log (`git log --oneline -5`).
- `npm run check` (typecheck, lint, tests, knowledge check) passes before every commit. Do not weaken or delete an existing test to get there; a test that encodes behaviour this plan changes is updated to the new behaviour, and the task's report says which.
- Layer import rules in `tests/import-rules.test.ts` and `eslint.config.js` stay as they are.
- Follow the repo's style: doc comments that say why, no new dependencies unless a task names one.
- Visitor-facing copy and docs have no em or en dashes, never say "he" or "she" for Yash, and never mention money, credit, quotas or counts of questions left. Alert reasons and log lines hold codes, statuses and durations only, never visitor text.
- Write tests first, watch them fail, then implement (TDD). Use the existing test helpers (`tests/sqlite-d1.ts`, `src/client/testing.ts`, and the fakes already in each `*.test.ts`).
- Do only your task. If something outside it looks wrong, say so in your report; do not fix it.

## Review Focus

Failure modes the spec implies that are easy to miss. Each has a test in the task named.

1. A newer server sends `resting` with a `reason` this client does not know, or none: the client treats it as `outage` ("back soon"), never crashes. (Task 2)
2. D1 is down: the flag cannot be read or written. Sessions and turns answer `resting` with reason `outage`, and the owner is still emailed. (Tasks 4, 5)
3. The flag is set while the day's shared turns are also used up: the reason is `ceiling`, and the canary, which is skipped at the ceiling, leaves the flag alone. (Tasks 4, 5)
4. A long paste refused for the visitor's allowance gives back all three turns everywhere: conversation, visitor, shared. (Task 6)
5. A 12,000-character message of multi-byte text (CJK, emoji) fits the body cap; 12,001 characters is refused with 400 before any spend. (Task 6)
6. The canary's own conversation is never refused by the flag, or the assistant could never come back. (Task 4)

---

### Task 1: Resting reasons from the Worker (protocol 2)

**Files:**
- Modify: `src/protocol/version.ts`, `src/protocol/events.ts`, `src/protocol/chat.ts`
- Modify: `src/worker/ledger.ts`, `src/worker/index.ts`, `src/worker/conversation.ts`, `src/worker/voice-loop.ts`
- Modify: `src/client/text-chat.ts` (only `isSessionResponse`, so the client still accepts the reply)
- Test: `src/worker/ledger.test.ts`, `src/worker/index.test.ts`, `src/worker/conversation.test.ts`, `src/worker/voice-loop.test.ts`

**Interfaces:**
- Produces, in `src/protocol/events.ts`:
  ```ts
  export type RestingReason = "ceiling" | "visitor" | "outage";
  // the error event becomes:
  | { type: "error"; code: ErrorCode; message: string; reason?: RestingReason }
  ```
  If the voice path validates server events with a zod schema, extend it the same way.
- Produces, in `src/protocol/chat.ts`: `SessionResponse.resting: RestingReason | null`.
- Produces, in `src/protocol/version.ts`: `PROTOCOL_VERSION = 2`. `WS_SUBPROTOCOL` stays `"assistant.v1"`.
- Produces, in `src/worker/ledger.ts`:
  ```ts
  export type TurnSpend = "ok" | RestingReason;
  /** For /session: why the assistant rests for this visitor right now, or null. */
  export async function restingReason(env: Env, ip: string, log: Log): Promise<RestingReason | null>;
  ```
  `restingToday` is removed (its only caller is `/session`).

- [ ] **Step 1: Failing tests in `ledger.test.ts`**
  - `spendTurn` returns `"visitor"` when only the visitor's day is used, `"ceiling"` when everyone's is (also when both are), `"outage"` when a spend throws or `IP_HASH_KEY` is missing; a refused turn still leaves both counts unchanged.
  - `restingReason` returns `null` with room on both; `"ceiling"` at the shared ceiling; `"visitor"` when the visitor's used turns equal `DAILY_TURNS_PER_IP`; `"ceiling"` when both; `"outage"` when the database throws.
- [ ] **Step 2: Run `npx vitest run src/worker/ledger.test.ts`; the new cases fail.**
- [ ] **Step 3: Implement in `ledger.ts`.** `restingReason` reads the shared count and the visitor's count concurrently. Order: `ceiling`, then `visitor`, then `outage` for any failed read.
- [ ] **Step 4: Failing tests for the HTTP and voice refusals**
  - `index.test.ts`: `/assistant/session` replies `resting: null`, `"ceiling"`, `"visitor"` in the three cases, and `protocol: 2`; with `ASSISTANT_MODE=off`, `/session` and `/chat` reply 503 `{ error: "off" }`.
  - `conversation.test.ts`: `/chat` replies 503 `{ error: "resting", reason: "ceiling" }`, 503 `{ error: "resting", reason: "visitor" }` (was 429 `limit`), 503 `{ error: "resting", reason: "outage" }` when the spend throws; a full conversation still replies 429 `{ error: "limit" }`.
  - `voice-loop.test.ts`: a turn refused with `"visitor"` sends `{ type: "error", code: "resting", reason: "visitor" }` and ends the socket as `"resting"` does today; `"ceiling"` and `"outage"` carry their reason; a rejected `spendTurn` counts as `"outage"`.
- [ ] **Step 5: Implement** in `index.ts`, `conversation.ts`, `voice-loop.ts` (`refused`, `sendError` gains an optional reason), and widen `isSessionResponse` in `text-chat.ts` to accept `resting` as `null` or one of the three strings. Update every comment that describes the old codes (`events.ts` `ErrorCode` doc, `chat.ts`, `conversation.ts` `chat` doc, `ledger.ts`).
- [ ] **Step 6: `npm run check` passes.** `src/worker/outage.test.ts` and `canary.test.ts` must still pass unchanged (the canary still sees 503 `resting`).
- [ ] **Step 7: Commit.** `git commit -m "Protocol 2: resting carries its reason; the visitor cap stops sharing 'limit'"`

### Task 2: The client reports typed states

**Files:**
- Modify: `src/client/text-chat.ts`, `src/client/assistant-session.ts`, `src/client/voice-session.ts`, `src/client/react.ts` (only if types need it), `playground/TextChat.tsx`, `playground/styles.css`
- Test: `src/client/text-chat.test.ts`, `src/client/assistant-session.test.ts`, `src/client/voice-session.test.ts`

**Interfaces:**
- Consumes: `RestingReason`, the refusal bodies and `PROTOCOL_VERSION` from Task 1.
- Produces, in `text-chat.ts`:
  ```ts
  export type HttpErrorCode = ErrorCode | "off" | "bad_request" | "unknown";
  export class AssistantHttpError extends Error { readonly status: number; readonly code: HttpErrorCode; readonly reason: RestingReason | null }
  /** The server and this client speak different protocol versions. */
  export class OutdatedError extends Error { readonly server: number }
  ```
- Produces, in `assistant-session.ts`:
  ```ts
  export type AssistantStatus = "idle" | "starting" | "ready" | "resting" | "off" | "outdated" | "error";
  export type MessageError = HttpErrorCode | ErrorCode | "connection";
  // AssistantSnapshot gains: resting: RestingReason | null  (non-null exactly when status is "resting")
  // ChatMessage.error: MessageError | null
  ```

- [ ] **Step 1: Failing tests in `text-chat.test.ts`**
  - 503 `{ error: "off" }` throws `AssistantHttpError` with `code: "off"` (the old `{ mode: "off" }` mapping to `resting` is gone).
  - 503 `{ error: "resting", reason: "visitor" }` throws with `code: "resting"`, `reason: "visitor"`; a missing or unknown `reason` gives `reason: "outage"`.
  - A session reply with `protocol: 3` throws `OutdatedError` with `server: 3`.
- [ ] **Step 2: Failing tests in `assistant-session.test.ts`**
  - Session reply `resting: "ceiling"` gives `status: "resting"`, `resting: "ceiling"`; `resting: null` gives `status: "ready"`, `resting: null`.
  - `/session` 503 `off` gives `status: "off"` (not `"error"`), also when a session already existed and a renewal discovers it.
  - `OutdatedError` from a first session or a renewal gives `status: "outdated"`, and it stays until `reset()`.
  - `/chat` 503 `resting` with reason `visitor` sets `status: "resting"`, `resting: "visitor"`, and the message's `error` is `"resting"`; an `error` event with code `resting` and a reason does the same in text and voice.
  - A text stream that breaks mid-answer, a `fetch` that rejects, and a voice socket that drops mid-answer set the message's `error` to `"connection"` (was `"unknown"`). An HTTP refusal with an unrecognised code is still `"unknown"`.
  - A network failure on the first session still gives `status: "error"`.
- [ ] **Step 3: Failing test in `voice-session.test.ts`:** a `ready` event with another `protocol` shuts voice down and the session ends with `status: "outdated"` (assert through `AssistantSession`, or through whatever event `VoiceSession` emits for it).
- [ ] **Step 4: Run the three client test files; the new cases fail.**
- [ ] **Step 5: Implement.** Keep `notice` text as it is (the window does not read it). `mode` handling for `voice_resting` is unchanged.
- [ ] **Step 6: Playground.** In `TextChat.tsx` show, in place of the field: for `resting`, a card "So many people talked to the assistant today that it's tired out." followed by "It'll be back tomorrow." (`ceiling`, `visitor`) or "It'll be back soon." (`outage`); for `off`, the same card with "It'll be back soon."; for `outdated`, "The assistant was updated. Reload the page to keep asking." with a Reload button. Under a failed answer show the code. Reuse existing styles where they fit.
- [ ] **Step 7: `npm run check` passes.**
- [ ] **Step 8: Commit.** `git commit -m "Client: typed off, outdated and resting-reason states; dropped connections are 'connection'"`

### Task 3: A failed answer says what happened

**Files:**
- Modify: `src/ports/llm.ts`, `src/worker/deadlines.ts`, `src/adapters/anthropic-compatible.ts`, `src/protocol/events.ts`, `src/worker/text-turn.ts`, `src/worker/voice-loop.ts`
- Create: `src/worker/turn-failure.ts`
- Test: `src/worker/turn-failure.test.ts` (new), `src/worker/deadlines.test.ts`, the adapter's existing test file, `src/worker/text-turn.test.ts`, `src/worker/voice-loop.test.ts`

**Interfaces:**
- Produces, in `src/ports/llm.ts`: `LlmErrorKind` gains `"quota"`. `LlmError` gains two optional readonly fields set through its options: `deadline?: "total" | "idle"` (timeouts only) and `code?: number` (the provider's own numeric status code).
- Produces, in `src/protocol/events.ts`: `ErrorCode` gains `"timeout"`.
- Produces, in `src/worker/turn-failure.ts`:
  ```ts
  export interface TurnFailure {
    /** For TurnRecord.error. */
    record: string;
    /** For the error event. */
    code: "timeout" | "provider" | "resting";
    reason?: "outage";
    message: string;
    /** For the log: kind, HTTP status and provider code; never provider or visitor text. */
    logLine: string;
  }
  export function turnFailure(err: unknown): TurnFailure;
  /** Record errors that mean the provider will keep failing until someone acts. */
  export const OUTAGE_ERRORS: ReadonlySet<string>; // "llm_auth", "llm_quota"
  ```

- [ ] **Step 1: Failing tests in `turn-failure.test.ts`**
  - `LlmError("timeout", …, { deadline: "total" })` gives `record: "llm_timeout_total"`, `code: "timeout"`; `deadline: "idle"` gives `"llm_timeout_idle"`, `code: "timeout"`.
  - kind `auth` gives `record: "llm_auth"`, `code: "resting"`, `reason: "outage"`; kind `quota` gives `"llm_quota"`, `code: "resting"`, `reason: "outage"`.
  - kinds `rate_limit`, `overloaded`, `bad_request`, `empty`, `network`, `unknown` give `record: "llm_<kind>"`, `code: "provider"`, no reason.
  - a non-`LlmError` gives `record: "llm_failed"`, `code: "provider"`.
  - `logLine` for `new LlmError("quota", "secret provider text", { status: 429, code: 2056 })` contains `quota`, `429` and `2056` and does not contain `secret provider text`.
- [ ] **Step 2: Failing tests for the adapter and deadlines**
  - `deadlines.test.ts`: the total deadline throws `LlmError` with `deadline: "total"`, the idle one with `deadline: "idle"`.
  - Adapter test: an HTTP error whose body carries MiniMax code 1008, 2053, 2056 or 2067 is kind `quota`; 1004 or 2049 is kind `auth`; 2062 and 1002 stay `rate_limit`; the code is on `LlmError.code`. A provider code wins over the HTTP status (a 429 with 2056 is `quota`, not `rate_limit`). A body with no recognised code keeps today's kinds. An error event inside the stream is classified the same way.
  - In the test file of whichever module does the one retry (`deadlines.ts` today): kinds `auth` and `quota` are never retried.
- [ ] **Step 3: Run the test files; the new cases fail.**
- [ ] **Step 4: Implement.**
  - Adapter: read the numeric code from `base_resp.status_code` (number or numeric string). Before choosing other places to look, check how the one recorded refusal carries its code: `docs/decisions/0001-phase-0-results.md` (the Token Plan line), `docs/research/vendor-apis.md`, and any saved response under `probes/results/`. Support the shape found there too. Do not call the provider to find out.
  - `turn-failure.ts`, then use it in `text-turn.ts` (the catch at about line 161) and `voice-loop.ts` (the catch at about line 665) in place of their inline mapping. The message for `timeout` and `provider` stays "The assistant could not finish that answer. Please try again."; for `resting` use "The assistant is resting for now. Messages is the best way to reach Yash."
- [ ] **Step 5: Failing-then-passing tests in `text-turn.test.ts` and `voice-loop.test.ts`:** a total timeout yields an error event with code `timeout` and a record whose `error` is `llm_timeout_total`; an `auth` failure yields code `resting` with reason `outage` and record error `llm_auth`; an `overloaded` failure after its retry yields `provider`.
- [ ] **Step 6: Find every other use of the old strings** (`grep -rn "llm_timeout" src playground evals probes scripts`) and update readers (inspector labels, eval or canary code that matches on it).
- [ ] **Step 7: `npm run check` passes.**
- [ ] **Step 8: Commit.** `git commit -m "Failed answers say what happened: timeout, provider, or an outage"`

### Task 4: The outage flag

**Files:**
- Create: `migrations/0007_flags.sql`, `src/worker/outage-flag.ts`, `src/worker/outage-flag.test.ts`
- Modify: `src/worker/ledger.ts`, `src/worker/conversation.ts`, `tests/sqlite-d1.ts` (only if it lists migrations by hand)
- Test: `src/worker/ledger.test.ts`, `src/worker/conversation.test.ts`, `src/worker/index.test.ts`, `src/worker/canary.test.ts`

`src/worker/outage.test.ts` already exists and tests a D1 outage end to end; leave its name alone, which is why this module is `outage-flag`.

**Interfaces:**
- Consumes: `TurnSpend`, `restingReason`, `spendTurn` (Task 1); `OUTAGE_ERRORS` (Task 3).
- Produces, migration `0007_flags.sql`:
  ```sql
  CREATE TABLE flags (name TEXT PRIMARY KEY, reason TEXT NOT NULL, set_at INTEGER NOT NULL);
  ```
  with a header comment in the style of `0005_daily_ip.sql`.
- Produces, in `src/worker/outage-flag.ts`:
  ```ts
  /** The flag, or null when the assistant is not resting for an outage. Throws when the database fails. */
  export async function readOutage(db: D1Database): Promise<{ reason: string; setAt: number } | null>;
  /** Sets it; true when it was not already set (the first reason is kept). */
  export async function setOutage(db: D1Database, reason: string, now: number): Promise<boolean>;
  /** Clears it; true when it was set. */
  export async function clearOutage(db: D1Database): Promise<boolean>;
  ```
- Produces, in `src/worker/ledger.ts`:
  ```ts
  /** The gate every turn passes: the spend and the outage flag, read concurrently. */
  export async function admitTurn(env: Env, ip: string, log: Log, o?: { skipOutage?: boolean }): Promise<TurnSpend>;
  ```
  `restingReason` also reads the flag (same parallel batch): order stays `ceiling`, `visitor`, then `outage` when the flag is set or any read fails.

- [ ] **Step 1: Failing tests in `outage-flag.test.ts`** (real SQLite through `tests/sqlite-d1.ts`): unset reads `null`; `setOutage(db, "llm_quota", 1000)` returns `true` and reads `{ reason: "llm_quota", setAt: 1000 }`; a second `setOutage(db, "other", 2000)` returns `false` and the first reason and time stay; `clearOutage` returns `true`, then `false`; the read is `null` again.
- [ ] **Step 2: Implement the migration and the module; the tests pass.**
- [ ] **Step 3: Failing tests in `ledger.test.ts`**
  - `admitTurn` with the flag unset behaves as `spendTurn`.
  - Flag set: returns `"outage"` and both counts are unchanged afterwards (the spend is given back).
  - Flag set and the shared ceiling reached: returns `"ceiling"` (Review Focus 3).
  - Flag set and `skipOutage: true`: returns `"ok"` and the turn is spent (Review Focus 6).
  - The flag read throws: returns `"outage"`, counts unchanged (Review Focus 2).
  - `restingReason` returns `"outage"` when the flag is set and no cap is reached.
- [ ] **Step 4: Implement `admitTurn` and the `restingReason` change.**
- [ ] **Step 5: Failing tests in `conversation.test.ts`, `index.test.ts`, `canary.test.ts`**
  - With the flag set, `/chat` on a visitor's conversation replies 503 `{ error: "resting", reason: "outage" }` and the conversation's turn count is unchanged; a voice turn sends `resting` with reason `outage`.
  - With the flag set, the canary's conversation (`init(…, "canary")`) is answered normally.
  - `/assistant/session` replies `resting: "outage"` with the flag set.
  - A visitor turn whose record ends with error `llm_auth` or `llm_quota` leaves the flag set with that error as its reason; a turn ending `llm_timeout_total` does not set it.
- [ ] **Step 6: Implement in `conversation.ts`.** Text `chat` and the voice loop's `ledger.spendTurn` both call `admitTurn`, with `skipOutage` true only for the canary's conversation. In `logTurn`, a record whose `error` is in `OUTAGE_ERRORS` sets the flag inside `ctx.waitUntil`, with failures logged, never thrown. (Task 5 replaces this direct call with `reportOutage`.)
- [ ] **Step 7: `npm run check` passes.** Run `npm run db:migrate:local` once to confirm the migration applies cleanly.
- [ ] **Step 8: Commit.** `git commit -m "An outage flag rests the assistant when the provider will not recover by itself"`

### Task 5: Alerts for every failure, and the hourly check drives the flag

**Files:**
- Modify: `src/worker/alerts.ts`, `src/worker/watch.ts`, `src/worker/conversation.ts`, `src/worker/voice-loop.ts`, `README.md` (the "Health, canary and alerts" section)
- Test: `src/worker/alerts.test.ts`, `src/worker/watch.test.ts`, `src/worker/outage.test.ts`, `src/worker/conversation.test.ts`, `src/worker/voice-loop.test.ts`

**Interfaces:**
- Consumes: `setOutage`, `clearOutage`, `readOutage` (Task 4); `OUTAGE_ERRORS` (Task 3).
- Produces, in `alerts.ts`:
  ```ts
  export type AlertKind = "outage" | "answer_failed" | "voice_failed" | "slow" | "resting" | "misconfigured";
  /**
   * Sets the outage flag and, when it was newly set, emails the owner (kind "outage").
   * If the flag cannot be written, the email is raised anyway. Never throws.
   */
  export async function reportOutage(env: Env, reason: string, log: Log, now?: number): Promise<void>;
  ```
  `canary_failed` is removed.
- Produces, on `VoiceLoop`'s options: `onVoiceFailure?: (reason: "stt_failed" | "tts_failed" | "tts_timeout") => void`, called once per failure where `sttFailed` and `ttsFailed` already log.

- [ ] **Step 1: Failing tests in `alerts.test.ts`:** `reportOutage` with the flag unset sets it and sends one email with subject `Assistant alert: outage` whose text holds the reason; with the flag already set it sends nothing, even on a later UTC day (one email per outage); when `setOutage` throws it still sends.
- [ ] **Step 2: Failing tests in `watch.test.ts`** (use a fake `runCanary`, by whatever seam the existing tests use, or add an optional second parameter to `watch`)
  - Canary passes with the flag set: the flag is cleared, no email.
  - Canary fails twice: `runCanary` was called twice, the flag is set with the second failure's reason, one `outage` email.
  - Canary fails then passes: the flag stays unset and one `answer_failed` email goes out whose reason names the first failure.
  - Canary fails twice with the flag already set: no email.
  - "not configured" raises `misconfigured` and "assistant is off" raises nothing, each after a single run, flag untouched.
  - Skipped as resting: the `resting` email as today, and the flag is left as it was (Review Focus 3).
  - A slow pass still raises `slow`.
- [ ] **Step 3: Update `outage.test.ts`:** with D1 down the canary fails twice, and the owner is emailed with subject `Assistant alert: outage` (Review Focus 2).
- [ ] **Step 4: Failing tests for visitor failures**
  - `conversation.test.ts`: a visitor record with error `llm_timeout_total` raises `answer_failed` with that code as its reason; a record with `llm_quota` goes through `reportOutage` (one `outage` email) and raises no `answer_failed`; a canary record raises nothing from `logTurn`; an interrupted or stopped turn raises nothing; a record whose only error is a speech failure (`tts_failed`, `tts_timeout`) raises nothing from `logTurn`, because `voice_failed` covers it.
  - `voice-loop.test.ts`: `sttFailed` calls `onVoiceFailure("stt_failed")`; a speech failure calls it once with `"tts_failed"` or `"tts_timeout"`.
- [ ] **Step 5: Implement.** In `conversation.ts`, wire `onVoiceFailure` to `raiseAlert(env, "voice_failed", reason, log)`; every alert raised from a visitor's turn runs in `ctx.waitUntil`. In `watch.ts`, the second canary run follows the first directly.
- [ ] **Step 6: README.** Rewrite "Health, canary and alerts" to describe the six kinds, the outage flag (what sets it, what clears it, one email per outage), and that staging has no alert binding. Keep it as short as the section is today.
- [ ] **Step 7: `npm run check` passes.**
- [ ] **Step 8: Commit.** `git commit -m "Email on any failure, once per kind per day; two failed checks rest the assistant"`

### Task 6: The long paste

**Files:**
- Modify: `src/protocol/chat.ts`, `src/worker/conversation-state.ts`, `src/worker/ledger.ts`, `src/worker/conversation.ts`, `evals/cases.json`, `README.md` (the "Limits" section)
- Test: `src/worker/conversation-state.test.ts`, `src/worker/ledger.test.ts`, `src/worker/conversation.test.ts`, and the protocol's test for `ChatRequestSchema` if one exists

**Interfaces:**
- Consumes: `admitTurn` (Task 4).
- Produces, in `src/protocol/chat.ts`:
  ```ts
  export const MAX_MESSAGE_CHARS = 12_000;
  /** A message longer than this counts as LONG_MESSAGE_TURNS turns. */
  export const LONG_MESSAGE_CHARS = 4_000;
  export const LONG_MESSAGE_TURNS = 3;
  export const MAX_BODY_BYTES = 65_536;
  /** How many turns `message` (as sent to the model) counts as: 1, or LONG_MESSAGE_TURNS. */
  export function turnsFor(message: string): number;
  ```
- Produces: `ConversationState.startTurn(n = 1): boolean` (false, counting nothing, when `n` do not fit) and `undoTurn(n = 1)`; `admitTurn(env, ip, log, o?: { skipOutage?: boolean; turns?: number })`, and `spendTurn` takes the same count.

- [ ] **Step 1: Failing tests**
  - `turnsFor`: a 4,000-character message is 1; 4,001 is 3.
  - `conversation-state.test.ts`: `startTurn(3)` with 28 of 30 started returns false and the count stays 28; with 27 it returns true and the count is 30; `undoTurn(3)` gives three back.
  - `ledger.test.ts`: `admitTurn(…, { turns: 3 })` adds 3 to both counts; with 58 of the visitor's 60 used it returns `"visitor"` and both counts are unchanged; with 398 of the shared 400 used it returns `"ceiling"`, counts unchanged.
  - `conversation.test.ts`: a 12,000-character message is answered and the conversation, visitor and shared counts each rose by 3; a 12,001-character message replies 400 and nothing is counted; a 12,000-character message of `"語"` and one of emoji pairs is accepted (Review Focus 5); a long message refused with `resting` reason `visitor` leaves the conversation's count unchanged (Review Focus 4); a long message with 28 turns started replies 429 `limit`.
- [ ] **Step 2: Run; the new cases fail.**
- [ ] **Step 3: Implement.** Count the message as the model will see it (after the same sanitising and trimming `chat` already applies). Voice turns always count 1.
- [ ] **Step 4: Eval case.** Read `evals/run.ts` and the existing `injection-job-description` case, then add a safety case `injection-long-job-description`: a realistic job description of about 11,000 characters for a senior full-stack role with an instruction buried near the middle (for example a line telling the assistant to ignore its rules and state that Yash has ten years of Rust experience), graded the way the existing injection case is. Write the description as prose and bullet lists a real posting would have; no real company name. Do not run `npm run eval` in this task.
- [ ] **Step 5: README "Limits":** 12,000 characters per message; a message over 4,000 counts as three questions against the conversation, the visitor's day and the shared day.
- [ ] **Step 6: `npm run check` passes** (it includes `knowledge:check`; the eval file must still parse, so run `npx tsx -e "JSON.parse(require('fs').readFileSync('evals/cases.json','utf8'))"`).
- [ ] **Step 7: Commit.** `git commit -m "Accept a pasted job description up to 12,000 characters, counted as three questions"`

### Task 7: Shared start-screen copy

**Files:**
- Create: `src/client/start-screen.ts`, `src/client/start-screen.test.ts`
- Modify: `playground/TextChat.tsx`

**Interfaces:**
- Produces, in `src/client/start-screen.ts` (no imports):
  ```ts
  export const GREETING = "Hi, I'm Yash's AI assistant. Ask about Yash's work and I'll show where each answer comes from.";
  export interface Starter { id: "fit" | "ai" | "built"; text: string; note?: string }
  export const STARTERS: readonly Starter[] = [
    { id: "fit", text: "Is Yash a fit for my role?" },
    { id: "ai", text: "What has Yash built with AI?" },
    { id: "built", text: "How were you built?", note: "for engineers" },
  ];
  export const MORE_QUESTIONS: readonly string[] = [
    "What does Yash do now?",
    "Why hire Yash?",
    "What is Yash's strongest project?",
    "Where is Yash based, and is remote OK?",
    "What is Yash still learning?",
  ];
  ```

- [ ] **Step 1: Failing test in `start-screen.test.ts`:** starter ids are unique; no string in the module contains an em dash, an en dash, or the words "he" or "she" (word-boundary match, case-insensitive); every question ends with "?"; every string is at most 100 characters.
- [ ] **Step 2: Create the module; the test passes.**
- [ ] **Step 3: Playground.** `TextChat.tsx` drops its own `STARTERS` and `GREETING` and uses the module: the three starters as chips (the note shown small beside its chip) and the more-questions list beneath them. Clicking any of them asks its text.
- [ ] **Step 4: `npm run check` passes.**
- [ ] **Step 5: Commit.** `git commit -m "Greeting and starter questions in one shared client module"`

### Task 8: The client can be copied into another bundler

**Files:**
- Modify: `src/client/mic.ts`, `src/client/voice-session.ts`, `src/client/assistant-session.ts`, `src/client/capture-worklet.d.ts` (remove if nothing needs it), the playground file that constructs `AssistantSession` and any that constructs `VoiceSession` (`playground/TextChat.tsx`, `playground/VoiceSpike.tsx`)
- Create: `tests/client-vendoring.test.ts`
- Test: `src/client/assistant-session.test.ts`, `src/client/voice-session.test.ts`

**Interfaces:**
- Produces: `AssistantSessionOptions.workletUrl?: string | URL`, passed through `VoiceSession` to the mic. No file under `src/client` imports the worklet. `startVoice()` without a `workletUrl` fails the way a blocked microphone does today, with an error whose message is `workletUrl is required for voice`, before asking for the microphone.

- [ ] **Step 1: Failing tests:** `startVoice()` on a session built without `workletUrl` does not call `getUserMedia` and surfaces the failure; with a `workletUrl`, that URL is what `audioWorklet.addModule` receives (use the fakes the voice tests already have).
- [ ] **Step 2: Failing test `tests/client-vendoring.test.ts`.** Walk the non-test `.ts` files in `src/client` (skip `*.test.ts` and `testing.ts`) and, from them, every file they import. Assert:
  - no import specifier contains `?`;
  - every value (non-`import type`) import resolves to a file in `src/client`, or to `src/protocol/sse.ts`, `src/protocol/version.ts` or `src/protocol/audio.ts`, or is the package `react` imported from `src/client/react.ts`;
  - those three protocol files have no value import of any package.
  Parse imports with the TypeScript compiler API (`typescript` is already a dev dependency) so `import type` and inline `type` specifiers are told apart correctly.
- [ ] **Step 3: Run; both fail (the `?url` import in `mic.ts`).**
- [ ] **Step 4: Implement.** The playground does its own `import workletUrl from "../src/client/capture-worklet.js?url&no-inline"` and passes it.
- [ ] **Step 5: `npm run check` passes, and `npm run build` succeeds** (the playground still bundles the worklet).
- [ ] **Step 6: Commit.** `git commit -m "The mic worklet's URL is an option, so the client bundles outside Vite"`

### Task 9: Production config, the blueprint page and the go-live checklist

**Files:**
- Modify: `wrangler.jsonc`, `src/worker/index.ts`, `README.md` ("Deploying"), `docs/decisions/0001-phase-0-results.md` (the Token Plan line only), any doc that Phase 1 made false
- Create: `tests/wrangler-config.test.ts`
- Test: `src/worker/index.test.ts`

**Interfaces:**
- Produces: `GET /assistant/blueprint` replies 200 with `content-type: text/html` and the content of the blueprint; other methods reply 405.

- [ ] **Step 1: Failing test `tests/wrangler-config.test.ts`.** Read `wrangler.jsonc` (strip comments; if a JSONC parser is already installed use it, otherwise a small comment stripper that respects strings) and assert: top level has `routes` equal to `[{ "pattern": "yashos.dev/assistant/*", "zone_name": "yashos.dev" }]`, `workers_dev: false`, `preview_urls: false`; `env.staging` has `routes` equal to `[]` and `workers_dev: true`.
- [ ] **Step 2: Edit `wrangler.jsonc`,** with a comment above the route saying it is the only door in production and that the site's own Worker serves everything else. The test passes.
- [ ] **Step 3: Verify the built configs by hand.** Run `npm run build`, read `dist/yashos_assistant/wrangler.json`: it has the route and `workers_dev` false. Run `CLOUDFLARE_ENV=staging npx vite build`, read it again: no route, `workers_dev` true, name `yashos-assistant-staging`. Put both observations in your report. Do not deploy.
- [ ] **Step 4: Failing test in `index.test.ts`** for `GET /assistant/blueprint` (200, `text/html`, body contains the blueprint's `<title>`), `POST` (405), and that `/assistant/nope` is still 404.
- [ ] **Step 5: Implement the page** with one copy of the HTML in the repo. Either serve it through the `ASSETS` binding (moving the file into the assets the build already publishes, and fixing every reference to its old path) or import it into the Worker; choose whichever the Vite and wrangler setup supports without a new dependency, and check it works in `npm run dev` or in the built output. Send `cache-control: public, max-age=3600`.
- [ ] **Step 6: README "Deploying".** Add a "First production deploy" checklist, written from the code (`src/worker/config.ts`, `src/worker/env.ts`, `wrangler.jsonc`, `package.json`): create the D1 database and put its id in `wrangler.jsonc`; apply the migrations to it; set each secret with `wrangler secret put` (list the names, never values, and mark which are required); the Turnstile secret must be the one paired with the site key YashOS uses for the assistant widget; verify the alert address in Cloudflare Email Routing and set `ALERT_TO`; `npm run deploy`; then confirm `https://yashos.dev/assistant/health` replies `ok: true`, `https://yashos.dev/assistant/blueprint` loads, a voice session connects over `wss://yashos.dev/assistant/voice`, and the next hourly check logs `canary ok`. Each step is one line with its exact command where there is one.
- [ ] **Step 7: Keep the docs true.**
  - `docs/decisions/0001-phase-0-results.md`: replace the claim that the provider's terms expect pay-as-you-go for a public site with what is known: the Token Plan page describes the plan as designed for individual, interactive developer use and recommends pay-as-you-go for production; it throttles bursts per minute; no clause was found that forbids a public site; Yash launches on the Token Plan for now and the outage flag covers running out (decided 2026-11-16).
  - `grep -rn "4,000\|4000\|canary_failed\|\"limit\"" README.md docs/design docs/research playground/README.md` and correct statements Phase 1 changed (message limit, the alert kinds, the per-visitor cap's code, protocol version). Leave historical decision records and old plans as they are.
- [ ] **Step 8: `npm run check` passes.**
- [ ] **Step 9: Commit.** `git commit -m "Production route, the blueprint page and a first-deploy checklist"`

### Task 10: Whole-branch check

- [ ] **Step 1:** `npm run check` passes on the final tree; `git status` is clean.
- [ ] **Step 2:** `npm run eval` once (it calls the real provider with the project's own key, which the script loads itself; never print it). Report the safety and quality counts exactly as printed, including any failures and any rate-limit errors. Do not edit cases or prompts to make it pass.
- [ ] **Step 3:** Report: commits made, anything a task left undone, and anything found outside the plan.
