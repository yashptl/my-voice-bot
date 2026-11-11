import type { TtsPort, TtsSession } from "../ports/tts";
import type { Connect } from "../ports/websocket";
import { VOICE_FORMAT } from "../protocol/audio";

export const MINIMAX_TTS_URL = "wss://api.minimax.io/ws/v1/t2a_v2";
export const MINIMAX_TTS_MODEL = "speech-2.8-turbo";
const OPEN_TIMEOUT_MS = 10_000;

export type MiniMaxTtsOptions = {
  apiKey: string;
  voiceId: string;
  /** Default `speech-2.8-turbo`. */
  model?: string;
  /** Default `wss://api.minimax.io/ws/v1/t2a_v2`. */
  url?: string;
  connect: Connect;
  /** MiniMax `pronunciation_dict.tone` entries, e.g. `"Yash/yaash"`. */
  pronunciation?: string[];
  /** Limit on connected_success → task_started; default 10 000. */
  openTimeoutMs?: number;
};

/** The `task_start` frame. `t2a_v2` and `t2a_v2_bidi` accept the same one. */
export function miniMaxTaskStart(o: { voiceId: string; model?: string; pronunciation?: string[] }): Record<string, unknown> {
  return {
    event: "task_start",
    model: o.model ?? MINIMAX_TTS_MODEL,
    voice_setting: { voice_id: o.voiceId },
    audio_setting: { sample_rate: VOICE_FORMAT.sampleRate, format: "pcm", channel: VOICE_FORMAT.channels },
    language_boost: "English",
    ...(o.pronunciation?.length ? { pronunciation_dict: { tone: o.pronunciation } } : {}),
  };
}

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

/** `task_failed`, or any frame whose `base_resp.status_code` is non-zero. */
function failureOf(f: Frame): Error | null {
  const code = f.base_resp?.status_code;
  if (f.event !== "task_failed" && (code === undefined || code === 0)) return null;
  const detail = (f.base_resp?.status_msg ?? "").slice(0, 200);
  return new Error(`MiniMax TTS failed (status ${code ?? "unknown"})${detail ? `: ${detail}` : ""}`);
}

function nibble(c: number): number {
  if (c >= 48 && c <= 57) return c - 48; // 0-9
  if (c >= 97 && c <= 102) return c - 87; // a-f
  if (c >= 65 && c <= 70) return c - 55; // A-F
  return -1;
}

/** Decodes hex audio, prefixed with a held-over byte; returns exactly the bytes. */
function decodeHex(hex: string, prefix: number | null): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("MiniMax TTS sent malformed hex audio (odd length)");
  const offset = prefix === null ? 0 : 1;
  const out = new Uint8Array(offset + hex.length / 2);
  if (prefix !== null) out[0] = prefix;
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const hi = nibble(hex.charCodeAt(i));
    const lo = nibble(hex.charCodeAt(i + 1));
    if (hi < 0 || lo < 0) throw new Error("MiniMax TTS sent malformed hex audio");
    out[offset + i / 2] = (hi << 4) | lo;
  }
  return out;
}

const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/**
 * MiniMax speech over the plain `t2a_v2` WebSocket: one socket per reply, one `task_continue` per
 * sentence, the next sentence only after the previous one's `is_final: true`, so every audio chunk
 * belongs to exactly one sentence. Cancel = close (t2a_v2 has no task_cancel).
 *
 * Errors after open go to `onError` once; `finish()` then resolves (it never rejects).
 * `onAudio` always gets whole 16-bit samples: an odd trailing byte waits for the next chunk.
 */
export function createMiniMaxTts(o: MiniMaxTtsOptions): TtsPort {
  const url = o.url ?? MINIMAX_TTS_URL;
  const openTimeoutMs = o.openTimeoutMs ?? OPEN_TIMEOUT_MS;

  return {
    id: "minimax-speech",
    format: VOICE_FORMAT,
    async open(cb): Promise<TtsSession> {
      const socket = await o.connect(url, { Authorization: `Bearer ${o.apiKey}` });

      return new Promise<TtsSession>((resolve, reject) => {
        let phase: "connecting" | "starting" | "open" | "closed" = "connecting";
        const queue: { id: number; text: string }[] = [];
        let current: { id: number; carry: number | null } | null = null;
        let finishing = false;
        let finishSent = false;
        let resolveFinished!: () => void;
        const finished = new Promise<void>((r) => (resolveFinished = r));

        const end = () => {
          phase = "closed";
          clearTimeout(timer);
          queue.length = 0;
          current = null;
          resolveFinished();
          try {
            socket.close(1000, "done");
          } catch {
            // Already closed.
          }
        };

        const fail = (e: Error) => {
          if (phase === "closed") return;
          const wasOpen = phase === "open";
          end();
          if (wasOpen) cb.onError(e);
          else reject(e);
        };

        const timer = setTimeout(
          () => fail(new Error(`MiniMax TTS handshake timed out after ${openTimeoutMs} ms`)),
          openTimeoutMs,
        );

        const send = (msg: Record<string, unknown>) => {
          try {
            socket.send(JSON.stringify(msg));
          } catch (e) {
            fail(asError(e));
          }
        };

        const pump = () => {
          if (phase !== "open" || current) return;
          const next = queue.shift();
          if (next) {
            current = { id: next.id, carry: null };
            send({ event: "task_continue", text: next.text });
          } else if (finishing && !finishSent) {
            finishSent = true;
            send({ event: "task_finish" });
          }
        };

        const onContinued = (f: Frame) => {
          const s = current;
          if (!s) return;
          const hex = f.data?.audio;
          if (hex) {
            let pcm = decodeHex(hex, s.carry);
            s.carry = null;
            if (pcm.byteLength % 2 !== 0) {
              s.carry = pcm[pcm.byteLength - 1] ?? 0;
              pcm = pcm.slice(0, -1);
            }
            if (pcm.byteLength > 0) cb.onAudio(s.id, pcm);
          }
          if (f.is_final === true && current === s) {
            current = null; // a trailing odd byte is dropped with the sentence
            cb.onSentenceDone(s.id);
            pump();
          }
        };

        const session: TtsSession = {
          speak(id, text) {
            if (phase !== "open" || finishing) return;
            queue.push({ id, text });
            pump();
          },
          finish() {
            if (phase === "open" && !finishing) {
              finishing = true;
              pump();
            }
            return finished;
          },
          cancel: end,
        };

        socket.addEventListener("message", (e: { data?: unknown }) => {
          if (phase === "closed") return;
          const f = parseFrame(e?.data);
          if (!f) return;
          try {
            const failure = failureOf(f);
            if (failure) return fail(failure);
            switch (f.event) {
              case "connected_success":
                if (phase === "connecting") {
                  phase = "starting";
                  send(miniMaxTaskStart(o));
                }
                return;
              case "task_started":
                if (phase === "starting") {
                  phase = "open";
                  clearTimeout(timer);
                  resolve(session);
                }
                return;
              case "task_finished":
                return end();
              default:
                // The docs' task_continued example carries no `event`, so match on shape too.
                if (phase === "open" && (f.data !== undefined || f.is_final !== undefined)) onContinued(f);
            }
          } catch (err) {
            fail(asError(err));
          }
        });

        socket.addEventListener("close", (e: { code?: number }) => {
          if (phase === "closed") return;
          if (finishSent) return end(); // t2a_v2 may close straight after task_finish
          fail(new Error(`MiniMax TTS socket closed (code ${e?.code ?? "unknown"})`));
        });

        socket.addEventListener("error", (e: { message?: string }) => {
          fail(new Error(`MiniMax TTS socket error${e?.message ? `: ${e.message}` : ""}`));
        });
      });
    },
  };
}
