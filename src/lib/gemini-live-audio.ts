// Gemini Live carries raw PCM through the harness: 16-bit little-endian mono, 16 kHz up and 24 kHz down.
export const INPUT_RATE = 16_000;
export const OUTPUT_RATE = 24_000;
const FRAME_SAMPLES = 800;
const MAX_SOCKET_BUFFER = 256 * 1024;
const PLAYBACK_LEAD_S = 0.05;

export interface GeminiMediaEvents {
  onOpen(): void;
  onEvent(event: { type?: unknown; delta?: unknown }): void;
  onClose(): void;
  onPlaybackBlocked(): void;
  onPlaybackResumed(): void;
}

export interface GeminiMediaLink {
  /** Asks the harness to end the call; the socket stays open for its answer. */
  hangUp(): void;
  close(): void;
}

/** Resamples to 16 kHz inside the worklet: a context at the microphone's own rate works in every browser. */
const CAPTURE_WORKLET = `
class OmbPcm16 extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / ${INPUT_RATE};
    this.at = 0;
    this.frame = new Int16Array(${FRAME_SAMPLES});
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (; this.at < channel.length; this.at += this.step) {
      const value = Math.max(-1, Math.min(1, channel[Math.floor(this.at)]));
      this.frame[this.filled++] = value < 0 ? value * 0x8000 : value * 0x7fff;
      if (this.filled === this.frame.length) {
        this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
        this.frame = new Int16Array(${FRAME_SAMPLES});
        this.filled = 0;
      }
    }
    this.at -= channel.length;
    return true;
  }
}
registerProcessor("omb-pcm16", OmbPcm16);
`;

export function pcm16ToFloat32(data: ArrayBuffer): Float32Array<ArrayBuffer> {
  const samples = new Int16Array(data, 0, Math.floor(data.byteLength / 2));
  const out = new Float32Array(new ArrayBuffer(samples.length * 4));
  for (let i = 0; i < samples.length; i++) out[i] = samples[i]! / 0x8000;
  return out;
}

export function openGeminiMedia(url: string, stream: MediaStream, events: GeminiMediaEvents): GeminiMediaLink {
  let closed = false;
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const capture = new AudioContext();
  const playback = new AudioContext({ sampleRate: OUTPUT_RATE });
  const playing = new Set<AudioBufferSourceNode>();
  let playhead = 0;
  let source: MediaStreamAudioSourceNode | null = null;
  let worklet: AudioWorkletNode | null = null;
  let stopGestureWait: (() => void) | null = null;

  const workletUrl = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "text/javascript" }));
  void capture.audioWorklet.addModule(workletUrl).then(() => {
    URL.revokeObjectURL(workletUrl);
    if (closed) return;
    source = capture.createMediaStreamSource(stream);
    worklet = new AudioWorkletNode(capture, "omb-pcm16");
    worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < MAX_SOCKET_BUFFER) socket.send(event.data);
    };
    source.connect(worklet);
  }, () => {
    URL.revokeObjectURL(workletUrl);
    if (!closed) events.onClose();
  });

  const play = (data: ArrayBuffer) => {
    const samples = pcm16ToFloat32(data);
    if (!samples.length) return;
    const buffer = playback.createBuffer(1, samples.length, OUTPUT_RATE);
    buffer.copyToChannel(samples, 0);
    const node = playback.createBufferSource();
    node.buffer = buffer;
    node.connect(playback.destination);
    playhead = Math.max(playhead, playback.currentTime + PLAYBACK_LEAD_S);
    node.start(playhead);
    playhead += buffer.duration;
    playing.add(node);
    node.onended = () => playing.delete(node);
  };

  const flush = () => {
    for (const node of playing) {
      try { node.stop(); } catch {}
    }
    playing.clear();
    playhead = 0;
  };

  /** Autoplay may keep the output suspended until the next click or key press. */
  const resumeOutput = () => {
    void playback.resume().catch(() => undefined).then(() => {
      if (closed || playback.state === "running") {
        if (stopGestureWait) {
          stopGestureWait();
          stopGestureWait = null;
          events.onPlaybackResumed();
        }
        return;
      }
      if (stopGestureWait || !globalThis.document) return;
      events.onPlaybackBlocked();
      const retry = () => resumeOutput();
      document.addEventListener("pointerdown", retry, true);
      document.addEventListener("keydown", retry, true);
      stopGestureWait = () => {
        document.removeEventListener("pointerdown", retry, true);
        document.removeEventListener("keydown", retry, true);
      };
    });
  };
  resumeOutput();
  void capture.resume().catch(() => undefined);

  socket.onopen = () => {
    if (!closed) events.onOpen();
  };
  socket.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
    if (closed) return;
    if (event.data instanceof ArrayBuffer) return play(event.data);
    let parsed: { type?: unknown; delta?: unknown };
    try {
      parsed = JSON.parse(event.data) as typeof parsed;
    } catch {
      return;
    }
    if (parsed.type === "output.interrupted") flush();
    else events.onEvent(parsed);
  };
  socket.onclose = () => {
    if (!closed) events.onClose();
  };

  return {
    hangUp() {
      if (socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({ type: "session.close" })); } catch {}
      }
    },
    close() {
      if (closed) return;
      closed = true;
      stopGestureWait?.();
      stopGestureWait = null;
      flush();
      if (worklet) worklet.port.onmessage = null;
      try { source?.disconnect(); } catch {}
      try { worklet?.disconnect(); } catch {}
      void capture.close().catch(() => undefined);
      void playback.close().catch(() => undefined);
      try { socket.close(1000, "call ended"); } catch {}
    },
  };
}
