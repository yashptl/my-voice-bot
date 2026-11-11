// Types for capture-worklet.js, which stays plain JS so the browser can load it as-is with
// audioWorklet.addModule(). Only the tests import it as a module; mic.ts imports its URL.

/** Low-pass filters and resamples to `outputRate`, then cuts Int16 frames of `frameSamples`. */
export declare class Downsampler {
  constructor(inputRate: number, outputRate?: number, frameSamples?: number);
  /** Consumes float samples in [-1, 1]; returns the frames completed by this input (often none). */
  push(input: Float32Array): Int16Array[];
}
