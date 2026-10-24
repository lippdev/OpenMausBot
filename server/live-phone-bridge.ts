// The phone apps start a Live call with a GPT-Live WebRTC offer. On Gemini Live the harness answers that offer itself and
// relays the call's audio to the Gemini bridge, so the phone never learns which voice it is talking to.
import OpusScript from "opusscript";
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, RtpHeader, RtpPacket, type RTCDataChannel, type RTCRtpTransceiver } from "werift";
import { GEMINI_INPUT_RATE, type MediaPeer } from "./gemini-live.ts";
import { LiveSessionError } from "./live-call.ts";

/** WebRTC carries Opus at 48 kHz; a frame is 20 ms. */
const RTP_RATE = 48_000;
const FRAME_SAMPLES = 960;
const FRAME_MS = 20;
const GATHER_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 20_000;
/** Two Opus frames (40 ms at 16 kHz) per append keeps Gemini's message rate near 25 a second. */
const INPUT_BATCH_BYTES = 2 * (GEMINI_INPUT_RATE / 1000) * FRAME_MS * 2;
/** Longer than any spoken answer; beyond it the oldest audio is dropped rather than held without bound. */
const MAX_QUEUED_FRAMES = (180 * 1000) / FRAME_MS;

export interface PhoneBridgeConfig {
  publicAddress: string;
  portRange: [number, number];
}

export const PHONE_BRIDGE_NOT_CONFIGURED =
  "Gemini Live calls from the phone apps need this server's public IP and UDP ports (OMB_LIVE_PUBLIC_IP and OMB_LIVE_UDP_PORTS). Until then, call from the desktop app or a web browser.";

/** Null when the server has no public address for phone audio. */
export function phoneBridgeConfig(env: NodeJS.ProcessEnv = process.env): PhoneBridgeConfig | null {
  const address = env.OMB_LIVE_PUBLIC_IP?.trim() ?? "";
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address) || address.split(".").some((part) => Number(part) > 255)) return null;
  const range = /^(\d{1,5})-(\d{1,5})$/.exec(env.OMB_LIVE_UDP_PORTS?.trim() || "40000-40009");
  const low = Number(range?.[1]);
  const high = Number(range?.[2]);
  if (!range || low < 1024 || high > 65535 || high < low) return null;
  return { publicAddress: address, portRange: [low, high] };
}

/** 48 kHz → 16 kHz by averaging each run of three samples. */
export function downsample48to16(pcm: Buffer): Buffer {
  const frames = Math.floor(pcm.length / 6);
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const sum = pcm.readInt16LE(i * 6) + pcm.readInt16LE(i * 6 + 2) + pcm.readInt16LE(i * 6 + 4);
    out.writeInt16LE(Math.round(sum / 3), i * 2);
  }
  return out;
}

/** 24 kHz → 48 kHz by linear interpolation; `previous` is the last sample of the chunk before. */
export function upsample24to48(pcm: Buffer, previous: number): { pcm: Buffer; last: number } {
  const count = Math.floor(pcm.length / 2);
  const out = Buffer.alloc(count * 4);
  let last = previous;
  for (let i = 0; i < count; i++) {
    const sample = pcm.readInt16LE(i * 2);
    out.writeInt16LE(Math.round((last + sample) / 2), i * 4);
    out.writeInt16LE(sample, i * 4 + 2);
    last = sample;
  }
  return { pcm: out, last };
}

export interface PhoneMediaHandlers {
  audio(pcm16k: Buffer): void;
  event(text: string): void;
  closed(): void;
}

/** The phone's side of one call, as a media peer of the Gemini bridge. */
export class PhoneMediaPeer implements MediaPeer {
  readonly bufferedAmount = 0;
  private readonly pc: RTCPeerConnection;
  private readonly handlers: PhoneMediaHandlers;
  private transceiver: RTCRtpTransceiver | null = null;
  private channel: RTCDataChannel | null = null;
  private readonly pendingEvents: string[] = [];
  private readonly decoder = new OpusScript(RTP_RATE, 1, OpusScript.Application.VOIP, { wasm: false });
  private readonly encoder = new OpusScript(RTP_RATE, 1, OpusScript.Application.VOIP, { wasm: false });
  private inputBatch: Buffer[] = [];
  private inputBytes = 0;
  private outputCarry = Buffer.alloc(0);
  private lastOutputSample = 0;
  private readonly frames: Buffer[] = [];
  private sequence = Math.floor(Math.random() * 65_536);
  private timestamp = Math.floor(Math.random() * 2 ** 32);
  private pacingStart = 0;
  private framesSent = 0;
  private pacer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(pc: RTCPeerConnection, handlers: PhoneMediaHandlers) {
    this.pc = pc;
    this.handlers = handlers;
    pc.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe((rtp) => this.receive(rtp.payload));
    });
    pc.onDataChannel.subscribe((channel) => this.adoptChannel(channel));
    pc.connectionStateChange.subscribe((state) => {
      if (state === "connected" && this.connectTimer) {
        clearTimeout(this.connectTimer);
        this.connectTimer = null;
      }
      if (state === "failed" || state === "closed") this.close();
    });
    this.connectTimer = setTimeout(() => this.close(), CONNECT_TIMEOUT_MS);
    this.connectTimer.unref?.();
  }

  /** Answers the phone's offer once every local candidate is in the answer: GPT-Live clients do not trickle. */
  async answer(offer: string): Promise<string> {
    await this.pc.setRemoteDescription({ type: "offer", sdp: offer });
    const transceiver = this.pc.getTransceivers().find((candidate) => candidate.kind === "audio");
    if (!transceiver) throw new LiveSessionError("The call could not start: the phone offered no audio.", 400);
    transceiver.setDirection("sendrecv");
    transceiver.sender.replaceTrack(new MediaStreamTrack({ kind: "audio" }));
    this.transceiver = transceiver;
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await gathered(this.pc);
    const sdp = this.pc.localDescription?.sdp;
    if (!sdp) throw new LiveSessionError("The call could not start: no connection answer.", 502);
    return sdp;
  }

  send(data: string | Uint8Array): void {
    if (this.closed) return;
    if (typeof data === "string") return this.sendEvent(data);
    this.queueOutput(Buffer.from(data));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pacer) clearInterval(this.pacer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.pacer = this.connectTimer = null;
    this.frames.length = 0;
    try { this.decoder.delete(); } catch {}
    try { this.encoder.delete(); } catch {}
    void this.pc.close().catch(() => undefined);
    this.handlers.closed();
  }

  private adoptChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.onMessage.subscribe((message) => {
      if (!this.closed) this.handlers.event(typeof message === "string" ? message : Buffer.from(message).toString("utf8"));
    });
    channel.stateChanged.subscribe((state) => {
      if (state !== "open") return;
      // GPT-Live announces the session on the channel; the phone apps may wait for it.
      this.sendEvent(JSON.stringify({ type: "session.started" }));
      for (const event of this.pendingEvents.splice(0)) this.sendEvent(event);
    });
  }

  private sendEvent(text: string): void {
    let type: unknown;
    try { type = (JSON.parse(text) as { type?: unknown }).type; } catch { return; }
    if (type === "output.interrupted") return this.flushOutput();
    if (this.channel?.readyState !== "open") {
      if (this.pendingEvents.length < 100) this.pendingEvents.push(text);
      return;
    }
    try { this.channel.send(text); } catch {}
  }

  private receive(payload: Buffer): void {
    if (this.closed || !payload.length) return;
    let pcm: Buffer;
    try {
      pcm = this.decoder.decode(payload);
    } catch {
      return;
    }
    const chunk = downsample48to16(pcm);
    this.inputBatch.push(chunk);
    this.inputBytes += chunk.length;
    if (this.inputBytes < INPUT_BATCH_BYTES) return;
    const batch = Buffer.concat(this.inputBatch);
    this.inputBatch = [];
    this.inputBytes = 0;
    this.handlers.audio(batch);
  }

  private queueOutput(pcm24k: Buffer): void {
    const { pcm, last } = upsample24to48(pcm24k, this.lastOutputSample);
    this.lastOutputSample = last;
    let pending = Buffer.concat([this.outputCarry, pcm]);
    const frameBytes = FRAME_SAMPLES * 2;
    while (pending.length >= frameBytes) {
      this.frames.push(pending.subarray(0, frameBytes));
      pending = pending.subarray(frameBytes);
    }
    this.outputCarry = Buffer.from(pending);
    if (this.frames.length > MAX_QUEUED_FRAMES) this.frames.splice(0, this.frames.length - MAX_QUEUED_FRAMES);
    this.startPacing();
  }

  private flushOutput(): void {
    this.frames.length = 0;
    this.outputCarry = Buffer.alloc(0);
  }

  /** Gemini sends audio faster than it plays; the phone gets one frame every 20 ms. */
  private startPacing(): void {
    if (this.pacer || this.closed) return;
    this.pacingStart = Date.now();
    this.framesSent = 0;
    this.pacer = setInterval(() => this.pace(), FRAME_MS / 2);
    this.pacer.unref?.();
  }

  private pace(): void {
    const due = Math.floor((Date.now() - this.pacingStart) / FRAME_MS) + 1 - this.framesSent;
    for (let i = 0; i < due; i++) {
      const frame = this.frames.shift();
      if (!frame) {
        if (this.pacer) clearInterval(this.pacer);
        this.pacer = null;
        return;
      }
      this.sendFrame(frame, this.framesSent === 0);
      this.framesSent += 1;
    }
  }

  private sendFrame(frame: Buffer, first: boolean): void {
    const transceiver = this.transceiver;
    if (!transceiver || this.closed) return;
    let payload: Buffer;
    try {
      payload = this.encoder.encode(frame, FRAME_SAMPLES);
    } catch {
      return;
    }
    const header = new RtpHeader({
      payloadType: transceiver.sender.codec?.payloadType ?? 111,
      sequenceNumber: this.sequence,
      timestamp: this.timestamp,
      marker: first,
    });
    this.sequence = (this.sequence + 1) % 65_536;
    this.timestamp = (this.timestamp + FRAME_SAMPLES) % 2 ** 32;
    void transceiver.sender.sendRtp(new RtpPacket(header, payload)).catch(() => undefined);
  }
}

/** A peer that offers only this server's public address on the configured UDP ports. */
export function phonePeerConnection(config: PhoneBridgeConfig): RTCPeerConnection {
  return new RTCPeerConnection({
    codecs: { audio: [new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: RTP_RATE, channels: 2 })] },
    icePortRange: config.portRange,
    iceAdditionalHostAddresses: [config.publicAddress],
    iceUseIpv6: false,
  });
}

function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, GATHER_TIMEOUT_MS);
    const subscription = pc.iceGatheringStateChange.subscribe((state) => {
      if (state === "complete") done();
    });
    function done() {
      clearTimeout(timer);
      subscription.unSubscribe();
      resolve();
    }
  });
}
