/**
 * TTS probe: time to first audio on MiniMax `t2a_v2` (through the production adapter) versus
 * `t2a_v2_bidi` (raw, one `task_flush` per sentence), plus the event shapes Phase 0 must confirm.
 *
 *   npm run probe:tts -- [--runs 10] [--voice English_FriendlyPerson] [--label local]
 *                        [--base wss://api.minimax.io/ws/v1] [--out probes/results]
 *
 * Writes <out>/tts-<date>-<label>.json (raw event timelines + summaries) and <out>/tts-sample.wav.
 * Without MINIMAX_API_KEY (in .dev.vars or the environment) it prints a note and exits 0.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { connectNode } from "../src/adapters/connect";
import { MINIMAX_TTS_MODEL, createMiniMaxTts, miniMaxTaskStart } from "../src/adapters/minimax-tts";
import type { Connect, SocketLike } from "../src/ports/websocket";
import { VOICE_FORMAT } from "../src/protocol/audio";
import { loadDevVars } from "./lib/env";
import { summarize, type Summary } from "./lib/stats";
import { pcmToWav } from "./lib/wav";

const SENTENCES = [
  "Yash builds interfaces people enjoy.",
  "At Amazon, Yash owned full-stack features, on-call rotations, and the telemetry that kept them healthy.",
  "Want to hear more?",
];
const ENDPOINTS = ["t2a_v2", "t2a_v2_bidi"] as const;
type Endpoint = (typeof ENDPOINTS)[number];
const RUN_TIMEOUT_MS = 30_000;
const PAUSE_BETWEEN_RUNS_MS = 1_000; // stay well under the T2A rate limit
const G4_FIRST_AUDIO_P50_MS = 400;

/** One frame on the wire. Text and audio content are never stored, only names, flags and sizes. */
type WireEvent = {
  dir: "out" | "in";
  event: string;
  ms: number;
  isFinal?: boolean;
  audioBytes?: number;
  statusCode?: number;
};

type SentenceStats = {
  firstAudioMs: number | null;
  audioBytes: number;
  chunks: number;
  oddChunks: number;
  isFinals: number;
  finalAudioBytes: number;
  sentenceStarts: number;
  sentenceEnds: number;
};

type RunRecord = {
  run: number;
  ok: boolean;
  error: string | null;
  connectToStartedMs: number | null;
  sentences: SentenceStats[];
  timeline: WireEvent[];
};

type Frame = {
  event?: string;
  data?: { audio?: string } | null;
  is_final?: boolean;
  base_resp?: { status_code?: number; status_msg?: string };
};

function parseFrame(data: unknown): Frame | null {
  if (typeof data !== "string") return null;
  try {
    const value: unknown = JSON.parse(data);
    return value !== null && typeof value === "object" ? (value as Frame) : null;
  } catch {
    return null;
  }
}

function frameFailure(f: Frame): Error | null {
  const code = f.base_resp?.status_code;
  if (f.event !== "task_failed" && (code === undefined || code === 0)) return null;
  return new Error(`MiniMax TTS failed (status ${code ?? "unknown"}): ${(f.base_resp?.status_msg ?? "").slice(0, 200)}`);
}

function describeIn(data: unknown, ms: number): WireEvent {
  const f = parseFrame(data);
  if (!f) return { dir: "in", event: typeof data === "string" ? "non-json" : "binary", ms };
  const shaped = f.data !== undefined || f.is_final !== undefined;
  const e: WireEvent = { dir: "in", event: f.event ?? (shaped ? "task_continued" : "unknown"), ms };
  if (f.is_final !== undefined) e.isFinal = f.is_final;
  if (typeof f.data?.audio === "string") e.audioBytes = f.data.audio.length / 2;
  const code = f.base_resp?.status_code;
  if (code !== undefined && code !== 0) e.statusCode = code;
  return e;
}

function describeOut(data: string | ArrayBuffer, ms: number): WireEvent {
  return { dir: "out", event: parseFrame(data)?.event ?? "unknown", ms };
}

type RunContext = { t0: number; timeline: WireEvent[]; sockets: SocketLike[] };

/** Wraps a Connect so every frame in both directions lands on the run's timeline. */
function tapped(connect: Connect, ctx: RunContext): Connect {
  const ms = () => Math.round((performance.now() - ctx.t0) * 10) / 10;
  return async (url, headers) => {
    const socket = await connect(url, headers);
    ctx.sockets.push(socket);
    socket.addEventListener("message", (e: { data?: unknown }) => ctx.timeline.push(describeIn(e?.data, ms())));
    socket.addEventListener("close", (e: { code?: number }) =>
      ctx.timeline.push({ dir: "in", event: `close ${e?.code ?? "?"}`, ms: ms() }),
    );
    return {
      send(data) {
        ctx.timeline.push(describeOut(data, ms()));
        socket.send(data);
      },
      close: (code, reason) => socket.close(code, reason),
      addEventListener: (type, fn) => socket.addEventListener(type, fn),
    };
  };
}

type Settings = { apiKey: string; voiceId: string; base: string };

/** `t2a_v2` through the production adapter: next sentence after the previous `is_final`. */
async function runPlain(s: Settings, ctx: RunContext): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let failure: Error | null = null;
  const tts = createMiniMaxTts({
    apiKey: s.apiKey,
    voiceId: s.voiceId,
    url: `${s.base}/t2a_v2`,
    connect: tapped(connectNode, ctx),
  });
  const session = await tts.open({
    onAudio: (_id, pcm) => chunks.push(pcm),
    onSentenceDone: () => {},
    onError: (e) => (failure ??= e),
  });
  SENTENCES.forEach((text, id) => session.speak(id, text));
  await session.finish();
  if (failure) throw failure;
  const pcm = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    pcm.set(c, at);
    at += c.byteLength;
  }
  return pcm;
}

/** `t2a_v2_bidi`, raw: each sentence is `task_continue` + `task_flush`; the next goes after `task_flushed`. */
async function runBidi(s: Settings, ctx: RunContext): Promise<void> {
  const socket = await tapped(connectNode, ctx)(`${s.base}/t2a_v2_bidi`, { Authorization: `Bearer ${s.apiKey}` });
  await new Promise<void>((done, fail) => {
    let next = 0;
    const send = (msg: Record<string, unknown>) => socket.send(JSON.stringify(msg));
    const sendSentence = () => {
      send({ event: "task_continue", text: SENTENCES[next] });
      send({ event: "task_flush" });
      next++;
    };
    socket.addEventListener("message", (e: { data?: unknown }) => {
      const f = parseFrame(e?.data);
      if (!f) return;
      const failure = frameFailure(f);
      if (failure) {
        socket.close(1000);
        return fail(failure);
      }
      if (f.event === "connected_success") send(miniMaxTaskStart({ voiceId: s.voiceId }));
      else if (f.event === "task_started") sendSentence();
      else if (f.event === "task_flushed") {
        if (next < SENTENCES.length) sendSentence();
        else send({ event: "task_finish" });
      } else if (f.event === "task_finished") {
        socket.close(1000);
        done();
      }
    });
    socket.addEventListener("close", (e: { code?: number }) => fail(new Error(`socket closed (code ${e?.code ?? "?"})`)));
    socket.addEventListener("error", (e: { message?: string }) => fail(new Error(`socket error ${e?.message ?? ""}`)));
  });
}

/** Splits a timeline at each outgoing `task_continue` and measures each sentence's window. */
function analyze(timeline: WireEvent[]): { connectToStartedMs: number | null; sentences: SentenceStats[] } {
  const started = timeline.find((e) => e.dir === "in" && e.event === "task_started");
  const starts = timeline.flatMap((e, i) => (e.dir === "out" && e.event === "task_continue" ? [i] : []));
  const sentences = starts.map((from, k) => {
    const sent = timeline[from]?.ms ?? 0;
    const window = timeline.slice(from + 1, starts[k + 1] ?? timeline.length).filter((e) => e.dir === "in");
    const audio = window.filter((e) => (e.audioBytes ?? 0) > 0);
    const finals = window.filter((e) => e.isFinal === true);
    const firstAudio = audio[0];
    return {
      firstAudioMs: firstAudio ? Math.round((firstAudio.ms - sent) * 10) / 10 : null,
      audioBytes: audio.reduce((n, e) => n + (e.audioBytes ?? 0), 0),
      chunks: audio.length,
      oddChunks: audio.filter((e) => (e.audioBytes ?? 0) % 2 !== 0).length,
      isFinals: finals.length,
      finalAudioBytes: finals.reduce((n, e) => n + (e.audioBytes ?? 0), 0),
      sentenceStarts: window.filter((e) => e.event === "sentence_start").length,
      sentenceEnds: window.filter((e) => e.event === "sentence_end").length,
    };
  });
  return { connectToStartedMs: started?.ms ?? null, sentences };
}

function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`timed out after ${ms} ms`));
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (x: number) => (Number.isFinite(x) ? `${Math.round(x)}` : "-");
const pair = (s: Summary) => `${fmt(s.p50)} / ${fmt(s.p95)} ms`;

type EndpointSummary = {
  okRuns: number;
  connectToStarted: Summary;
  firstAudio: Summary;
  firstAudioBySentence: Summary[];
  sentences: number;
  /** t2a_v2: exactly one `is_final` per sentence (G4). */
  oneIsFinal: number;
  /** t2a_v2: the `is_final` frame itself carries audio (the adapter forwards it). */
  finalCarriesAudio: number;
  /** ...and that audio is as long as all earlier chunks together, i.e. a repeat of the sentence. */
  finalRepeatsAudio: number;
  oddChunks: number;
  /** bidi: exactly one `sentence_start`/`sentence_end` pair per flushed sentence. */
  onePairPerSentence: number;
};

function summarizeEndpoint(records: RunRecord[]): EndpointSummary {
  const ok = records.filter((r) => r.ok);
  const sentences = ok.flatMap((r) => r.sentences);
  const where = (test: (s: SentenceStats) => boolean) => sentences.filter(test).length;
  return {
    okRuns: ok.length,
    connectToStarted: summarize(ok.map((r) => r.connectToStartedMs ?? Number.NaN)),
    firstAudio: summarize(sentences.map((s) => s.firstAudioMs ?? Number.NaN)),
    firstAudioBySentence: SENTENCES.map((_, i) => summarize(ok.map((r) => r.sentences[i]?.firstAudioMs ?? Number.NaN))),
    sentences: sentences.length,
    oneIsFinal: where((s) => s.isFinals === 1),
    finalCarriesAudio: where((s) => s.finalAudioBytes > 0),
    finalRepeatsAudio: where((s) => s.finalAudioBytes > 0 && s.finalAudioBytes * 2 === s.audioBytes),
    oddChunks: sentences.reduce((n, s) => n + s.oddChunks, 0),
    onePairPerSentence: where((s) => s.sentenceStarts === 1 && s.sentenceEnds === 1),
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      runs: { type: "string", default: "10" },
      voice: { type: "string" },
      label: { type: "string", default: "local" },
      base: { type: "string", default: "wss://api.minimax.io/ws/v1" },
      out: { type: "string", default: resolve(import.meta.dirname, "results") },
    },
  });
  const vars = loadDevVars();
  const apiKey = vars.MINIMAX_API_KEY;
  if (!apiKey) {
    console.log("MINIMAX_API_KEY not set; skipped");
    return 0;
  }
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  const label = values.label.replace(/[^a-z0-9-]+/gi, "-");
  const settings: Settings = {
    apiKey,
    voiceId: values.voice ?? vars.TTS_VOICE ?? "English_FriendlyPerson",
    base: values.base.replace(/\/+$/, ""),
  };

  const records: Record<Endpoint, RunRecord[]> = { t2a_v2: [], t2a_v2_bidi: [] };
  let sample: Uint8Array | null = null;
  for (let run = 1; run <= runs; run++) {
    const order = run % 2 === 1 ? ENDPOINTS : [...ENDPOINTS].reverse(); // alternate who goes first
    for (const endpoint of order) {
      const ctx: RunContext = { t0: performance.now(), timeline: [], sockets: [] };
      let error: string | null = null;
      try {
        const work: Promise<Uint8Array | null> =
          endpoint === "t2a_v2" ? runPlain(settings, ctx) : runBidi(settings, ctx).then(() => null);
        const pcm = await withTimeout(work, RUN_TIMEOUT_MS, () => ctx.sockets.forEach((s) => s.close(1000)));
        sample ??= pcm;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      records[endpoint].push({ run, ok: error === null, error, ...analyze(ctx.timeline), timeline: ctx.timeline });
      console.log(`run ${run}/${runs} ${endpoint}: ${error ?? "ok"}`);
    }
    if (run < runs) await sleep(PAUSE_BETWEEN_RUNS_MS);
  }

  const summaries: Record<Endpoint, EndpointSummary> = {
    t2a_v2: summarizeEndpoint(records.t2a_v2),
    t2a_v2_bidi: summarizeEndpoint(records.t2a_v2_bidi),
  };

  mkdirSync(values.out, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const resultsPath = resolve(values.out, `tts-${date}-${label}.json`);
  const results = {
    probe: "tts",
    date,
    label,
    base: settings.base,
    model: MINIMAX_TTS_MODEL,
    voice: settings.voiceId,
    runs,
    sentences: SENTENCES,
    endpoints: Object.fromEntries(ENDPOINTS.map((e) => [e, { summary: summaries[e], runs: records[e] }])),
  };
  writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  const samplePath = resolve(values.out, "tts-sample.wav");
  if (sample) writeFileSync(samplePath, pcmToWav(sample, VOICE_FORMAT));

  console.log(`\nTTS probe: ${label}, voice ${settings.voiceId}, ${runs} runs, ${settings.base}`);
  console.log("endpoint       ok      connect→task_started   task_continue→first audio   p50 by sentence");
  for (const endpoint of ENDPOINTS) {
    const s = summaries[endpoint];
    const bySentence = s.firstAudioBySentence.map((x) => fmt(x.p50)).join(", ");
    console.log(
      `${endpoint.padEnd(14)} ${`${s.okRuns}/${runs}`.padEnd(7)} ${pair(s.connectToStarted).padEnd(22)} ${pair(s.firstAudio).padEnd(27)} [${bySentence}] ms`,
    );
  }
  const plain = summaries.t2a_v2;
  const bidi = summaries.t2a_v2_bidi;
  console.log(
    `t2a_v2: exactly one is_final in ${plain.oneIsFinal}/${plain.sentences} sentences; ` +
      `is_final frame carries audio in ${plain.finalCarriesAudio}/${plain.sentences}, ` +
      `repeats the sentence's audio in ${plain.finalRepeatsAudio}/${plain.sentences}; odd-length chunks: ${plain.oddChunks}`,
  );
  console.log(
    `t2a_v2_bidi: exactly one sentence_start/sentence_end pair in ${bidi.onePairPerSentence}/${bidi.sentences} flushed sentences`,
  );
  const p50 = plain.firstAudio.p50;
  console.log(
    `G4 t2a_v2 p50 first audio ${fmt(p50)} ms (target ≤ ${G4_FIRST_AUDIO_P50_MS} ms): ${
      Number.isFinite(p50) ? (p50 <= G4_FIRST_AUDIO_P50_MS ? "PASS" : "FAIL") : "no data"
    }`,
  );
  const shown = (p: string) => (relative(process.cwd(), p).startsWith("..") ? p : relative(process.cwd(), p));
  console.log(`results: ${shown(resultsPath)}${sample ? `, sample: ${shown(samplePath)}` : ""}`);
  return ENDPOINTS.every((e) => summaries[e].okRuns > 0) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`tts probe failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
