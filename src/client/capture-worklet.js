// Mic capture, running on the audio thread (AudioWorkletGlobalScope). Plain JS with no imports:
// the browser loads this file as-is via audioWorklet.addModule(), from mic.ts's "?url" import.
//
// The context runs at the device's native rate (usually 48 or 44.1 kHz). Each render quantum is
// low-pass filtered, resampled to 16 kHz, converted to Int16 and cut into 80 ms frames
// (1280 samples, 2560 bytes: MIC_FRAME_BYTES), which are transferred to the main thread.
// An input with no channels (file source finished, nothing connected) is captured as silence,
// so frames keep flowing in real time until the main thread sends "stop".

const OUTPUT_RATE = 16000;
const FRAME_SAMPLES = 1280;
const TAPS = 63;
const QUANTUM = 128;

/** Windowed-sinc (Blackman) low-pass FIR, unity gain at DC. `cutoff` is in cycles per input sample. */
function lowPass(cutoff, taps) {
  const h = new Float64Array(taps);
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const x = n - mid;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (taps - 1));
    h[n] = sinc * w;
    sum += h[n];
  }
  for (let n = 0; n < taps; n++) h[n] /= sum;
  return h;
}

export class Downsampler {
  constructor(inputRate, outputRate = OUTPUT_RATE, frameSamples = FRAME_SAMPLES) {
    this.step = inputRate / outputRate;
    // Cut at 90% of the output Nyquist (7.2 kHz for 16 kHz) so nothing above it aliases down.
    this.taps = lowPass((0.45 * Math.min(inputRate, outputRate)) / inputRate, TAPS);
    this.history = new Float64Array(TAPS);
    this.head = 0;
    this.n = 0; // index of the next filtered input sample
    this.prev = 0; // filtered sample n - 1
    this.outCount = 0;
    this.frameSamples = frameSamples;
    this.frame = new Int16Array(frameSamples);
    this.fill = 0;
  }

  push(input) {
    const frames = [];
    const { taps, history } = this;
    for (let i = 0; i < input.length; i++) {
      history[this.head] = input[i];
      let y = 0;
      for (let k = 0, j = this.head; k < TAPS; k++, j = j === 0 ? TAPS - 1 : j - 1) y += taps[k] * history[j];
      this.head = (this.head + 1) % TAPS;

      // Emit every output sample whose position falls in (n - 1, n], interpolating linearly.
      // Positions are outCount * step, computed fresh each time so rounding never accumulates.
      for (let pos = this.outCount * this.step; pos <= this.n; pos = ++this.outCount * this.step) {
        this.emit(this.prev + (y - this.prev) * (pos - (this.n - 1)), frames);
      }
      this.prev = y;
      this.n++;
    }
    return frames;
  }

  emit(sample, frames) {
    const s = Math.max(-1, Math.min(1, sample));
    this.frame[this.fill++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this.fill === this.frameSamples) {
      frames.push(this.frame);
      this.frame = new Int16Array(this.frameSamples);
      this.fill = 0;
    }
  }
}

const SILENCE = new Float32Array(QUANTUM);

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.downsampler = new Downsampler(sampleRate);
    this.running = true;
    this.port.onmessage = (e) => {
      if (e.data === "stop") this.running = false;
    };
  }

  process(inputs) {
    if (!this.running) return false;
    for (const frame of this.downsampler.push(inputs[0]?.[0] ?? SILENCE)) {
      this.port.postMessage(frame.buffer, [frame.buffer]);
    }
    return true;
  }
}

// mic.ts creates the node by this name.
registerProcessor("capture", CaptureProcessor);
