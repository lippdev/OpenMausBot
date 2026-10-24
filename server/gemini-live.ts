// The Gemini key never leaves the harness: the client streams its microphone to the harness, which holds the only
// connection to Gemini Live and speaks GPT-Live's sideband protocol to the call controller.
import { DEFAULT_GEMINI_LIVE_VOICE, GEMINI_LIVE_VOICE_OPTIONS } from "../shared/live-call.ts";
import { liveInstructions, LiveSessionError, type LiveBot, type LiveHistoryMessage } from "./live-call.ts";
import type { LiveSocket } from "./live-call-controller.ts";

export const GEMINI_LIVE_MODEL = "gemini-3.8-live";
const GEMINI_LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
export const GEMINI_NEEDS_KEY = "Gemini Live calls use your own Gemini API key. Add it in the Live call settings.";
export const GEMINI_PHONE_UNSUPPORTED = "Gemini Live calls work in the desktop app and in a web browser. Switch Live calls to OpenAI to call from a phone.";
export const GEMINI_DELEGATE_TOOL = "delegate";
/** Client → harness: 16-bit little-endian mono PCM at this rate (Gemini Live's input format). */
export const GEMINI_INPUT_RATE = 16_000;
/** Harness → client: 16-bit little-endian mono PCM at this rate (Gemini Live's output format). */
export const GEMINI_OUTPUT_RATE = 24_000;
/** Tags on text the harness adds to the conversation, so the voice never takes its own work for the user. */
export const WORK_TAG = { quiet: "[work, quiet]", say: "[work, say]", instruction: "[work, instruction]" } as const;

const SETUP_TIMEOUT_MS = 20_000;
const MEDIA_ATTACH_TIMEOUT_MS = 20_000;
const MAX_AUDIO_FRAME_BYTES = 64 * 1024;
const MAX_CLIENT_BUFFER_BYTES = 1024 * 1024;
const MAX_REQUEST_CHARS = 4_000;
const HISTORY_CHARS = 6_000;
const SOCKET_OPEN = 1;

/** Only a loopback ws URL is accepted, read at call time. */
export function geminiLiveUrl(key: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OMB_GEMINI_LIVE_URL?.trim() ?? "";
  const base = /^ws:\/\/127\.0\.0\.1:\d{1,5}(\/[\w./-]*)?$/.test(override) ? override : GEMINI_LIVE_URL;
  return `${base}?key=${encodeURIComponent(key)}`;
}

export function geminiVoice(voice: string | undefined): string {
  const name = voice?.trim().toLowerCase() ?? "";
  return GEMINI_LIVE_VOICE_OPTIONS.find((option) => option.id.toLowerCase() === name)?.id ?? DEFAULT_GEMINI_LIVE_VOICE;
}

export function geminiInstructions(bot: LiveBot, history: LiveHistoryMessage[], options: { cloudHome?: boolean } = {}): string {
  const lines = [
    liveInstructions(bot, options),
    "",
    `To delegate, call the function \`${GEMINI_DELEGATE_TOOL}\` with \`request\` set to what the user asked, in their words and with every detail they gave. Its result only says that the work started; the outcome comes later.`,
    `Text that starts with ${WORK_TAG.quiet}, ${WORK_TAG.say} or ${WORK_TAG.instruction} comes from your own work, never from the user.`,
    `- ${WORK_TAG.say}: tell the user this now, in your own words and in their language.`,
    `- ${WORK_TAG.instruction}: do what it says now.`,
    `- ${WORK_TAG.quiet}: context for you; do not read it aloud or react to it.`,
  ];
  const recent = recentHistory(history);
  if (recent) lines.push("", "The conversation so far, oldest first:", recent);
  return lines.join("\n");
}

function recentHistory(history: LiveHistoryMessage[]): string {
  const picked: string[] = [];
  let total = 0;
  for (const message of [...history].reverse()) {
    const text = message.text.replace(/\s+/g, " ").trim().slice(0, 600);
    if (!text) continue;
    const line = `${message.role === "user" ? "User" : "You"}: ${text}`;
    if (picked.length >= 8 || total + line.length > HISTORY_CHARS) break;
    total += line.length;
    picked.unshift(line);
  }
  return picked.join("\n");
}

export function geminiSetup(input: { instructions: string; voice: string; handle?: string }) {
  return {
    setup: {
      model: `models/${GEMINI_LIVE_MODEL}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: input.voice } } },
      },
      systemInstruction: { parts: [{ text: input.instructions }] },
      tools: [{
        functionDeclarations: [{
          name: GEMINI_DELEGATE_TOOL,
          description: "Hands a request to your own work: research, tools, files, memory, settings, actions, and answers that need facts this conversation does not hold.",
          behavior: "NON_BLOCKING",
          parameters: {
            type: "OBJECT",
            properties: { request: { type: "STRING", description: "What the user asked, in their words, with every detail they gave." } },
            required: ["request"],
          },
        }],
      }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // Without compression an audio session ends after 15 minutes.
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: input.handle ? { handle: input.handle } : {},
    },
  };
}

/** Gemini refuses a session by closing the socket; its close reason is the only explanation it gives. */
export function geminiErrorMessage(code: number, reason: string): { message: string; status: number } {
  const text = reason.toLowerCase();
  if (/api key|api_key|permission|unauthori[sz]ed|unauthenticated/.test(text)) return { message: "Google rejected the API key. Check the Gemini key for Live calls.", status: 401 };
  if (/quota|exhausted|rate/.test(text)) return { message: "Google is limiting Gemini Live sessions right now (rate limit or quota). Try again in a moment.", status: 429 };
  if (/not found|not supported|unsupported/.test(text)) return { message: "Gemini Live is not available for this API key.", status: 502 };
  if (/voice/.test(text)) return { message: "Google rejected the voice for this call. Choose another voice.", status: 502 };
  if (code === 1007 || code === 1008) return { message: `Google rejected the call settings (${reason.replace(/[^\w .,-]/g, "").slice(0, 80) || code}).`, status: 502 };
  return { message: "Could not reach Gemini Live. Check the internet connection.", status: 502 };
}

/** The client side of the media socket. Binary frames are PCM; text frames are JSON events. */
export interface MediaPeer {
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface GeminiBridgeOptions {
  key: string;
  voice: string;
  instructions: string;
  open(url: string): LiveSocket;
  url?(key: string): string;
  now?(): number;
  setupTimeoutMs?: number;
  mediaTimeoutMs?: number;
}

interface PendingCall {
  name: string;
  answered: boolean;
}

type Sideband = LiveSocket & { fireOpen(): void };

/** One Gemini Live session for one call. The controller sees it as a GPT-Live sideband; the client as a media socket. */
export class GeminiLiveBridge {
  readonly sideband: Sideband;
  private readonly options: GeminiBridgeOptions;
  private upstream: LiveSocket | null = null;
  private candidate: LiveSocket | null = null;
  private handle: string | null = null;
  private peer: MediaPeer | null = null;
  private closed = false;
  private startedAt = 0;
  private playheadMs = 0;
  private outputStartMs: number | null = null;
  private lastInputMs = 0;
  private readonly calls = new Map<string, PendingCall>();
  private mediaTimer: ReturnType<typeof setTimeout> | null = null;
  private onClosed: (() => void) | null = null;

  private constructor(options: GeminiBridgeOptions) {
    this.options = options;
    this.sideband = createSideband(this);
  }

  /** Resolves once Gemini accepted the setup; rejects with a message fit for the user, never the key. */
  static async connect(options: GeminiBridgeOptions): Promise<GeminiLiveBridge> {
    const bridge = new GeminiLiveBridge(options);
    await bridge.open();
    return bridge;
  }

  /** Runs once, when the session is over for any reason. */
  whenClosed(fn: () => void): void {
    this.onClosed = fn;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  attachClient(peer: MediaPeer): boolean {
    if (this.closed || this.peer) return false;
    this.peer = peer;
    if (this.mediaTimer) clearTimeout(this.mediaTimer);
    this.mediaTimer = null;
    return true;
  }

  clientMessage(data: Uint8Array | string, binary: boolean): void {
    if (this.closed) return;
    if (binary && typeof data !== "string") {
      if (data.byteLength === 0 || data.byteLength > MAX_AUDIO_FRAME_BYTES || data.byteLength % 2) return;
      this.toGemini({ realtimeInput: { audio: { data: Buffer.from(data).toString("base64"), mimeType: `audio/pcm;rate=${GEMINI_INPUT_RATE}` } } });
      return;
    }
    let event: { type?: unknown };
    try {
      event = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8")) as { type?: unknown };
    } catch {
      return;
    }
    // The client is untrusted: hanging up is the only thing it may ask for.
    if (event?.type === "session.close") this.end();
  }

  clientClosed(): void {
    this.peer = null;
    if (!this.closed) this.end("connection_lost");
  }

  /** From the controller: a GPT-Live sideband command. */
  command(raw: string): void {
    let event: { type?: unknown; delegation_id?: unknown; content?: unknown };
    try {
      event = JSON.parse(raw) as typeof event;
    } catch {
      return;
    }
    if (event.type === "session.close") return this.end();
    const kind = typeof event.type === "string" ? /^session\.(instructions|thinking|commentary)\.append$/.exec(event.type)?.[1] : undefined;
    const content = typeof event.content === "string" ? event.content.trim() : "";
    if (!kind || !content) return;
    const id = typeof event.delegation_id === "string" ? event.delegation_id : null;
    const pending = id ? this.calls.get(id) : undefined;
    if (id && pending && !pending.answered) {
      pending.answered = true;
      this.toGemini({
        toolResponse: {
          functionResponses: [{ id, name: pending.name, response: { result: content, scheduling: kind === "thinking" ? "SILENT" : "WHEN_IDLE" } }],
        },
      });
      return;
    }
    const tag = kind === "thinking" ? WORK_TAG.quiet : kind === "commentary" ? WORK_TAG.say : WORK_TAG.instruction;
    this.toGemini({ clientContent: { turns: [{ role: "user", parts: [{ text: `${tag} ${content}` }] }], turnComplete: kind !== "thinking" } });
  }

  /** Ends the session: `reason` is a GPT-Live close reason, absent when someone hung up. */
  end(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.mediaTimer) clearTimeout(this.mediaTimer);
    this.mediaTimer = null;
    for (const socket of [this.upstream, this.candidate]) {
      if (!socket) continue;
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try { socket.close(1000, "call ended"); } catch {}
    }
    this.upstream = this.candidate = null;
    const peer = this.peer;
    this.peer = null;
    if (peer) {
      try { peer.send(JSON.stringify({ type: "session.closed" })); } catch {}
      try { peer.close(1000, "call ended"); } catch {}
    }
    this.toController({ type: "session.closed", ...(reason ? { reason } : {}) });
    const onClosed = this.onClosed;
    this.onClosed = null;
    onClosed?.();
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (message: string, status: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.end();
        reject(new LiveSessionError(message, status));
      };
      const timer = setTimeout(() => fail("Google did not answer in time. Try the call again.", 502), this.options.setupTimeoutMs ?? SETUP_TIMEOUT_MS);
      timer.unref?.();
      let socket: LiveSocket;
      try {
        socket = this.options.open((this.options.url ?? geminiLiveUrl)(this.options.key));
      } catch {
        fail("Could not reach Gemini Live. Check the internet connection.", 502);
        return;
      }
      this.upstream = socket;
      socket.onopen = () => this.sendSetup(socket);
      socket.onerror = () => fail("Could not reach Gemini Live. Check the internet connection.", 502);
      socket.onclose = (event) => {
        const { code, reason } = closeDetails(event);
        const failure = geminiErrorMessage(code, reason);
        fail(failure.message, failure.status);
      };
      socket.onmessage = (event) => {
        const message = parse(event.data);
        if (!message?.setupComplete) return;
        settled = true;
        clearTimeout(timer);
        this.startedAt = this.now();
        this.wire(socket);
        this.mediaTimer = setTimeout(() => this.end("connection_lost"), this.options.mediaTimeoutMs ?? MEDIA_ATTACH_TIMEOUT_MS);
        this.mediaTimer.unref?.();
        this.sideband.fireOpen();
        resolve();
      };
    });
  }

  private sendSetup(socket: LiveSocket, handle?: string): void {
    try {
      socket.send(JSON.stringify(geminiSetup({ instructions: this.options.instructions, voice: this.options.voice, ...(handle ? { handle } : {}) })));
    } catch {}
  }

  private wire(socket: LiveSocket): void {
    socket.onopen = null;
    socket.onmessage = (event) => {
      if (socket === this.upstream) this.onGemini(parse(event.data));
    };
    socket.onerror = null;
    socket.onclose = () => {
      if (socket !== this.upstream) return;
      this.upstream = null;
      if (!this.candidate && !this.resume()) this.end("connection_lost");
    };
  }

  /** Gemini closes a connection after about ten minutes; a resumption handle carries the session to a new one. */
  private resume(): boolean {
    if (this.closed || this.candidate || !this.handle) return false;
    let next: LiveSocket;
    try {
      next = this.options.open((this.options.url ?? geminiLiveUrl)(this.options.key));
    } catch {
      return false;
    }
    const handle = this.handle;
    this.candidate = next;
    const giveUp = () => {
      if (this.candidate !== next) return;
      this.candidate = null;
      next.onopen = next.onmessage = next.onerror = next.onclose = null;
      try { next.close(1000, "resume failed"); } catch {}
      if (!this.upstream) this.end("connection_lost");
    };
    next.onopen = () => this.sendSetup(next, handle);
    next.onerror = giveUp;
    next.onclose = giveUp;
    next.onmessage = (event) => {
      if (!parse(event.data)?.setupComplete || this.candidate !== next) return;
      const old = this.upstream;
      this.candidate = null;
      this.upstream = next;
      this.wire(next);
      if (old) {
        old.onopen = old.onmessage = old.onerror = old.onclose = null;
        try { old.close(1000, "resumed"); } catch {}
      }
      // Function calls of the old connection cannot be answered on the new one.
      for (const call of this.calls.values()) call.answered = true;
    };
    return true;
  }

  private onGemini(message: Record<string, unknown> | null): void {
    if (!message || this.closed) return;
    const update = message.sessionResumptionUpdate as { newHandle?: unknown; resumable?: unknown } | undefined;
    if (update) {
      if (update.resumable && typeof update.newHandle === "string" && update.newHandle) this.handle = update.newHandle;
      return;
    }
    if (message.goAway) {
      if (!this.resume()) this.end("expired");
      return;
    }
    const toolCall = message.toolCall as { functionCalls?: Array<{ id?: unknown; name?: unknown; args?: { request?: unknown } }> } | undefined;
    if (toolCall) return this.onToolCall(toolCall.functionCalls ?? []);
    const cancelled = message.toolCallCancellation as { ids?: unknown[] } | undefined;
    if (cancelled) {
      for (const id of cancelled.ids ?? []) {
        const call = typeof id === "string" ? this.calls.get(id) : undefined;
        if (call) call.answered = true;
      }
      return;
    }
    const content = message.serverContent as ServerContent | undefined;
    if (content) this.onContent(content);
  }

  private onToolCall(calls: Array<{ id?: unknown; name?: unknown; args?: { request?: unknown } }>): void {
    for (const call of calls) {
      if (typeof call.id !== "string" || typeof call.name !== "string") continue;
      if (call.name !== GEMINI_DELEGATE_TOOL) {
        this.toGemini({ toolResponse: { functionResponses: [{ id: call.id, name: call.name, response: { error: "There is no such function." } }] } });
        continue;
      }
      this.calls.set(call.id, { name: call.name, answered: false });
      if (this.calls.size > 500) this.calls.delete(this.calls.keys().next().value!);
      const request = typeof call.args?.request === "string" ? call.args.request.trim().slice(0, MAX_REQUEST_CHARS) : "";
      this.toController({
        type: "session.delegation.created",
        delegation: { id: call.id, target: "client" },
        offset_ms: this.elapsed(),
        ...(request ? { request } : {}),
      });
    }
  }

  private onContent(content: ServerContent): void {
    const now = this.elapsed();
    const input = content.inputTranscription?.text;
    if (typeof input === "string" && input) {
      const start = Math.max(this.lastInputMs, now - 250);
      this.lastInputMs = now;
      this.toController({ type: "session.input_transcript.delta", delta: input, start_ms: start, end_ms: now });
      this.toClient({ type: "session.input_transcript.delta", delta: input });
    }
    for (const part of content.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data;
      if (typeof data !== "string" || !data) continue;
      const pcm = Buffer.from(data, "base64");
      this.outputStartMs ??= Math.max(now, this.playheadMs);
      this.playheadMs = Math.max(this.playheadMs, now) + (pcm.byteLength / 2 / GEMINI_OUTPUT_RATE) * 1000;
      this.toClient(pcm);
    }
    const output = content.outputTranscription?.text;
    if (typeof output === "string" && output) {
      // The voice is heard while its audio plays, which runs ahead of generation: the span ends at the playhead.
      this.toController({ type: "session.output_transcript.delta", delta: output, start_ms: this.outputStartMs ?? now, end_ms: Math.max(now, this.playheadMs) });
      this.toClient({ type: "session.output_transcript.delta", delta: output });
    }
    if (content.interrupted) {
      this.playheadMs = now;
      this.toClient({ type: "output.interrupted" });
    }
    if (content.interrupted || content.turnComplete) this.outputStartMs = null;
  }

  private toGemini(message: Record<string, unknown>): void {
    const socket = this.upstream;
    if (this.closed || !socket || socket.readyState !== SOCKET_OPEN) return;
    try { socket.send(JSON.stringify(message)); } catch {}
  }

  private toClient(data: Record<string, unknown> | Buffer): void {
    const peer = this.peer;
    if (!peer) return;
    // A slow client loses audio rather than the harness buffering without bound.
    if (Buffer.isBuffer(data) && peer.bufferedAmount > MAX_CLIENT_BUFFER_BYTES) return;
    try { peer.send(Buffer.isBuffer(data) ? data : JSON.stringify(data)); } catch {}
  }

  private toController(event: Record<string, unknown>): void {
    try { this.sideband.onmessage?.({ data: JSON.stringify(event) }); } catch {}
  }

  private elapsed(): number {
    return Math.max(0, this.now() - this.startedAt);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

interface ServerContent {
  modelTurn?: { parts?: Array<{ inlineData?: { data?: unknown } }> };
  inputTranscription?: { text?: unknown };
  outputTranscription?: { text?: unknown };
  interrupted?: boolean;
  turnComplete?: boolean;
}

/** The controller sets its handlers after the session is already open, so `onopen` fires on assignment then. */
function createSideband(bridge: GeminiLiveBridge): Sideband {
  let opened = false;
  let onopen: LiveSocket["onopen"] = null;
  const sideband: Sideband = {
    get readyState() {
      return opened && !bridge.isClosed ? SOCKET_OPEN : bridge.isClosed ? 3 : 0;
    },
    get onopen() {
      return onopen;
    },
    set onopen(handler) {
      onopen = handler;
      if (handler && opened && !bridge.isClosed) queueMicrotask(() => {
        if (onopen === handler) handler({});
      });
    },
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (data) => bridge.command(data),
    close: () => {
      sideband.onmessage = null;
      bridge.end();
    },
    fireOpen: () => {
      opened = true;
      if (onopen) queueMicrotask(() => onopen?.({}));
    },
  };
  return sideband;
}

function parse(raw: unknown): Record<string, unknown> | null {
  const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : raw instanceof ArrayBuffer ? Buffer.from(raw).toString("utf8") : "";
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function closeDetails(event: unknown): { code: number; reason: string } {
  const value = event as { code?: unknown; reason?: unknown } | null;
  return { code: Number(value?.code) || 0, reason: typeof value?.reason === "string" ? value.reason : "" };
}
