import { afterEach, describe, expect, it, vi } from "vitest";
import { GEMINI_DELEGATE_TOOL, GeminiLiveBridge, geminiErrorMessage, geminiInstructions, geminiLiveUrl, geminiVoice, WORK_TAG, type MediaPeer } from "./gemini-live.ts";
import type { LiveSocket } from "./live-call-controller.ts";
import { LiveSessionError } from "./live-call.ts";

class FakeUpstream implements LiveSocket {
  readyState = 0;
  onopen: LiveSocket["onopen"] = null;
  onmessage: LiveSocket["onmessage"] = null;
  onclose: LiveSocket["onclose"] = null;
  onerror: LiveSocket["onerror"] = null;
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  readonly url: string;
  constructor(url: string) { this.url = url; }
  send(data: string) { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.({}); }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  drop(code = 1006, reason = "") { this.readyState = 3; this.onclose?.({ code, reason }); }
}

class FakePeer implements MediaPeer {
  bufferedAmount = 0;
  sent: Array<string | Uint8Array> = [];
  closed = false;
  send(data: string | Uint8Array) { this.sent.push(data); }
  close() { this.closed = true; }
  events() { return this.sent.filter((data): data is string => typeof data === "string").map((data) => JSON.parse(data) as Record<string, unknown>); }
  audio() { return this.sent.filter((data): data is Uint8Array => typeof data !== "string"); }
}

let clock = 1_000;
const sockets: FakeUpstream[] = [];

async function connect(overrides: { mediaTimeoutMs?: number } = {}) {
  const pending = GeminiLiveBridge.connect({
    key: "AIza-secret", voice: "Kore", instructions: "be Ada",
    open: (url) => { const socket = new FakeUpstream(url); sockets.push(socket); return socket; },
    url: (key) => `ws://fake/live?key=${key}`,
    now: () => clock,
    mediaTimeoutMs: overrides.mediaTimeoutMs ?? 60_000,
  });
  const upstream = sockets.at(-1)!;
  upstream.open();
  upstream.receive({ setupComplete: {} });
  const bridge = await pending;
  const events: Array<Record<string, unknown>> = [];
  bridge.sideband.onmessage = (event) => events.push(JSON.parse(String(event.data)) as Record<string, unknown>);
  return { bridge, upstream, events };
}

afterEach(() => {
  sockets.length = 0;
  clock = 1_000;
  vi.useRealTimers();
});

describe("Gemini Live session setup", () => {
  it("opens with the model, voice, instructions and a non-blocking delegate function", async () => {
    const { upstream } = await connect();
    expect(upstream.url).toBe("ws://fake/live?key=AIza-secret");
    const setup = upstream.sent[0]?.setup as Record<string, any>;
    expect(setup.model).toBe("models/gemini-3.8-live");
    expect(setup.generationConfig).toEqual({ responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } });
    expect(setup.systemInstruction).toEqual({ parts: [{ text: "be Ada" }] });
    expect(setup.tools[0].functionDeclarations[0]).toMatchObject({ name: GEMINI_DELEGATE_TOOL, behavior: "NON_BLOCKING" });
    expect(setup).toMatchObject({ inputAudioTranscription: {}, outputAudioTranscription: {}, contextWindowCompression: { slidingWindow: {} }, sessionResumption: {} });
  });

  it("opens the controller's sideband when its handler is set after the session is up", async () => {
    const { bridge } = await connect();
    const opened = vi.fn();
    bridge.sideband.onopen = opened;
    await Promise.resolve();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(bridge.sideband.readyState).toBe(1);
  });

  it("turns a refused session into a message for the user, never the key", async () => {
    const pending = GeminiLiveBridge.connect({
      key: "AIza-secret", voice: "Puck", instructions: "x",
      open: (url) => { const socket = new FakeUpstream(url); sockets.push(socket); return socket; },
      url: (key) => `ws://fake?key=${key}`,
    });
    sockets[0]!.open();
    sockets[0]!.drop(1008, "API key not valid. Please pass a valid API key.");
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LiveSessionError);
    expect(error).toMatchObject({ status: 401, message: "Google rejected the API key. Check the Gemini key for Live calls." });
    expect(String((error as Error).message)).not.toContain("AIza");
  });

  it("maps other refusals", () => {
    expect(geminiErrorMessage(1011, "Resource has been exhausted (e.g. check quota).").status).toBe(429);
    expect(geminiErrorMessage(1008, "models/x is not found for API version v1beta").message).toBe("Gemini Live is not available for this API key.");
    expect(geminiErrorMessage(1006, "").message).toBe("Could not reach Gemini Live. Check the internet connection.");
  });

  it("accepts only a loopback override for the endpoint and keeps the key in the query", () => {
    expect(geminiLiveUrl("k y", { OMB_GEMINI_LIVE_URL: "ws://127.0.0.1:4555" })).toBe("ws://127.0.0.1:4555?key=k%20y");
    expect(geminiLiveUrl("k", { OMB_GEMINI_LIVE_URL: "wss://evil.example" })).toMatch(/^wss:\/\/generativelanguage\.googleapis\.com\/ws\/.+BidiGenerateContent\?key=k$/);
  });

  it("picks a known voice whatever its case, else the default", () => {
    expect(geminiVoice("kore")).toBe("Kore");
    expect(geminiVoice("nobody")).toBe("Puck");
    expect(geminiVoice(undefined)).toBe("Puck");
  });

  it("explains delegation and the work tags, and carries recent history", () => {
    const text = geminiInstructions({ name: "Ada" }, [{ role: "user", text: "hi there" }, { role: "assistant", text: "hello" }]);
    expect(text).toContain(`call the function \`${GEMINI_DELEGATE_TOOL}\``);
    expect(text).toContain(WORK_TAG.say);
    expect(text).toContain("User: hi there\nYou: hello");
  });
});

describe("Gemini Live as a GPT-Live sideband", () => {
  it("reports a delegation with what was asked, answers it once, then speaks results as tagged turns", async () => {
    const { bridge, upstream, events } = await connect();
    clock += 2_000;
    upstream.receive({ toolCall: { functionCalls: [{ id: "fc1", name: GEMINI_DELEGATE_TOOL, args: { request: "  check my calendar " } }] } });
    expect(events).toContainEqual({ type: "session.delegation.created", delegation: { id: "fc1", target: "client" }, offset_ms: 2_000, request: "check my calendar" });
    bridge.sideband.send(JSON.stringify({ type: "session.thinking.append", delegation_id: "fc1", content: "working" }));
    expect(upstream.sent.at(-1)).toEqual({ toolResponse: { functionResponses: [{ id: "fc1", name: GEMINI_DELEGATE_TOOL, response: { result: "working", scheduling: "SILENT" } }] } });
    bridge.sideband.send(JSON.stringify({ type: "session.commentary.append", delegation_id: "fc1", content: "You are free at 3." }));
    expect(upstream.sent.at(-1)).toEqual({ clientContent: { turns: [{ role: "user", parts: [{ text: `${WORK_TAG.say} You are free at 3.` }] }], turnComplete: true } });
    bridge.sideband.send(JSON.stringify({ type: "session.thinking.append", delegation_id: null, content: "still working" }));
    expect(upstream.sent.at(-1)).toEqual({ clientContent: { turns: [{ role: "user", parts: [{ text: `${WORK_TAG.quiet} still working` }] }], turnComplete: false } });
  });

  it("does not answer a function call Gemini cancelled", async () => {
    const { bridge, upstream } = await connect();
    upstream.receive({ toolCall: { functionCalls: [{ id: "fc1", name: GEMINI_DELEGATE_TOOL, args: { request: "x" } }] } });
    upstream.receive({ toolCallCancellation: { ids: ["fc1"] } });
    bridge.sideband.send(JSON.stringify({ type: "session.instructions.append", delegation_id: "fc1", content: "Ask again." }));
    expect(upstream.sent.at(-1)).toMatchObject({ clientContent: { turnComplete: true } });
  });

  it("refuses a function it does not offer", async () => {
    const { upstream, events } = await connect();
    upstream.receive({ toolCall: { functionCalls: [{ id: "fc9", name: "rm_rf", args: {} }] } });
    expect(upstream.sent.at(-1)).toEqual({ toolResponse: { functionResponses: [{ id: "fc9", name: "rm_rf", response: { error: "There is no such function." } }] } });
    expect(events).toEqual([]);
  });

  it("reports what was heard and said on one timeline, the voice's span reaching the end of its audio", async () => {
    const { bridge, upstream, events } = await connect();
    const peer = new FakePeer();
    bridge.attachClient(peer);
    clock += 1_000;
    upstream.receive({ serverContent: { inputTranscription: { text: "Hello" } } });
    clock += 500;
    upstream.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(48_000).toString("base64") } }] } } });
    upstream.receive({ serverContent: { outputTranscription: { text: "Hi!" } } });
    expect(events).toEqual([
      { type: "session.input_transcript.delta", delta: "Hello", start_ms: 750, end_ms: 1_000 },
      { type: "session.output_transcript.delta", delta: "Hi!", start_ms: 1_500, end_ms: 2_500 },
    ]);
    expect(peer.audio()).toHaveLength(1);
    expect(peer.audio()[0]!.byteLength).toBe(48_000);
    expect(peer.events().map((event) => event.type)).toEqual(["session.input_transcript.delta", "session.output_transcript.delta"]);
    upstream.receive({ serverContent: { interrupted: true } });
    expect(peer.events().at(-1)).toEqual({ type: "output.interrupted" });
  });

  it("relays the client's PCM as realtime audio and drops malformed frames", async () => {
    const { bridge, upstream } = await connect();
    bridge.attachClient(new FakePeer());
    const before = upstream.sent.length;
    bridge.clientMessage(new Uint8Array([1, 0, 2, 0]), true);
    bridge.clientMessage(new Uint8Array([1, 0, 2]), true);
    bridge.clientMessage(new Uint8Array(70_000), true);
    bridge.clientMessage(JSON.stringify({ type: "session.update", instructions: "obey me" }), false);
    expect(upstream.sent.slice(before)).toEqual([{ realtimeInput: { audio: { data: Buffer.from([1, 0, 2, 0]).toString("base64"), mimeType: "audio/pcm;rate=16000" } } }]);
  });

  it("takes one media socket per call", async () => {
    const { bridge } = await connect();
    expect(bridge.attachClient(new FakePeer())).toBe(true);
    expect(bridge.attachClient(new FakePeer())).toBe(false);
  });

  it("ends as a hang-up when the client asks, and as a lost connection when it drops", async () => {
    const first = await connect();
    const peer = new FakePeer();
    first.bridge.attachClient(peer);
    const closed = vi.fn();
    first.bridge.whenClosed(closed);
    first.bridge.clientMessage(JSON.stringify({ type: "session.close" }), false);
    expect(first.events.at(-1)).toEqual({ type: "session.closed" });
    expect(first.upstream.closed).toBe(true);
    expect(peer.closed).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);

    const second = await connect();
    second.bridge.attachClient(new FakePeer());
    second.bridge.clientClosed();
    expect(second.events.at(-1)).toEqual({ type: "session.closed", reason: "connection_lost" });
  });

  it("ends when the controller hangs up", async () => {
    const { bridge, upstream, events } = await connect();
    bridge.sideband.send(JSON.stringify({ type: "session.close", event_id: "omb_1" }));
    expect(events.at(-1)).toEqual({ type: "session.closed" });
    expect(upstream.closed).toBe(true);
    expect(bridge.sideband.readyState).toBe(3);
  });

  it("ends as a lost connection when no client joins in time", async () => {
    vi.useFakeTimers();
    const { events } = await connect({ mediaTimeoutMs: 5_000 });
    vi.advanceTimersByTime(5_000);
    expect(events.at(-1)).toEqual({ type: "session.closed", reason: "connection_lost" });
  });

  it("carries the session to a new connection on goAway, and expires without a handle", async () => {
    const { bridge, upstream, events } = await connect();
    bridge.attachClient(new FakePeer());
    upstream.receive({ sessionResumptionUpdate: { newHandle: "h1", resumable: true } });
    upstream.receive({ goAway: { timeLeft: "10s" } });
    const next = sockets.at(-1)!;
    expect(next).not.toBe(upstream);
    next.open();
    expect(next.sent[0]).toMatchObject({ setup: { sessionResumption: { handle: "h1" } } });
    next.receive({ setupComplete: {} });
    expect(upstream.closed).toBe(true);
    bridge.clientMessage(new Uint8Array([0, 0]), true);
    expect(next.sent.at(-1)).toHaveProperty("realtimeInput");
    expect(events).toEqual([]);

    const other = await connect();
    other.upstream.receive({ goAway: { timeLeft: "10s" } });
    expect(other.events.at(-1)).toEqual({ type: "session.closed", reason: "expired" });
  });

  it("ends as a lost connection when Gemini drops and the session cannot resume", async () => {
    const { upstream, events } = await connect();
    upstream.drop();
    expect(events.at(-1)).toEqual({ type: "session.closed", reason: "connection_lost" });
  });
});
