/** A Live call as the wire carries it: its state, the record a finished call
 * leaves, and the non-secret Live settings. Types only; `wire.ts` re-exports them. */

/** Which app holds the microphone of a Live call: the desktop app (its own
 * page or a server's page in it), a web browser, or a phone. Self-declared;
 * for display and logs only. The phone apps show a value they do not know as
 * "another device". */
export type LiveClient = "desktop" | "web" | "ios" | "android";
/** The voice a Live call runs on: OpenAI GPT-Live (WebRTC from the client) or
 * Google Gemini Live (the client streams audio through the harness). */
export type LiveProvider = "openai" | "gemini";
export type LiveCallStatus = "connecting" | "live" | "ending" | "ended";
/** Why a call ended. "signed-out": the sign-in or paired phone that started
 * it was signed out, revoked or unpaired. A client that does not know a
 * reason shows the call's `error` text, or plain "Call ended.". */
export type LiveEndReason =
  | "hung-up" | "idle" | "expired" | "content" | "remote-hangup" | "connection-lost"
  | "sideband-lost" | "deleted" | "shutdown" | "signed-out" | "error";

/** The one Live call a harness runs. Never carries the key or any speech. */
export interface LiveCallState {
  callId: string;
  botId: string;
  threadId: string;
  client: LiveClient;
  /** Absent from a harness older than Gemini Live: read it as "openai". */
  provider?: LiveProvider;
  voice: string;
  /** epoch ms when the session was created */
  startedAt: number;
  status: LiveCallStatus;
  endReason?: LiveEndReason;
  /** short, user-facing; present when the call ended on a problem */
  error?: string;
}

/** One finished Live call, written once when a call that went live ends. Never carries speech. */
export interface LiveCallRecord {
  callId: string;
  botId: string;
  client: LiveClient;
  /** epoch ms, = LiveCallState.startedAt */
  startedAt: number;
  /** epoch ms when the call ended */
  endedAt: number;
  /** whole seconds: OpenAI usage seconds when given, else wall clock */
  seconds: number;
  endReason: LiveEndReason;
  /** only when LLM thread titles are on and the engine can generateText */
  title?: string;
}

/** `live`: the key saved for Live calls only; `openai`: the OpenAI API key from Settings → API keys, used when there is no `live` key;
 * `gemini`: the Gemini API key saved for Gemini Live calls. */
export type LiveKeySource = "live" | "openai" | "gemini";

/** Non-secret Live settings, as GET /api/config and PATCH /api/live/settings report them. */
export interface LiveSettings {
  /** A Live call has a key to use (`keySource` says which); never the key itself. */
  configured: boolean;
  keySource?: LiveKeySource;
  /** Which voice new calls use. This and the next three are absent from a harness older than Gemini Live. */
  provider?: LiveProvider;
  /** An OpenAI key for GPT-Live calls is saved, whichever provider is chosen. */
  openaiConfigured?: boolean;
  /** A Gemini API key for Gemini Live calls is saved, whichever provider is chosen. */
  geminiConfigured?: boolean;
  /** A Gemini Live prebuilt voice. */
  geminiVoice?: string;
  /** A GPT-Live voice. */
  voice: string;
  readTypedReplies: boolean;
  idleMinutes: number;
}
