# 0002: How each processor handles visitor data

- **Status:** Recorded 2026-11-07 (Phase 0, Task 11). Feeds the privacy decision in [0001](0001-phase-0-results.md) and the visitor disclosure.
- **Method:** Primary sources only (each vendor's own policies, terms and docs), all read 2026-11-07. Wording is summarised, not quoted. **Not stated** means the sources listed here don't say. It does not mean "no".

## What reaches whom

| Processor | Receives | Returns |
| --- | --- | --- |
| MiniMax text API (`MiniMax-M3.1-Flash` / `MiniMax-M3`) | The stable prompt (rules plus public knowledge), the conversation so far and the visitor's message, typed or transcribed | Reply text (thinking stays inside the adapter) |
| MiniMax speech API (`speech-2.8-turbo`) | The assistant's reply sentences only, never visitor text | 24 kHz PCM audio |
| Cloudflare Workers AI, running Deepgram Flux (`@cf/deepgram/flux`) | Visitor microphone audio in voice mode (16 kHz PCM) | Transcripts and turn events |
| Cloudflare Workers and Durable Objects (this app's own runtime and storage) | Everything above, in transit; the `Conversation` object holds the history, deleted 30 days after the session expires | Not applicable |

Redacting emails and phone numbers before the model sees them is a blueprint commitment for Phase 1. Phase 0 code only strips invisible characters and caps length.

## MiniMax (text and speech API)

| Item | Finding |
| --- | --- |
| Legal entity | Nanonoble Pte. Ltd., registered in Singapore. It provides the Open Platform under the Terms and is named as the data controller in the API Privacy Policy. |
| Jurisdiction | Singapore. The Terms are governed by Singapore law, and disputes go to arbitration at the Singapore International Arbitration Centre. |
| Data region | The API Privacy Policy (section 9) says the personal data it covers is stored in a data center in the United States, and processed there by MiniMax or third-party vendors. Its EEA section repeats this and cites the EU-US Data Privacy Framework. The cloud provider is not stated. The policy's Singapore section says MiniMax generally does not move data out of Singapore, which conflicts with section 9. The Terms mention choosing the United States as a "service region" without saying which region `api.minimax.io` serves (not stated). |
| Retention of API inputs and outputs | **Text:** no period is stated. The Privacy Policy lists Input (text, voice and other content) and Output among the data it processes. It keeps personal data while needed for its purpose or as the law allows, then deletes or anonymises it. **Speech:** the API Overview says the speech interfaces are stateless and that a call does not store user data. Whether logs or safety reviews are an exception is not stated. |
| Training and opt-outs | The Terms let MiniMax use input and generated content to provide, maintain, develop and improve its Services. The confidentiality clause also allows using confidential information to improve algorithms. The Privacy Policy rules out only two narrower uses: inferring characteristics about a person, and training to profile or target consumers. It also allows commercial analysis of de-identified data for research and development. **No opt-out is stated**: the sources read show no API flag, console setting or request route. For speech, nothing about training is stated beyond the no-storage line. |
| Sub-processors | None are named, and no sub-processor list or data processing agreement was found. The Privacy Policy names only categories: group affiliates (including for system maintenance and data hosting), and third parties for payments, login, statistics and advertising, security and anti-fraud. |
| Customer duties | The Terms make Yash, as the API customer, responsible for having consent from the people whose personal information is sent. Data requests go to MiniMax at api@minimax.io. |
| Sources (read 2026-11-07) | API Terms of Service, effective March 30, 2026: https://platform.minimax.io/protocol/terms-of-service · API Privacy Policy, updated March 30, 2026: https://platform.minimax.io/protocol/privacy-policy · Overview pages that link the product terms and policies: https://www.minimax.io/terms-of-service-v2.html (updated April 15, 2026) and https://www.minimax.io/privacy-policy-v2.html · API Overview (speech is stateless): https://platform.minimax.io/docs/api-reference/api-overview. The consumer Audio app policy at minimax.io/audio covers MiniMax's own apps, not the API, so it does not apply. The M3 training-content summary linked from https://platform.minimax.io/docs/guides/transparency could not be read as text and is not relied on. |

## Cloudflare Workers AI (where Flux runs)

| Item | Finding |
| --- | --- |
| Legal entity | Cloudflare, Inc., San Francisco, California, US. For content that customers send through its services, it acts as a processor working on the customer's instructions (Privacy Policy). |
| Jurisdiction | United States. The Self-Serve Subscription Agreement is governed by California law and sends most disputes to arbitration. It incorporates Cloudflare's customer data processing addendum (DPA). Transfers from the EU, UK and Switzerland rely on Data Privacy Framework certifications, with standard contractual clauses as the fallback. |
| Data region | Workers AI runs models on GPUs across Cloudflare's network. Neither the data-usage page nor the Flux page says where a request is processed, and neither offers region pinning (not stated). The sub-processor list names CoreWeave, Inc. (United States) and Nebius BV (England) for Workers AI. |
| Retention of inputs and outputs | Zero data retention: for standard inference, inputs and outputs are not kept once the response is delivered. The exceptions are storage features the customer chooses (R2, KV, Durable Objects, Vectorize, AI Gateway logs or cache, application logs, batch or async jobs) and legal or safety obligations. Operational metadata (ids, timestamps, sizes, counts, latency, status codes) is kept, without content. The Flux model page marks the model "Zero data retention: Yes". |
| Training and opt-outs | Cloudflare says it does not train AI models on Workers AI customer content. Content kept for legal or safety reasons is not used to train or improve any product. No opt-out is needed. |
| Sub-processors | For Workers AI, the list names CoreWeave, Inc. (US) and Nebius BV (England). Cloudflare Group companies may also act as sub-processors for support work. Deepgram is not on the list. |
| What this means here | The `Conversation` Durable Object stores visitor text and transcripts. That storage is a feature this app chooses, so the zero-retention promise does not cover it: its retention is this app's own 30-day deletion commitment. For the Durable Object that is enforced in code: `init` sets a storage alarm for 30 days after the session expires, and the alarm deletes everything the object stored (`deleteAll`). The D1 turn log holds no visitor text (measurements only, see `migrations/0001_init.sql`), and the hourly cron deletes its rows 30 days after they were written. |
| Sources (read 2026-11-07) | Workers AI data usage, last updated Oct 16, 2026: https://developers.cloudflare.com/workers-ai/platform/data-usage/ · Flux model page: https://developers.cloudflare.com/workers-ai/models/flux/ · Workers AI overview: https://developers.cloudflare.com/workers-ai/ · Privacy Policy, effective Nov 4, 2025: https://www.cloudflare.com/privacypolicy/ · Self-Serve Subscription Agreement, updated Sept 12, 2025: https://www.cloudflare.com/terms/ · Sub-processors, updated Oct 1, 2025: https://www.cloudflare.com/gdpr/subprocessors/cloudflare-services/ |

## Deepgram (author of Flux)

| Item | Finding |
| --- | --- |
| Role here | Cloudflare lists Flux as a Cloudflare-hosted partner model and links Deepgram's terms as its "terms and license". **Whether any audio or transcript from a Workers AI request reaches Deepgram is not stated.** |
| Legal entity | Deepgram, Inc., San Francisco, California, US (Deepgram Terms, effective Aug 6, 2026). |
| Jurisdiction | California law, with most disputes sent to individual arbitration. |
| Data region | On Deepgram's own API, a global endpoint is the default and there are regional endpoints for the EU, Australia and India. A full in-region guarantee needs both a regional endpoint and `mip_opt_out=true`. For Workers AI traffic it is not stated, because Cloudflare decides where the model runs. |
| Retention | On Deepgram's own API, requests join the Model Improvement Program (MIP) by default, and Deepgram keeps audio, text and transcripts to improve its models. With `mip_opt_out=true`, content is kept only while the request is processed. Request metadata and usage logs, which contain no content, are kept for 90 days. On Workers AI, the Flux page offers a `mip_opt_out` input (default `"false"`) that opts the request out of the MIP, on the same page that marks the model zero-retention. How those two statements fit together is not stated. |
| Training and opt-outs | Deepgram's Terms grant Deepgram a broad licence to use customer content, including to train models, with a per-request opt-out parameter. This app's Flux adapter always sends `mip_opt_out: "true"` (Task 8), so it opts out whatever the default means on Workers AI. The Flux page says to check Deepgram's docs for pricing effects of opting out. Deepgram's MIP page mentions none, so any price impact on Workers AI is not stated. |
| Sub-processors | Deepgram publishes a list at https://deepgram.com/privacy/subprocessors. It was not reviewed, because it matters only if Deepgram turns out to receive Workers AI traffic. |
| Sources (read 2026-11-07) | Your data at Deepgram: https://developers.deepgram.com/trust-security/your-data · Model Improvement Partnership Program: https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program · Deepgram Terms: https://deepgram.com/terms · `mip_opt_out` on Workers AI: https://developers.cloudflare.com/workers-ai/models/flux/ |

Not covered: Anthropic. The `anthropic-haiku` profile runs only in the probes, and only when `ANTHROPIC_API_KEY` is set. The Worker refuses it: `buildProviders` (in `src/worker/providers.ts`) throws when `LLM_PROFILE` is `anthropic-haiku`, with or without a key, so it never sees visitor data in Phase 0. It needs its own entry here, and that profile added to the visitor allowlist in `buildProviders`, before it serves visitors. Where Cloudflare stores the `Conversation` Durable Object was not researched either.

## What the visitor disclosure can truthfully say

A line these sources support. The last sentence describes Phase 1 commitments and becomes true only once they ship:

> This is an AI assistant. Your messages go to MiniMax, a Singapore company that stores data in the US and may use it to improve its services; MiniMax writes and speaks the replies. In voice mode, your speech is turned into text by Deepgram's Flux model on Cloudflare Workers AI, which keeps no audio or text. Please don't share personal details. Yash may read conversations, and this assistant deletes its copy after 30 days.

It must **not** claim any of these:

- that MiniMax doesn't train on visitor messages;
- that MiniMax deletes them after any set time;
- that data stays in one region;
- that "no one else keeps a copy";
- that Deepgram itself keeps nothing. The zero-retention promise is Cloudflare's, and the adapter opts out of Deepgram's program on top of that.

## What stays unknown

1. How long MiniMax keeps text API inputs and outputs, and whether logs or safety reviews are kept apart from them.
2. Whether MiniMax actually trains on API traffic (the Terms allow it), and whether there is any opt-out, for example by contract or on request.
3. Which region `api.minimax.io` serves compared with the US West host `api-uw.minimax.io`. Also how the Singapore section's statement squares with the US data center in section 9.
4. Whether the "stateless, does not store user data" statement for speech also covers logging and abuse monitoring.
5. Whether a Workers AI Flux request sends anything to Deepgram, what `mip_opt_out` changes there, and whether opting out costs more on Workers AI.
6. Which Cloudflare location, or which sub-processor (CoreWeave in the US, Nebius in England), handles a given Flux request.

Points 1 to 3 can be asked of MiniMax in writing (api@minimax.io), and point 5 of Cloudflare support. A written answer would replace "not stated" here.

## If MiniMax's terms become a blocker

Only configuration and one adapter change. Every vendor sits behind a port.

- **Text:** set `LLM_PROFILE` to another profile in `src/adapters/llm-profiles.ts`, such as `anthropic-haiku` with `ANTHROPIC_API_KEY`, once that vendor has its section here and the profile is on the visitor allowlist in `src/worker/providers.ts`. Nothing else changes in the brain, protocol, client or Flux.
- **Voice:** write a different `TtsPort` adapter and select it in `src/worker/providers.ts` in place of `createMiniMaxTts`. The voice loop, protocol and client keep working unchanged.

The new vendor then gets its own section in this record before it serves visitors.
