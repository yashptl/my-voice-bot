import { connectWorker } from "../adapters/connect";
import { createFakeLlm } from "../adapters/fake-llm";
import { createFakeTts } from "../adapters/fake-tts";
import { createFluxStt } from "../adapters/flux-stt";
import {
  createLlmFromEnv,
  DEFAULT_LLM_PROFILE,
  isLlmProfileId,
  LLM_PROFILES,
  type LlmProfile,
  type LlmProfileId,
} from "../adapters/llm-profiles";
import { createMiniMaxTts } from "../adapters/minimax-tts";
import type { LlmPort, LlmRequest } from "../ports/llm";
import type { SttPort } from "../ports/stt";
import type { TtsPort } from "../ports/tts";
import { demoMode } from "./config";
import type { Env } from "./env";

export interface DemoReply {
  match: RegExp;
  text: string;
  refs: string[];
  coverage: "direct" | "none";
}

/**
 * What the keyless demo says. Each reply is checked against the real knowledge bundle in the tests;
 * the last one is the fallback. They admit to being scripted, so the demo never passes for the model.
 */
export const DEMO_REPLIES: DemoReply[] = [
  {
    match: /\bamazon\b/i,
    text:
      "At Amazon, Yash was a Software Development Engineer in Toronto from February 2022 to March 2023. " +
      "Yash built full-stack features for high-concurrency systems and cut the on-call ticket queue by 30%.",
    refs: ["role:amazon"],
    coverage: "direct",
  },
  {
    match: /\b(you built|were you|are you|what model|this assistant)\b/i,
    text:
      "Right now I'm running in demo mode, so these answers are scripted rather than written by a language model. " +
      "Normally a MiniMax model answers from Yash's knowledge, and Deepgram Flux on Cloudflare Workers AI turns your speech into text.",
    refs: ["project:assistant"],
    coverage: "direct",
  },
  {
    match: /\b(work|works|working|job|role|current|currently|now)\b/i,
    text:
      "Yash is a Full Stack Developer at Magenta Connect, modernizing an enterprise sales platform. " +
      "There, Yash built an internal AI agent on retrieval-augmented generation and vector search.",
    refs: ["role:magenta"],
    coverage: "direct",
  },
  {
    match: /$^/, // fallback
    text:
      "I'm running in demo mode, so I only have a few scripted answers. " +
      "Try asking where Yash works, or what Yash did at Amazon.",
    refs: [],
    coverage: "none",
  },
];

const WRAPPED = /<visitor_message id="[^"]*">([\s\S]*)<\/visitor_message>/;

/**
 * The visitor's own words from the last turn, without the boundary wrapper. The site's note comes
 * after the closing tag, so the match must not be anchored to the end.
 */
export function visitorText(req: LlmRequest): string {
  const last = req.turns.at(-1)?.text ?? "";
  return WRAPPED.exec(last)?.[1] ?? last;
}

function demoReply(req: LlmRequest): string {
  const question = visitorText(req);
  const r = DEMO_REPLIES.find((d) => d.match.test(question)) ?? DEMO_REPLIES[DEMO_REPLIES.length - 1];
  const meta = { refs: r?.refs ?? [], show: null, contact: false, coverage: r?.coverage ?? "none" };
  return `${r?.text ?? ""}\n<meta>${JSON.stringify(meta)}</meta>`;
}

/** Scripted LLM with a little delay, so the demo streams like the real thing. */
function createDemoLlm(): LlmPort {
  return createFakeLlm({ reply: demoReply, reasoningMs: 200, tokenMs: 10 });
}

/**
 * LLM profiles allowed to see visitor text: a data-handling entry for the vendor in
 * docs/decisions/0002-data-handling.md, and a pass on the redirect gate (G7 in
 * docs/decisions/0001-phase-0-results.md). `anthropic-haiku` has no 0002 entry yet. `minimax-m3`
 * (thinking off) failed G7: it answered "Yes." to a skill that is not in the knowledge, invented
 * growth areas and used the wrong pronoun for Yash. Both run in the probes only (they call the
 * adapters directly, not this function).
 */
const VISITOR_PROFILES: ReadonlySet<string> = new Set<LlmProfileId>(["minimax-flash"]);

/** No MINIMAX_API_KEY and not in demo mode: the Worker is not configured to answer (see config.ts). */
export class NotConfiguredError extends Error {
  constructor() {
    super("not configured: MINIMAX_API_KEY is missing and ASSISTANT_DEMO is not 1");
    this.name = "NotConfiguredError";
  }
}

export interface Providers {
  llm: LlmPort;
  /** The LLM profile's prices, for the cost estimate; null for the demo LLM. */
  prices: LlmProfile["prices"] | null;
  tts: TtsPort;
  stt: SttPort;
  label: string;
}

/**
 * The providers for one conversation. MiniMax LLM (profile from LLM_PROFILE) and MiniMax speech when
 * the key is set (it always wins). Without it, the scripted demo LLM and silent fake speech only when
 * ASSISTANT_DEMO is "1"; otherwise NotConfiguredError. Flux always: Workers AI needs no key. An
 * unknown LLM_PROFILE, or one not cleared for visitors, throws.
 */
export function buildProviders(env: Env): Providers {
  const profile = env.LLM_PROFILE?.trim() || DEFAULT_LLM_PROFILE;
  if (isLlmProfileId(profile) && !VISITOR_PROFILES.has(profile)) {
    throw new Error(
      `LLM_PROFILE ${profile} is for probes only: it is not cleared to see visitor text (needs a vendor entry in docs/decisions/0002-data-handling.md and a pass on G7 in docs/decisions/0001-phase-0-results.md)`,
    );
  }
  const minimaxKey = env.MINIMAX_API_KEY?.trim();
  const real = createLlmFromEnv(env);
  if (!real && !demoMode(env)) throw new NotConfiguredError();
  const llm = real ?? createDemoLlm();
  const tts = minimaxKey
    ? createMiniMaxTts({ apiKey: minimaxKey, voiceId: env.TTS_VOICE, connect: connectWorker })
    : createFakeTts();
  const stt = createFluxStt({ ai: env.AI });
  const llmLabel = real ? `${profile} (${llm.model})` : "fake (demo replies)";
  const prices = real && isLlmProfileId(profile) ? LLM_PROFILES[profile].prices : null;
  return { llm, prices, tts, stt, label: `llm ${llmLabel}, tts ${tts.id}, stt ${stt.id}` };
}
