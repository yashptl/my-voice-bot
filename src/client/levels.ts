/**
 * The parts of an AnalyserNode the meter uses. A real AnalyserNode satisfies it; the structural type
 * keeps this file free of DOM types so its tests run in plain Node.
 */
export interface LevelSource {
  fftSize: number;
  smoothingTimeConstant: number;
  readonly frequencyBinCount: number;
  readonly context: { readonly sampleRate: number };
  getByteFrequencyData(array: Uint8Array<ArrayBuffer>): void;
}

const FFT_SIZE = 512;
const SMOOTHING = 0.6;
/** Where speech is: the bands are log-spaced across this range. */
const LOW_HZ = 100;
const HIGH_HZ = 4000;

/**
 * Band levels from one analyser, for the voice view's bars. read() is called every animation frame,
 * so it allocates nothing: the byte buffer is made once, here.
 */
export class Meter {
  private readonly bins: Uint8Array<ArrayBuffer>;

  constructor(private readonly node: LevelSource) {
    node.fftSize = FFT_SIZE;
    node.smoothingTimeConstant = SMOOTHING;
    this.bins = new Uint8Array(node.frequencyBinCount);
  }

  /**
   * Fills `out` with `out.length` levels from 0 to 1, log-spaced from 100 Hz to 4 kHz, each the mean
   * of its FFT bins. Narrow low bands may share a bin.
   */
  read(out: Float32Array): void {
    const bands = out.length;
    if (bands === 0) return;
    const bins = this.bins;
    this.node.getByteFrequencyData(bins);
    const hzPerBin = this.node.context.sampleRate / this.node.fftSize;
    const ratio = HIGH_HZ / LOW_HZ;
    for (let band = 0; band < bands; band++) {
      const from = Math.max(1, Math.round((LOW_HZ * ratio ** (band / bands)) / hzPerBin));
      const to = Math.min(bins.length, Math.max(from + 1, Math.round((LOW_HZ * ratio ** ((band + 1) / bands)) / hzPerBin)));
      let sum = 0;
      for (let i = from; i < to; i++) sum += bins[i] ?? 0;
      out[band] = to > from ? sum / ((to - from) * 255) : 0;
    }
  }
}
