/**
 * Voice strings the Worker sends and the client matches, kept in one place so both sides use the
 * same text. Zod-free: the browser client imports it at runtime.
 */

/** The `provider` error, without a turn id, sent once when speech output fails mid-answer. */
export const SPEECH_OUTPUT_FAILED = "Speech output failed; the answer continues as text.";

/** Close reasons of the voice socket that the client tells apart. */
export const VOICE_CLOSE = {
  /** Code 1000: no mic audio, client message or answer for VOICE_IDLE_CLOSE_MS. */
  idle: "idle",
  /** Code 1008, after a `limit` error: this conversation used its questions. */
  turnLimit: "turn limit",
  /** Code 1008, after a `limit` error: this conversation used its audio. */
  audioLimit: "audio limit",
  /** Code 1011, after a `provider` error: speech-to-text failed. */
  speechRecognitionFailed: "speech recognition failed",
} as const;
