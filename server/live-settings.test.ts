import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config.ts";
import { LIVE_IDLE_MINUTES_DEFAULT, liveCallKey, liveProvider, liveSettingsFor } from "./live-settings.ts";

describe("live settings", () => {
  it("defaults to a 5 minute idle hang-up and reading typed replies, with no key", () => {
    expect(LIVE_IDLE_MINUTES_DEFAULT).toBe(5);
    expect(liveSettingsFor({} as AppConfig)).toEqual({ configured: false, provider: "openai", openaiConfigured: false, geminiConfigured: false, geminiVoice: "Puck", voice: "", readTypedReplies: true, idleMinutes: 5 });
  });

  it("reports saved values and where the key comes from, never the key", () => {
    const settings = liveSettingsFor({ live: { key: "sk-test", voice: "sol", readTypedReplies: false, idleMinutes: 12 } } as AppConfig);
    expect(settings).toEqual({ configured: true, keySource: "live", provider: "openai", openaiConfigured: true, geminiConfigured: false, geminiVoice: "Puck", voice: "sol", readTypedReplies: false, idleMinutes: 12 });
    expect(JSON.stringify(settings)).not.toContain("sk-test");
  });
});

describe("the key a Live call uses", () => {
  it("is the OpenAI API key from Settings → API keys when there is no separate Live key", () => {
    const cfg = { openai: { key: " sk-openai " } } as AppConfig;
    expect(liveCallKey(cfg)).toEqual({ key: "sk-openai", source: "openai" });
    for (const live of [{}, { key: "" }, { key: "  " }]) expect(liveCallKey({ ...cfg, live }), JSON.stringify(live)).toEqual({ key: "sk-openai", source: "openai" });
    const settings = liveSettingsFor(cfg);
    expect(settings).toMatchObject({ configured: true, keySource: "openai" });
    expect(JSON.stringify(settings)).not.toContain("sk-openai");
  });

  it("is the separate Live key whenever one is saved", () => {
    expect(liveCallKey({ live: { key: "sk-live" }, openai: { key: "sk-openai" } } as AppConfig)).toEqual({ key: "sk-live", source: "live" });
    expect(liveSettingsFor({ live: { key: "sk-live" }, openai: { key: "sk-openai" } } as AppConfig)).toMatchObject({ keySource: "live" });
  });

  it("is nothing without either key; never an image, compatible-server or other provider's key", () => {
    const others = { imageGen: { key: "sk-image" }, openaiCompat: { key: "sk-compat" }, openrouter: { key: "sk-or" }, xai: { key: "xai-key" } } as AppConfig;
    expect(liveCallKey(others)).toBeNull();
    expect(liveCallKey({ ...others, openai: { key: " " } })).toBeNull();
    expect(liveSettingsFor(others)).toEqual({ configured: false, provider: "openai", openaiConfigured: false, geminiConfigured: false, geminiVoice: "Puck", voice: "", readTypedReplies: true, idleMinutes: 5 });
  });
});

describe("Gemini Live", () => {
  it("uses only the Gemini key when Gemini Live is chosen, never an OpenAI key", () => {
    const cfg = { live: { provider: "gemini", key: "sk-live" }, openai: { key: "sk-openai" } } as AppConfig;
    expect(liveProvider(cfg)).toBe("gemini");
    expect(liveCallKey(cfg)).toBeNull();
    expect(liveSettingsFor(cfg)).toMatchObject({ configured: false, provider: "gemini", openaiConfigured: true, geminiConfigured: false });
    const withKey = { ...cfg, live: { ...cfg.live, geminiKey: " AIza-gemini " } } as AppConfig;
    expect(liveCallKey(withKey)).toEqual({ key: "AIza-gemini", source: "gemini" });
    const settings = liveSettingsFor(withKey);
    expect(settings).toMatchObject({ configured: true, keySource: "gemini", provider: "gemini", geminiConfigured: true });
    expect(JSON.stringify(settings)).not.toContain("AIza-gemini");
  });

  it("keeps GPT-Live the default and reports a saved Gemini voice", () => {
    expect(liveProvider({} as AppConfig)).toBe("openai");
    expect(liveSettingsFor({ live: { geminiVoice: "Kore" } } as AppConfig)).toMatchObject({ provider: "openai", geminiVoice: "Kore" });
  });
});
