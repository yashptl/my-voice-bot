# Playground

A dev test page for the assistant, served by `npm run dev` together with the Worker. It is not the
YashOS app: it exists to try the assistant end to end and to see what each answer cost. It has two
tabs. **Text** comes first because most visitors will type. **Voice** is the Phase 0 voice spike. The
URL hash keeps the tab across reloads (`#voice`).

```sh
npm run dev   # then open the URL Vite prints
```

## Getting a session

Both tabs start a conversation the same way: an invisible Turnstile check in the browser
(`getTurnstileToken` in `src/client/turnstile.ts`), then `POST /assistant/session` with its token
(`startSession` in `src/client/text-chat.ts`). The playground uses Cloudflare's published test values,
which are safe in a public repo: the site key `1x00000000000000000000BB` (always passes, invisible)
produces the token `XXXX.DUMMY.TOKEN.XXXX`, which only the test secret
`1x0000000000000000000000000000000AA` accepts. Put that secret in `.dev.vars` as `TURNSTILE_SECRET`
(see `.dev.vars.example`); without it `/session` answers 503 `turnstile_not_configured`.

## Text tab

- The session starts when the page opens, so the first question doesn't wait for it.
- Starter questions send at once. Enter sends, Shift+Enter adds a line, and Esc or **Stop** aborts the
  answer, which also stops the model on the server. A question is capped at 4,000 characters; a
  counter appears near the cap.
- An answer grows sentence by sentence, with its sources as chips underneath (also when the reply
  ended with a bare `<refs>` list instead of its data line). When the model sets `contact`, a card
  offers Messages.
- **Under the hood**, under each finished answer: the model; first token, first sentence and done in
  milliseconds since the server received the question; tokens (input, cached, output, reasoning); the
  estimated cost; coverage and refs from the data line, and a **Data line** row when it was missing or
  invalid; what the output gate dropped or flagged;
  the grounding check, with unsupported claims highlighted; and the prompt and knowledge hashes.

What each refusal looks like:

| Server reply | What the page does |
| --- | --- |
| 409 `busy`, 429 `rate_limited`, 401 `auth`, 400, network error | The question never entered the conversation: it leaves the list, goes back in the box, and a line above the box says why. After `auth` the next send starts a new session. |
| 429 `limit` | The box is replaced by a card: Message Yash, or start a new conversation. |
| 503 `resting`, a session with `resting: true`, or 503 `{ mode: "off" }` | The box is replaced by the resting card: a one-line pitch, the resume and Messages. |
| An `error` event mid-answer (the model failed, after its one retry) | The answer keeps what was shown, and a card says it couldn't finish, with Message Yash. |
| The stream ending early | The answer keeps what was shown, with a note to ask again. |

The resume and Messages buttons point at yashos.dev here; in YashOS they open the resume and the
Messages hand-over.

## Voice tab

The voice spike from Phase 0. It unmounts when you switch to Text, so no mic or socket stays open
behind it. Recorded test questions live in `fixtures/` (see [fixtures/README.md](fixtures/README.md)).
Voice under `npm run dev` needs `npx wrangler login` first, because speech-to-text runs on Workers AI
even locally.
