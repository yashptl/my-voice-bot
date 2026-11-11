import { MIC_FRAME_BYTES } from "../protocol/audio";
// no-inline: a small file would otherwise become a data: URL; the worklet must load same-origin.
import workletUrl from "./capture-worklet.js?url&no-inline";

/** The live microphone, or a recorded question (any format the browser can decode). */
export type MicSource = "mic" | { file: ArrayBuffer };

export interface Mic {
  stop(): void;
  /** Muted keeps sending frames in real time, zeroed. */
  setMuted(muted: boolean): void;
}

const workletLoads = new WeakMap<BaseAudioContext, Promise<void>>();

function loadWorklet(context: AudioContext): Promise<void> {
  let load = workletLoads.get(context);
  if (!load) {
    load = context.audioWorklet.addModule(workletUrl);
    workletLoads.set(context, load);
  }
  return load;
}

function micConstraints(): MediaTrackConstraints {
  // Only Chromium exposes userAgentData. Chrome/Edge 141+ take "all" (cancel all system audio, not
  // just this page's); older Chromium reads the string as true.
  const chromium = "userAgentData" in navigator;
  return { echoCancellation: chromium ? "all" : true, noiseSuppression: true };
}

/**
 * Captures 16 kHz PCM s16le mono in 80 ms frames (MIC_FRAME_BYTES) through the capture worklet.
 * A file source is decoded and played through the same worklet in real time, followed by
 * silence until stop(). `context` should be created and resumed in a user gesture.
 */
export async function startMic(o: {
  context: AudioContext;
  source: MicSource;
  onFrame(frame: ArrayBuffer): void;
}): Promise<Mic> {
  const { context, source } = o;
  await loadWorklet(context);
  // Open the mic last, so nothing after it can fail and leave it running.
  // decodeAudioData detaches its argument; copy so the caller can reuse the file.
  const decoded = source === "mic" ? null : await context.decodeAudioData(source.file.slice(0));
  const stream = source === "mic" ? await navigator.mediaDevices.getUserMedia({ audio: micConstraints() }) : null;

  const node = new AudioWorkletNode(context, "capture", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: "explicit", // downmix stereo input to mono
  });
  let muted = false;
  let stopped = false;
  node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    if (!stopped) o.onFrame(muted ? new ArrayBuffer(MIC_FRAME_BYTES) : e.data);
  };

  let input: MediaStreamAudioSourceNode | AudioBufferSourceNode;
  if (stream) {
    input = context.createMediaStreamSource(stream);
  } else {
    input = context.createBufferSource();
    input.buffer = decoded;
  }
  input.connect(node);
  // The worklet writes no output; connecting it to the destination just guarantees every
  // browser keeps calling process().
  node.connect(context.destination);
  if (input instanceof AudioBufferSourceNode) input.start();

  return {
    setMuted(m) {
      muted = m;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      node.port.postMessage("stop");
      node.port.onmessage = null;
      node.port.close();
      if (input instanceof AudioBufferSourceNode) input.stop();
      input.disconnect();
      node.disconnect();
      for (const track of stream?.getTracks() ?? []) track.stop();
    },
  };
}
