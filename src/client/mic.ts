import { MIC_FRAME_BYTES } from "../protocol/audio";
import { Meter } from "./levels";

/** The live microphone, or a recorded question (any format the browser can decode). */
export type MicSource = "mic" | { file: ArrayBuffer };

export interface Mic {
  stop(): void;
  /** Muted keeps sending frames in real time, zeroed. */
  setMuted(muted: boolean): void;
  /** Fills `out` with the input's band levels, 0 to 1 (muted or not). Allocates nothing. */
  readLevels(out: Float32Array): void;
}

/** Why the mic could not start: refused, not there, or anything else (including the worklet). */
export type MicFailure = "mic_blocked" | "mic_missing" | "mic";

/** Classifies what startMic (or VoiceSession.talk) threw, by the error's name. */
export function micFailure(err: unknown): MicFailure {
  const name = typeof err === "object" && err !== null && "name" in err ? String(err.name) : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "mic_blocked";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "mic_missing";
  return "mic";
}

const workletLoads = new WeakMap<BaseAudioContext, Promise<void>>();

function loadWorklet(context: AudioContext, workletUrl: string): Promise<void> {
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
  // Typed here, not by lib.dom: TypeScript before 6 does not know "all", and hosts that copy this
  // file may compile it with an older lib.dom.
  const constraints: Omit<MediaTrackConstraints, "echoCancellation"> & { echoCancellation?: boolean | "all" } = {
    echoCancellation: chromium ? "all" : true,
    noiseSuppression: true,
  };
  return constraints as MediaTrackConstraints;
}

/**
 * Captures 16 kHz PCM s16le mono in 80 ms frames (MIC_FRAME_BYTES) through the capture worklet.
 * A file source is decoded and played through the same worklet in real time, followed by
 * silence until stop(). `context` should be created and resumed in a user gesture. `workletUrl` is
 * where the host serves capture-worklet.js (same-origin, not a data: URL); the host's bundler
 * resolves it, so this file carries no bundler-specific import.
 */
export async function startMic(o: {
  context: AudioContext;
  source: MicSource;
  workletUrl: string;
  onFrame(frame: ArrayBuffer): void;
}): Promise<Mic> {
  const { context, source } = o;
  // An insecure page has no mediaDevices; say so as the browser says "no microphone".
  if (source === "mic" && !navigator.mediaDevices?.getUserMedia) {
    throw new DOMException("This page cannot use the microphone.", "NotFoundError");
  }
  await loadWorklet(context, o.workletUrl);
  // Open the mic last, so little after it can fail and leave it running.
  // decodeAudioData detaches its argument; copy so the caller can reuse the file.
  const decoded = source === "mic" ? null : await context.decodeAudioData(source.file.slice(0));
  const stream = source === "mic" ? await navigator.mediaDevices.getUserMedia({ audio: micConstraints() }) : null;
  try {
    return capture(context, stream, decoded, o.onFrame);
  } catch (err) {
    // A context closed while the mic prompt was open may refuse new nodes: let go of the mic.
    for (const track of stream?.getTracks() ?? []) track.stop();
    throw err;
  }
}

/** Wires the input through the capture worklet, with a level meter on the side. */
function capture(
  context: AudioContext,
  stream: MediaStream | null,
  decoded: AudioBuffer | null,
  onFrame: (frame: ArrayBuffer) => void,
): Mic {
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
    if (!stopped) onFrame(muted ? new ArrayBuffer(MIC_FRAME_BYTES) : e.data);
  };

  let input: MediaStreamAudioSourceNode | AudioBufferSourceNode;
  if (stream) {
    input = context.createMediaStreamSource(stream);
  } else {
    input = context.createBufferSource();
    input.buffer = decoded;
  }
  input.connect(node);
  // A side branch for the level bars; it need not reach the destination.
  const analyser = context.createAnalyser();
  input.connect(analyser);
  const meter = new Meter(analyser);
  // The worklet writes no output; connecting it to the destination just guarantees every
  // browser keeps calling process().
  node.connect(context.destination);
  if (input instanceof AudioBufferSourceNode) input.start();

  return {
    setMuted(m) {
      muted = m;
    },
    readLevels(out) {
      meter.read(out);
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
