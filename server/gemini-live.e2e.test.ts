// POSIX-gated: the fakes are shebang scripts.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import OpusScript from "opusscript";
import { MediaStreamTrack, RTCPeerConnection, RtpHeader, RtpPacket } from "werift";
import { WebSocket } from "ws";
import type { LiveCallState } from "../shared/wire.ts";
import { WORK_TAG } from "./gemini-live.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { startFakeGeminiLive, type FakeGeminiLive } from "./testing/fake-gemini-live.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse } from "./testing/sse.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const GEMINI_KEY = "AIza-fake-e2e";
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("Gemini Live call e2e", () => {
  let child: ChildProcess;
  let home = "";
  let base = "";
  let output = "";
  let gemini: FakeGeminiLive;
  let phonePorts = "";

  const post = async (path: string, body: unknown): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const createBot = async (): Promise<{ id: string; threadId: string; name: string }> => {
    const { bot } = (await post("/api/bots", {})).body as { bot: { id: string; threadId: string; name: string } };
    const res = await fetch(`${base}/api/bots/${bot.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-fake" }, approvalMode: "ask" }),
    });
    expect(res.status).toBe(200);
    return bot;
  };
  const openMedia = (path: string) => new Promise<{ socket: WebSocket; audio: Buffer[]; events: Array<Record<string, unknown>>; closed: Promise<void> }>((resolve, reject) => {
    const socket = new WebSocket(`${base.replace(/^http/, "ws")}${path}`);
    const audio: Buffer[] = [];
    const events: Array<Record<string, unknown>> = [];
    const closed = new Promise<void>((done) => socket.once("close", () => done()));
    socket.on("message", (data, binary) => {
      if (binary) audio.push(Buffer.from(data as Buffer));
      else events.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    socket.once("open", () => resolve({ socket, audio, events, closed }));
    socket.once("unexpected-response", (_req, res) => reject(new Error(`media socket refused: ${res.statusCode}`)));
    socket.once("error", reject);
  });

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    gemini = await startFakeGeminiLive();
    home = mkdtempSync(join(tmpdir(), "omb-gemini-live-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        live: { provider: "gemini" },
        instances: {
          claude: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_REPLIES: JSON.stringify(["Six times seven is 42."]) },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
        },
      }),
    );
    const port = await freePortBlock([0, 1]);
    const udp = await freePortBlock([0, 1, 2, 3]);
    phonePorts = `${udp}-${udp + 3}`;
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(port),
        OMB_WEBHOOK_PORT: String(port + 1),
        OMB_GEMINI_LIVE_URL: gemini.url,
        OMB_GEMINI_LIVE_KEY: GEMINI_KEY,
        OMB_LIVE_PUBLIC_IP: "127.0.0.1",
        OMB_LIVE_UDP_PORTS: phonePorts,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk) => (output += chunk));
    child.stderr!.on("data", (chunk) => (output += chunk));
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
      }
      if (Date.now() > deadline) throw new Error(`server never came up. output:\n${output}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. output:\n${output}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 120_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await gemini?.stop();
    if (home) await removeTempDir(home);
  });

  it("reports Gemini Live in the settings, never the key", async () => {
    const config = await (await fetch(`${base}/api/config`)).json() as { live: Record<string, unknown> };
    expect(config.live).toMatchObject({ provider: "gemini", configured: true, keySource: "gemini", geminiConfigured: true, geminiVoice: "Puck" });
    expect(JSON.stringify(config)).not.toContain(GEMINI_KEY);
  });

  it("refuses a phone without an offer before reaching Google", async () => {
    const bot = await createBot();
    const before = gemini.sessions.length;
    const res = await post("/api/live/session", { botId: bot.id, client: "ios" });
    expect(res.status).toBe(400);
    expect(gemini.sessions).toHaveLength(before);
  });

  it("answers a phone app's GPT-Live offer itself and carries the call's audio to Gemini Live", async () => {
    const bot = await createBot();
    const encoder = new OpusScript(48_000, 1, OpusScript.Application.VOIP, { wasm: false });
    const decoder = new OpusScript(48_000, 1, OpusScript.Application.VOIP, { wasm: false });
    const phone = new RTCPeerConnection({ iceUseIpv6: false });
    try {
      const transceiver = phone.addTransceiver(new MediaStreamTrack({ kind: "audio" }), { direction: "sendrecv" });
      const heard: Buffer[] = [];
      phone.onTrack.subscribe((track) => track.onReceiveRtp.subscribe((rtp) => heard.push(decoder.decode(rtp.payload))));
      const channel = phone.createDataChannel("oai-events");
      const events: Array<Record<string, unknown>> = [];
      channel.onMessage.subscribe((message) => events.push(JSON.parse(String(message)) as Record<string, unknown>));
      await phone.setLocalDescription(await phone.createOffer());
      await new Promise<void>((resolve) => {
        if (phone.iceGatheringState === "complete") return resolve();
        phone.iceGatheringStateChange.subscribe((state) => { if (state === "complete") resolve(); });
      });

      const before = gemini.sessions.length;
      const started = await post("/api/live/session", { botId: bot.id, client: "android", sdp: phone.localDescription!.sdp });
      expect(started.status).toBe(201);
      const { call, transport } = started.body as { call: LiveCallState; transport: { type: string; sdp: string } };
      expect(call).toMatchObject({ provider: "gemini", client: "android" });
      expect(transport.type).toBe("webrtc");
      const [low] = phonePorts.split("-").map(Number);
      expect(transport.sdp).toMatch(new RegExp(`a=candidate:.* 127\\.0\\.0\\.1 (${low}|${low! + 1}|${low! + 2}|${low! + 3}) typ host`));
      const session = await gemini.waitForSession(before);

      await phone.setRemoteDescription({ type: "answer", sdp: transport.sdp });
      await new Promise<void>((resolve) => {
        if (phone.connectionState === "connected") return resolve();
        phone.connectionStateChange.subscribe((state) => { if (state === "connected") resolve(); });
      });
      await expect.poll(() => events.some((event) => event.type === "session.started"), { timeout: 10_000 }).toBe(true);

      const tone = Buffer.alloc(960 * 2);
      for (let i = 0; i < 960; i++) tone.writeInt16LE(Math.round(Math.sin(i / 8) * 6000), i * 2);
      for (let i = 0; i < 6; i++) {
        const header = new RtpHeader({ payloadType: transceiver.sender.codec?.payloadType ?? 111, sequenceNumber: i, timestamp: i * 960 });
        await transceiver.sender.sendRtp(new RtpPacket(header, encoder.encode(tone, 960)));
      }
      const appended = await gemini.waitForMessage(session, (message) => Boolean(message.realtimeInput));
      const audio = (appended.realtimeInput as { audio: { data: string; mimeType: string } }).audio;
      expect(audio.mimeType).toBe("audio/pcm;rate=16000");
      expect(Buffer.from(audio.data, "base64").byteLength).toBe(1280);

      gemini.emit(session, { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(24_000 * 2 / 10).toString("base64") } }] } } });
      gemini.emit(session, { serverContent: { outputTranscription: { text: "Olá!" } } });
      await expect.poll(() => heard.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(5);
      expect(heard[0]!.byteLength).toBe(960 * 2);
      await expect.poll(() => events.some((event) => event.type === "session.output_transcript.delta" && event.delta === "Olá!")).toBe(true);

      channel.send(JSON.stringify({ type: "session.close" }));
      await expect.poll(async () => (await (await fetch(`${base}/api/live/call`)).json() as { call: unknown }).call, { timeout: 10_000 }).toBeNull();
      await expect.poll(() => session.closed).toBe(true);
    } finally {
      await phone.close();
      encoder.delete();
      decoder.delete();
    }
  }, 60_000);

  it("relays the call's audio, runs a spoken request through the bot and speaks the answer", async () => {
    const bot = await createBot();
    const sse = await openSse(`${base}/api/events`);
    try {
      const before = gemini.sessions.length;
      const started = await post("/api/live/session", { botId: bot.id, client: "web" });
      expect(started.status).toBe(201);
      const { call, transport } = started.body as { call: LiveCallState; transport: { type: string; path: string } };
      expect(call).toMatchObject({ botId: bot.id, provider: "gemini", voice: "Puck", client: "web" });
      expect(transport).toEqual({ type: "websocket", path: `/api/live/media?callId=${call.callId}` });
      expect(JSON.stringify(started.body)).not.toContain(GEMINI_KEY);

      const session = await gemini.waitForSession(before);
      expect(session.key).toBe(GEMINI_KEY);
      expect(session.setup).toMatchObject({ model: "models/gemini-3.8-live" });
      expect(JSON.stringify(session.setup)).toContain(bot.name);

      await expect(openMedia("/api/live/media?callId=nope")).rejects.toThrow("404");
      const media = await openMedia(transport.path);
      await sse.until((frame) => frame.kind === "live.call" && frame.call?.callId === call.callId && frame.call?.status === "live");
      await expect(openMedia(transport.path).then(({ closed }) => closed)).resolves.toBeUndefined();

      const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
      media.socket.send(pcm, { binary: true });
      const relayed = await gemini.waitForMessage(session, (message) => Boolean(message.realtimeInput));
      expect(relayed).toEqual({ realtimeInput: { audio: { data: pcm.toString("base64"), mimeType: "audio/pcm;rate=16000" } } });

      gemini.emit(session, { serverContent: { inputTranscription: { text: "what is six times seven" } } });
      gemini.emit(session, { toolCall: { functionCalls: [{ id: "fc_1", name: "delegate", args: { request: "what is six times seven" } }] } });
      const asked = await sse.until(
        (frame) => frame.kind === "message" && frame.threadId === bot.threadId && frame.message?.role === "user" && frame.message?.via === "call",
      );
      expect(asked.message).toMatchObject({ text: "what is six times seven", callId: call.callId });
      const working = await gemini.waitForMessage(session, (message) => Boolean(message.toolResponse));
      expect(working).toMatchObject({ toolResponse: { functionResponses: [{ id: "fc_1", name: "delegate", response: { scheduling: "SILENT" } }] } });
      const answer = await gemini.waitForMessage(session, (message) => JSON.stringify(message).includes("42"), 20_000);
      expect(answer).toMatchObject({ clientContent: { turnComplete: true } });
      expect(JSON.stringify(answer)).toContain(WORK_TAG.say);

      gemini.emit(session, { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(480).toString("base64") } }] } } });
      gemini.emit(session, { serverContent: { outputTranscription: { text: "It's 42." } } });
      await expect.poll(() => media.events.some((event) => event.type === "session.output_transcript.delta" && event.delta === "It's 42.")).toBe(true);
      expect(media.audio.map((chunk) => chunk.byteLength)).toEqual([480]);

      const ended = await post("/api/live/call/end", { callId: call.callId });
      expect(ended).toMatchObject({ status: 200, body: { call: { status: "ended", endReason: "hung-up" } } });
      await media.closed;
      expect(media.events.at(-1)).toEqual({ type: "session.closed" });
      await expect.poll(() => session.closed).toBe(true);
      const row = await sse.until((frame) => frame.kind === "message" && frame.threadId === bot.threadId && frame.message?.kind === "call");
      expect(row.message.call).toMatchObject({ callId: call.callId, client: "web", endReason: "hung-up" });

      await expect.poll(() => output, { timeout: 5_000 }).toMatch(/\[live\] call ended bot=\S+ voice=Puck client=web .*end=hung-up/);
      expect(output).toContain("provider=gemini");
      expect(output).not.toContain(GEMINI_KEY);
      expect(output).not.toMatch(/six times seven/i);
      expect(JSON.stringify(sse.frames)).not.toContain(GEMINI_KEY);
    } finally {
      sse.close();
    }
  }, 60_000);

  it("tells the caller why Google refused the session", async () => {
    const bot = await createBot();
    gemini.refuseNext(1008, "API key not valid. Please pass a valid API key.");
    const res = await post("/api/live/session", { botId: bot.id, client: "desktop" });
    expect(res).toEqual({ status: 401, body: { error: "Google rejected the API key. Check the Gemini key for Live calls." } });
    expect(await (await fetch(`${base}/api/live/call`)).json()).toEqual({ call: null });
  });
});
