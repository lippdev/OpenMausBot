// No key is ever read or written here; without one a start answers 409 `needsKey`. A phone can never send device-revoked.
import type { IncomingMessage } from "node:http";
import { WebSocketServer } from "ws";
import { z } from "zod";
import type { LiveProvider, LiveSettings } from "../../shared/wire.ts";
import type { GeminiLiveBridge } from "../gemini-live.ts";
import { LiveSessionError, MAX_SDP_BYTES } from "../live-call.ts";
import { LiveCallBusyError, type LiveCallController } from "../live-call-controller.ts";
import { isSameOrigin } from "../request-auth.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";
import type { Upgrades } from "./upgrades.ts";

export interface LiveRouteDeps {
  calls: Pick<LiveCallController, "start" | "end" | "current" | "deviceRevoked" | "mediaSession">;
  resolveTarget(botId: string, threadId: string | undefined): { botId: string; botName: string; threadId: string } | null;
  settings(): LiveSettings;
  saveSettings(patch: { provider?: LiveProvider; voice?: string; geminiVoice?: string; readTypedReplies?: boolean; idleMinutes?: number }): Promise<LiveSettings>;
  /** Gemini Live media sockets; absent where Gemini Live is not offered. */
  media?: { upgrades: Upgrades; bridge(sessionId: string): GeminiLiveBridge | undefined };
}

export const LIVE_MEDIA_PATH = "/api/live/media";
const MEDIA_FRAME_BYTES = 64 * 1024;

const id = z.string().regex(/^[\w-]{1,120}$/);
const sessionBody = z.object({
  botId: id,
  threadId: id.optional(),
  // Not trimmed: the SDP offer goes to OpenAI byte for byte. Gemini Live calls send none.
  sdp: z.string().min(1).refine((sdp) => Buffer.byteLength(sdp) <= MAX_SDP_BYTES).optional(),
  client: z.enum(["desktop", "web", "ios", "android"]),
}).strict();
const endBody = z.object({ callId: z.string().min(1).max(120) }).strict();
// Strict, so `key` is refused rather than ignored: the key is saved only through the credential store or PUT /api/config.
const settingsBody = z.object({
  provider: z.enum(["openai", "gemini"]).optional(),
  voice: z.string().trim().max(40).regex(/^[a-z]*$/).optional(),
  geminiVoice: z.string().trim().max(40).regex(/^[A-Za-z]*$/).optional(),
  readTypedReplies: z.boolean().optional(),
  idleMinutes: z.number().int().min(1).max(60).optional(),
}).strict();

const DEVICE_ID = /^[\w-]{1,128}$/;

/** The companion sends its own id for the phone that authenticated, never one the phone chose. */
function companionDevice(req: IncomingMessage): string | undefined {
  if (req.headers["x-openmausbot-companion"] !== "1") return undefined;
  const device = req.headers["x-openmausbot-companion-device"];
  return typeof device === "string" && DEVICE_ID.test(device) ? device : undefined;
}

async function bodyOf(req: IncomingMessage, readBody: RouteContext["readBody"]): Promise<unknown> {
  try {
    return await readBody(req);
  } catch {
    return undefined;
  }
}

export function createLiveRoutes(deps: LiveRouteDeps): RouteHandler {
  const media = deps.media;
  const sockets = media ? new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MEDIA_FRAME_BYTES }) : null;
  media?.upgrades.route((path) => path === LIVE_MEDIA_PATH);
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (!path.startsWith("/api/live/")) return PASS;

    if (path === LIVE_MEDIA_PATH && media && sockets) {
      const pending = media.upgrades.pending(req);
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      if (!pending) return json(res, 426, { error: "WebSocket upgrade required" });
      if (!isSameOrigin(req)) return json(res, 403, { error: "forbidden: cross-origin request" });
      const sessionId = deps.calls.mediaSession(url.searchParams.get("callId") ?? "", auth);
      const bridge = sessionId ? media.bridge(sessionId) : undefined;
      if (!bridge || bridge.isClosed) return json(res, 404, { error: "That call is not running." });
      if (pending.socket.destroyed) return;
      pending.release();
      sockets.handleUpgrade(req, pending.socket, pending.head, (ws) => {
        if (!bridge.attachClient(ws)) {
          ws.close(4409, "This call already has its audio connected.");
          return;
        }
        ws.on("message", (data, binary) => bridge.clientMessage(Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer), binary));
        ws.on("error", () => ws.terminate());
        ws.once("close", () => bridge.clientClosed());
      });
      return;
    }

    if (method === "POST" && path === "/api/live/session") {
      const parsed = sessionBody.safeParse(await bodyOf(req, readBody));
      if (!parsed.success) return json(res, 400, { error: "The call request was not valid." });
      const target = deps.resolveTarget(parsed.data.botId, parsed.data.threadId);
      if (!target) return json(res, 404, { error: "That bot or chat does not exist." });
      try {
        const device = companionDevice(req);
        const { call, sdp } = await deps.calls.start({ auth, ...(device ? { device } : {}), ...target, client: parsed.data.client, ...(parsed.data.sdp ? { sdp: parsed.data.sdp } : {}) });
        const transport = call.provider === "gemini"
          ? { type: "websocket", path: `${LIVE_MEDIA_PATH}?callId=${encodeURIComponent(call.callId)}` }
          : { type: "webrtc", sdp };
        return json(res, 201, { call, transport });
      } catch (error) {
        if (error instanceof LiveCallBusyError) return json(res, 409, { error: error.message, activeCall: error.call });
        if (error instanceof LiveSessionError) {
          return json(res, error.status, error.status === 409 ? { error: error.message, needsKey: true } : { error: error.message });
        }
        throw error;
      }
    }

    if (method === "POST" && path === "/api/live/call/end") {
      const parsed = endBody.safeParse(await bodyOf(req, readBody));
      if (!parsed.success) return json(res, 400, { error: "The request was not valid." });
      const call = await deps.calls.end(parsed.data.callId);
      return call ? json(res, 200, { call }) : json(res, 404, { error: "That call is not running." });
    }

    if (method === "GET" && path === "/api/live/call") return json(res, 200, { call: deps.calls.current() });

    if (method === "POST" && path === "/api/live/device-revoked") {
      if (req.headers["x-openmausbot-companion"] !== "1") return json(res, 403, { error: "Only the phone companion can report an unpaired phone." });
      const device = companionDevice(req);
      if (!device) return json(res, 400, { error: "The unpaired phone was not named." });
      return json(res, 200, { call: deps.calls.deviceRevoked(device) });
    }

    if (method === "PATCH" && path === "/api/live/settings") {
      const parsed = settingsBody.safeParse(await bodyOf(req, readBody));
      if (!parsed.success) {
        return json(res, 400, { error: "Those Live settings are not valid." });
      }
      if (!Object.keys(parsed.data).length) return json(res, 400, { error: "nothing to save" });
      return json(res, 200, { live: await deps.saveSettings(parsed.data) });
    }

    return PASS;
  };
}
