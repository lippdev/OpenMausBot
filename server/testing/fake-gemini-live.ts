#!/usr/bin/env node
// A stand-in for Google's Gemini Live BidiGenerateContent WebSocket: it accepts a setup, answers setupComplete and
// records what the harness sends. No audio is generated.
import { pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

export interface FakeGeminiSession {
  key: string;
  setup: Record<string, unknown> | null;
  messages: Array<Record<string, unknown>>;
  closed: boolean;
  socket: WebSocket;
}

export interface FakeGeminiLive {
  url: string;
  sessions: FakeGeminiSession[];
  /** The next connection is closed with this code and reason instead of a setupComplete. */
  refuseNext(code: number, reason: string): void;
  emit(session: FakeGeminiSession, message: Record<string, unknown>): void;
  waitForSession(index: number, timeoutMs?: number): Promise<FakeGeminiSession>;
  waitForMessage(session: FakeGeminiSession, match: (message: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
}

/** Google sends Gemini Live's JSON in binary frames. */
function send(socket: WebSocket, message: Record<string, unknown>): void {
  socket.send(Buffer.from(JSON.stringify(message)), { binary: true });
}

export async function startFakeGeminiLive(): Promise<FakeGeminiLive> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((ready) => server.once("listening", ready));
  const sessions: FakeGeminiSession[] = [];
  const waiters = new Set<() => void>();
  const notify = () => { for (const waiter of Array.from(waiters)) waiter(); };
  let refusal: { code: number; reason: string } | null = null;

  server.on("connection", (socket, req) => {
    const key = new URL(req.url ?? "/", "http://fake").searchParams.get("key") ?? "";
    const session: FakeGeminiSession = { key, setup: null, messages: [], closed: false, socket };
    sessions.push(session);
    socket.on("message", (data) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.setup && !session.setup) {
        session.setup = message.setup as Record<string, unknown>;
        if (refusal) {
          const { code, reason } = refusal;
          refusal = null;
          socket.close(code, reason);
        } else send(socket, { setupComplete: {} });
      } else session.messages.push(message);
      notify();
    });
    socket.on("close", () => {
      session.closed = true;
      notify();
    });
    notify();
  });

  const wait = <T>(find: () => T | undefined, timeoutMs: number, what: string): Promise<T> => new Promise((resolve, reject) => {
    const check = () => {
      const found = find();
      if (found === undefined) return;
      clearTimeout(timer);
      waiters.delete(check);
      resolve(found);
    };
    const timer = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`fake Gemini Live: timed out waiting for ${what}`));
    }, timeoutMs);
    waiters.add(check);
    check();
  });

  const port = (server.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    sessions,
    refuseNext(code, reason) {
      refusal = { code, reason };
    },
    emit(session, message) {
      send(session.socket, message);
    },
    waitForSession(index, timeoutMs = 10_000) {
      return wait(() => sessions[index]?.setup ? sessions[index] : undefined, timeoutMs, `session ${index}`);
    },
    waitForMessage(session, match, timeoutMs = 10_000) {
      return wait(() => session.messages.find(match), timeoutMs, "a message");
    },
    stop() {
      for (const client of server.clients) client.terminate();
      return new Promise((done) => server.close(() => done()));
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const live = await startFakeGeminiLive();
  console.log(live.url);
}
