# Speech-to-text options and the Cloudflare free plan (checked 2026-11-10)

Why voice uses Deepgram Flux on Workers AI, what it costs, what else exists, and whether the
assistant fits Cloudflare's Workers Free plan. Prices and limits come from official pages (links
at the end). **UNVERIFIED** marks what no official page states.

## Decision

- **Keep Flux on Workers AI** (`@cf/deepgram/flux`) for speech-to-text.
- **Move the account to Workers Paid ($5/month) before the assistant goes live.** On Workers Free
  the voice mode breaks in three ways (below); swapping the speech-to-text vendor fixes only one.
  Local development works on Free.
- **Plan B for speech-to-text:** Deepgram's own API runs the same Flux model with a one-time $200
  credit. Use it if the account must stay on Free, or when Hindi is needed (`flux-general-multi`).

## What Flux does, and why not MiniMax

Flux is the assistant's ears in voice mode only. It turns live mic audio into text, and it decides
with a model when the visitor has finished their turn, which is when the assistant starts
answering. Measured: the final transcript arrives about 0.2 s after speech ends.

MiniMax's own speech recognition (`asr-1.0`) cannot do this. It transcribes uploaded files (up to
500 s, containerised audio, no raw PCM). Its docs list "audio-side streaming input" as not
supported, and it has no end-of-turn detection or partial results. Using it would mean our own
silence detector, buffering, uploads, slower replies and cruder turn-taking, and visitor audio
would go to a vendor whose terms allow training on inputs.

## What Flux costs

- $0.0077 per audio minute = 700 Workers AI neurons per minute. Silent frames are probably billed
  too (**UNVERIFIED**).
- Every account gets 10,000 neurons a day free (resets 00:00 UTC), shared by all Workers AI use:
  about 14.3 Flux minutes a day.
- Workers Free: once the allowance is used, requests fail until midnight UTC; nothing is charged.
  Workers Paid: extra use costs $0.011 per 1,000 neurons (about $0.0077 a minute).
- Local dev calls the real Flux (`ai.remote: true`), so testing spends the same allowance.
- Used so far (estimate): about 5 minutes in total, roughly 3,500 neurons, within the free
  allowance each day.
- On Paid, 500 voice minutes a month costs about $0.55 extra if spread evenly, at most $3.85.

## Options compared

Ranked by: good enough for a recruiter demo, then free, then cheap, then convenient.

| Option | Free allowance | Price after | Live audio + end of turn | Hindi | Convenience | Verdict |
|---|---|---|---|---|---|---|
| **Flux on Workers AI** (current) | ~14.3 min/day, recurring | $0.0077/min, Paid only | Yes; model-based, ~0.2 s measured | No | Already running; no key; one bill | **Keep** |
| **Deepgram Flux, direct API** | $200 one-time, no card, never expires (~26,000 min) | $0.0077 (en), $0.0078 (multi) | Yes; same model | Yes | New account, key and adapter | **Plan B** |
| **Workers AI Whisper-turbo + smart-turn-v2 + browser voice detector** | ~129 min/day, recurring | ~$0.00085/min | No live stream (one request per utterance); model end of turn after a pause | Yes | Same account, three new parts, no live captions; est. 0.5–1.2 s after speech (**UNVERIFIED**) | Only if we must be strictly $0 |
| **Soniox stt-rt** | None (free credits ended Oct 2025) | $0.002/min | Yes; model-based ("semantic endpointing") | Yes | New vendor and adapter | Cheapest paid option; use if volume grows |
| **AssemblyAI Universal-Streaming** | $50 one-time, no card | $0.0025/min; $0.0075 for the model with Hindi | Yes; model-based, but waits ≥400 ms of silence by default | Pro model only | New vendor; bills idle connection time | Free credit can't opt out of training |
| **Moonshine in the browser** | Unlimited, MIT, on-device | $0 | Yes; silence-only end of turn | No | 45–142 MB first-visit download; v0.1.6; needs COOP/COEP headers | Too risky on phones today |

Ruled out:
- **Browser Web Speech API:** cloud mode sends audio to a web service, and on iPhone recognition
  stops after audio plays (WebKit bug 321436).
- **Groq Whisper:** no live input.
- **Azure F0:** 5 h/month, but needs a card and allows 1 stream at a time.
- **Google:** 60 min/month, and streaming is gRPC only.
- **AWS Transcribe:** 60 min/month for 12 months, trains on audio by default.
- **ElevenLabs:** the free plan is non-commercial.
- **Speechmatics:** $100 credit that expires after 12 months, silence-based end of turn.
- **Nova-3 on Workers AI and OpenAI:** cost more than Flux, without model-based end of turn.

## Does the assistant fit Workers Free?

Measured on 2026-11-10 (Node 24, same V8 as workerd; cold isolates on workerd are slower), against
the official Free limits.

**Breaks it**
1. **Workers AI, 10,000 neurons a day:** about 14.3 Flux minutes a day for all visitors. One
   maximum voice conversation (600 s of audio) uses 70% of it.
2. **50 external subrequests per invocation:** the voice socket is accepted with `accept()`, so it
   appears to be one invocation for its whole life (implied by Cloudflare's 2026-02-11 subrequest
   changelog). Each voice turn makes 2–3 outbound calls: MiniMax LLM, a retry, and MiniMax TTS. So
   a long conversation fails somewhere around turn 17–25. Plus D1 and Workers AI calls, whose pool
   is **UNVERIFIED**. A reconnect resets the budget.
3. **10 ms CPU per invocation** (whether Free Durable Objects get 10 ms or 30 s is **UNVERIFIED**):
   - Warm text turns fit: 1.6–2.8 ms with the fake LLM, up to 5.5 ms with real stream parsing.
   - The first turn on a cold isolate does not: 56–90 ms today, 250–330 ms with ~20K tokens of
     knowledge.
   - The cause is `checkGrounding` compiling about 120 unicode regexes (720 at 20K tokens), each
     compiled twice by V8's regexp tier-up, and again after major GCs.

**Tight**
- **Durable Object duration, 13,000 GB-s a day:** about 350 ten-turn voice conversations. A
  forgotten open voice tab costs about 450 GB-s an hour, because there is no idle close.
- **Durable Object requests, 100,000 a day:** voice sends 12.5 mic frames a second. Whether Free
  counts each WebSocket message 1:1 or 20:1 is **UNVERIFIED**.
- **Rate Limiting binding:** availability on Free is **UNVERIFIED**.

**Comfortable**
- Worker requests: static assets are free.
- Subrequests on /session, /chat and cron: about 4 per invocation.
- D1 rows and storage, cron count, Turnstile, Worker size (~1.1 MB), and logs.

Workers Paid ($5/month) lifts the blockers: Workers AI is billed beyond the free allowance,
subrequests rise to 10,000 per invocation, and Durable Object CPU is 30 s by default.

## Follow-ups found

1. **Grounding cold-start CPU (worth fixing on any plan):** build a per-bundle token index once per
   knowledge hash instead of compiling a unicode regex per name. It costs 56–90 ms on a cold first
   turn today and grows with the knowledge, which adds latency even on Paid.
2. **Idle close for voice sockets:** close the socket after a few minutes without speech, so a
   forgotten tab doesn't keep the Durable Object running.
3. **After the first live week:** compare the Workers AI neurons in the dashboard with the voice
   minutes we log, to confirm about 700 neurons per mic-open minute and whether silence is billed.
4. **On deploy:** confirm the Rate Limiting binding works on the account's plan.

## Still unverified

- Whether Flux bills silent audio.
- Whether `mip_opt_out` changes any price.
- Free-plan Durable Object CPU limit (10 ms or 30 s).
- Which subrequest pool Workers AI and D1 calls use.
- Whether Free counts WebSocket messages 1:1 or 20:1.
- Rate Limiting on Free.
- Whisper and smart-turn latency when called from a Durable Object.
- Moonshine's speed in a phone browser.
- Whether AssemblyAI's credit expires.
- Whether Deepgram's direct event format matches Workers AI's.

## Sources

Cloudflare:
- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Flux model](https://developers.cloudflare.com/workers-ai/models/flux/)
- [Whisper-turbo model](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/)
- [smart-turn-v2 model](https://developers.cloudflare.com/workers-ai/models/smart-turn-v2/)
- [Nova-3 model](https://developers.cloudflare.com/workers-ai/models/nova-3/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Subrequest limits changelog, 2026-02-11](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

MiniMax:
- [Speech-to-text guide](https://platform.minimax.io/docs/guides/speech-to-text)
- [Speech-to-text API reference](https://platform.minimax.io/docs/api-reference/speech-to-text.md)

Deepgram:
- [Pricing](https://deepgram.com/pricing)
- [Your data](https://developers.deepgram.com/trust-security/your-data)
- [Models and languages](https://developers.deepgram.com/docs/models-languages-overview)

Others:
- [Soniox free-credits update](https://soniox.com/blog/2025-10-27-free-credits-update-for-soniox-api)
- [Soniox pricing](https://soniox.com/pricing)
- [Soniox endpoint detection](https://docs.soniox.com/stt/rt/endpoint-detection)
- [AssemblyAI pricing](https://www.assemblyai.com/pricing)
- [AssemblyAI data controls](https://www.assemblyai.com/docs/data-controls)
- [AssemblyAI turn detection](https://www.assemblyai.com/docs/streaming/universal-streaming/turn-detection)
- [Moonshine (npm)](https://registry.npmjs.org/@moonshine-ai/moonshine-wasm)
- [Web Speech API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API)
- [WebKit bug 321436](https://bugs.webkit.org/show_bug.cgi?id=321436)
- [Azure Speech quotas](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits)
- [Speechmatics pricing](https://www.speechmatics.com/pricing)
- [Groq speech-to-text](https://console.groq.com/docs/speech-to-text)
- [Google Speech-to-Text pricing](https://cloud.google.com/speech-to-text/pricing)
- [AWS Transcribe pricing](https://aws.amazon.com/transcribe/pricing/)
- [ElevenLabs pricing](https://elevenlabs.io/pricing/api)

Measurement scripts (not in the repo):
`/private/tmp/claude-501/-Users-yash-Documents-personal-projects-voice-bot/3646c4b4-2016-40be-b6a0-3503b8794816/scratchpad/bench/`
