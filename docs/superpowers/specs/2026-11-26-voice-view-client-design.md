# What the YashOS voice view needs from the client

Date: 2026-11-26. Branch: `voice-view-client`. Agenda item 9.

## Intent

YashOS is building its voice view on this repo's browser client. Its spec
(`../portfolio-os/docs/superpowers/specs/2026-11-16-assistant-integration-design.md`, "Voice
(decided)" and "Needs from the voice bot" item 8) lists what the view cannot show until the client
exposes it: the sentence now playing, where an interrupted answer stopped, mic and voice levels for
the bars, the follow-up window, and hold-to-talk. Building the view found more gaps: why voice ended,
a failed speech stream, and muting the speaker. The API below was agreed with the YashOS voice screen
chat on 2026-11-26; its names and meanings are fixed.

## Goals

- The voice view renders every state from `AssistantSession`'s snapshot, plus one cheap per-frame
  getter for the bars, without reading notice text.
- Hold-to-talk works without closing the socket.
- A voice conversation the server closed for being idle comes back on the next press, on the same
  session, so it keeps its history.

## Non-goals

- Any change on the wire. `PROTOCOL_VERSION` stays 2 and the Worker behaves as before, so nothing
  is deployed.
- Changes in the portfolio-os repo. It re-vendors with `npm run assistant:sync`.
- A React hook for levels. The view reads them once per animation frame and writes the bars'
  transforms directly, never through React state.

## Constraints

- `src/client` is copied unedited into YashOS: runtime imports stay inside `src/client` and the
  zod-free protocol files (`tests/client-vendoring.test.ts`).
- The audio context is created and resumed inside the click, before the first await.
- The existing notice texts stay as they are; tests match them.
- `HalfDuplex`'s `onChange(state)` keeps its shape; tests assert exact change lists.

## The API

### 1. Levels: `AssistantSession.readLevels(out: Float32Array): "mic" | "voice" | null`

Fills `out` (any length; YashOS passes 5) with band levels from 0 to 1 and says whose they are:
"mic" only while the mic is live (not muted), "voice" while reply audio plays, and null, with `out`
zeroed, otherwise or with voice off. It allocates nothing per call.

- One `Meter` (`src/client/levels.ts`) wraps an `AnalyserNode` (`fftSize` 512,
  `smoothingTimeConstant` 0.6) and a preallocated byte buffer. Bands are log-spaced from 100 Hz to
  4 kHz, where speech is, each the mean of its bins.
- Mic: a side branch off the mic's source node in `mic.ts`. It does not reach the destination.
- Voice: on the player's output chain, `source -> gain -> analyser -> destination`. The analyser is
  after the gain, so a muted speaker reads as zeros (the bars go still with the sound).

### 2. The sentence playing: `snapshot.voice.playing: { messageId: string; sentenceId: number } | null`

- Set when a sentence's audio starts (`Player.onSentenceStarted`).
- Cleared when the speaker drains (`onIdle`), on interrupt, on stop, on the next `turn.start` and
  when voice ends. `Player.stop()` does not fire `onIdle`, so `VoiceSession` clears it wherever it
  stops the player.
- Sentence ids restart each turn, so `VoiceSession` pairs the id with its current `turnId` (audio is
  only accepted after its `turn.start`), and `AssistantSession` maps the turn to the message id
  through `voiceTurns`.
- Player callbacks are single-slot: `VoiceSession` sets them once and fans them out as events.
- Change to `Player`: a sentence is reported again when its audio resumes after the queue ran dry
  (slow speech synthesis). Otherwise a sentence that stalls mid-way would show nothing playing for
  the rest of it. While the queue is dry, `playing` is null, even mid-answer; the page may smooth
  short gaps if it wants.

### 3. Where an interrupted answer stopped: `ChatMessage.heardThrough?: number | null`

- Absent: not cut off. null: cut off before any sentence started. n: the sentences after n were not
  heard.
- n is the last sentence that started playing (`player.lastStartedSentenceId`), the id the server is
  sent.
- `VoiceSession` emits `{ type: "interrupt", turnId, lastHeardSentenceId }` exactly when it sends an
  interrupt to the server: from `AssistantSession.interrupt()`, and from the interrupt inside
  `VoiceSession.talk()`, including after the turn ended while its audio still played.
- `turn.interrupted`'s `lastHeardSentenceId` overrides the local value.

### 4. The mic: `snapshot.voice.mic: "off" | "live" | "muted"` and `snapshot.voice.followUp: boolean`

- `mic` mirrors `HalfDuplex` (the existing "mic" event).
- `followUp` is true while the mic is live inside the 8 s listening window after an answer, and false
  after `talk()`, the moment speech is heard, when the next reply starts, and when the window closes.
- `HalfDuplex` gets a `followUp` getter and a second, optional constructor callback, so `onChange`
  keeps its shape. `VoiceSession` emits `{ type: "followUp", open }`.

### 5. Hold-to-talk: `talk(): Promise<void>` and `pauseTalking(): void`

`talk()`:

- With voice open: the mic goes live now, interrupting the reply in progress, thinking or playing
  (`VoiceSession.talk`). It resolves once the mic is up. Before, a reply still thinking was left
  running, and its first audio muted the mic the visitor was holding; the server already replaces a
  running turn when a new one starts, so interrupting it matches.
- With voice not open (never started, or ended, for example by the server's 120 s idle close): it
  reopens voice on the same session and goes live, like `startVoice()`. The audio context is still
  created and resumed before the first await.
- While voice is connecting: it resolves with that connection, which goes live on open.
- Pressed while the server's close is in flight (the socket is closing, its close event not yet
  fired): it reopens voice rather than failing as a mic error. `VoiceSession.open` says whether the
  socket is open.
- Clears `voice.ended`. It never rejects: a failure is `voice.ended` and a notice.

`pauseTalking()`:

- The mic goes "muted" (zeroed frames, so Flux can end the turn and keep the last words) until the
  server's `turn.start`, then "off". If no turn starts within 6 s (nothing was said), it goes "off"
  then.
- After a paused turn no listening window opens: the mic stays off after the answer until the next
  `talk()`.
- Released while voice is still connecting, it applies as soon as the mic goes live.
- `HalfDuplex.pause()` and `HalfDuplex.turnStarted()` carry this; `talk()` clears it.

`startVoice()` now also resolves once the mic is up (or voice has ended), so `talk()` can share it.

### 6. `voice.state`

Unchanged: the server's turn state. The page derives "speaking" from `voice.playing !== null`, since
the server returns to "listening" when speech synthesis finishes, not when local playback does.

### 7. Why voice ended: `snapshot.voice.ended`

`"connect" | "dropped" | "idle" | "mic_blocked" | "mic_missing" | "mic" | "listening" | "resting" | "limit" | null`.
Null while voice is on; cleared by `startVoice()` and `talk()`.

| Value | When |
| --- | --- |
| `connect` | The socket never opened, or connect threw. |
| `idle` | The server's close 1000 "idle". |
| `mic_blocked` | `NotAllowedError` or `SecurityError`. |
| `mic_missing` | `NotFoundError`, `OverconstrainedError`, or no `navigator.mediaDevices` (an insecure page). |
| `mic` | Any other mic or worklet failure, including a missing `workletUrl` (today wrongly shown as a blocked mic). |
| `listening` | The close 1011 "speech recognition failed". |
| `resting` | `voice_resting`. |
| `limit` | This conversation's turn or audio limit: a `limit` error, then the close 1008 "turn limit" or "audio limit". |
| `dropped` | Any other unexpected close: session expired, 4000 replaced, conversation deleted, 1011 "start failed", and 1008 "resting" (the assistant resting for this visitor, which `status` already shows). |

- The connection event carries the close `code` and `reason` as fields; the client never parses
  `detail`.
- The close reasons the client matches move into `VOICE_CLOSE` in `src/protocol/voice.ts`, used by
  the Worker and the client, with the same strings, so nothing changes on the wire.
- `mic.ts` exports `micFailure(err)`, which classifies by the error's `name`. Without
  `navigator.mediaDevices`, `startMic` throws a `NotFoundError` before loading the worklet.
- Voice ended by the visitor (`stopVoice`, `reset`, `dispose`) or by an outdated protocol (`status`
  says it) leaves `ended` null.
- The notices are unchanged.

### 8. A failed speech stream: `ChatMessage.speechFailed: boolean`

- The server sends `{ type: "error", code: "provider", message: "Speech output failed; the answer
  continues as text." }` with no turn id. Speech-recognition failure shares the code, so the client
  matches the message.
- The message moves into `SPEECH_OUTPUT_FAILED` in `src/protocol/voice.ts`, used by both sides with
  the same text.
- It marks the latest voice answer, even when it arrives just after `turn.end` (when `voiceCurrent`
  is null). The notice still shows, as today.

### 9. The speaker: `AssistantSession.setSpeakerMuted(muted: boolean): void`

- One `GainNode` in the player before the analyser and destination.
- Timing, `ended` events and `playing` behave as if audible.
- Remembered when set before the player exists (it is created on `ready`) and across reconnects.

## Also fixed on the way

- `VoiceSession.close()` closes its audio context. `talk()` can now reopen voice every time the
  server closes it for idling, and each reopen makes a new `VoiceSession` with a new context;
  browsers cap how many stay open. `connect()` on the same `VoiceSession` keeps its context.
- `startMic` stops the mic again if wiring the audio graph fails after the mic opened (a context
  closed while the permission prompt was open may refuse new nodes), so the mic light goes off.

## Files

- `src/protocol/voice.ts` (new, zod-free): `SPEECH_OUTPUT_FAILED`, `VOICE_CLOSE`. The Worker uses
  both; `tests/client-vendoring.test.ts` allows the file.
- `src/client/levels.ts` (new): `Meter`.
- `src/client/player.ts`: gain and analyser, `setMuted`, `readLevels`, re-report on resume.
- `src/client/mic.ts`: analyser branch, `readLevels`, `micFailure`, the missing-`mediaDevices` error.
- `src/client/half-duplex.ts`: `followUp`, `pause()`, `turnStarted()`.
- `src/client/voice-session.ts`: `pauseTalking`, `readLevels`, `setSpeakerMuted`; events "playing",
  "interrupt", "followUp"; close code and reason; closes its context.
- `src/client/assistant-session.ts`: the snapshot fields, `talk`, `pauseTalking`, `readLevels`,
  `setSpeakerMuted`.
- `src/client/react.ts`: no change needed; `useAssistant` already carries the snapshot.
- `README.md`: the client API notes.

## Checks

- Every point above has tests: `levels.test.ts`, `player.test.ts`, `mic.test.ts`,
  `half-duplex.test.ts`, `voice-session.test.ts`, `assistant-session.test.ts`.
- `npm run check` passes (typecheck, lint, all tests, knowledge check).
