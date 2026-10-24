// POSIX-gated: the fakes are shebang scripts.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

  it("refuses a phone before reaching Google", async () => {
    const bot = await createBot();
    const before = gemini.sessions.length;
    const res = await post("/api/live/session", { botId: bot.id, client: "ios" });
    expect(res.status).toBe(422);
    expect(gemini.sessions).toHaveLength(before);
  });

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
