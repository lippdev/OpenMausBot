import { DEFAULT_GEMINI_LIVE_VOICE } from "../shared/live-call.ts";
import type { LiveKeySource, LiveProvider, LiveSettings } from "../shared/wire.ts";
import type { AppConfig } from "./config.ts";

export const LIVE_IDLE_MINUTES_DEFAULT = 5;

export function liveProvider(cfg: Pick<AppConfig, "live">): LiveProvider {
  return cfg.live?.provider === "gemini" ? "gemini" : "openai";
}

export function liveCallKey(cfg: Pick<AppConfig, "live" | "openai">, provider: LiveProvider = liveProvider(cfg)): { key: string; source: LiveKeySource } | null {
  if (provider === "gemini") {
    const gemini = cfg.live?.geminiKey?.trim();
    return gemini ? { key: gemini, source: "gemini" } : null;
  }
  const live = cfg.live?.key?.trim();
  if (live) return { key: live, source: "live" };
  const openai = cfg.openai?.key?.trim();
  return openai ? { key: openai, source: "openai" } : null;
}

export function liveSettingsFor(cfg: AppConfig): LiveSettings {
  const minutes = cfg.live?.idleMinutes;
  const provider = liveProvider(cfg);
  const key = liveCallKey(cfg, provider);
  return {
    configured: key !== null,
    ...(key ? { keySource: key.source } : {}),
    provider,
    openaiConfigured: liveCallKey(cfg, "openai") !== null,
    geminiConfigured: liveCallKey(cfg, "gemini") !== null,
    voice: cfg.live?.voice ?? "",
    geminiVoice: cfg.live?.geminiVoice || DEFAULT_GEMINI_LIVE_VOICE,
    readTypedReplies: cfg.live?.readTypedReplies ?? true,
    idleMinutes: Number.isInteger(minutes) && minutes! >= 1 && minutes! <= 60 ? minutes! : LIVE_IDLE_MINUTES_DEFAULT,
  };
}
