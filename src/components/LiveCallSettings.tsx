import { useCallback, useId, useState } from "react";

import { DEFAULT_GEMINI_LIVE_VOICE, GEMINI_LIVE_VOICE_OPTIONS, LIVE_VOICE_OPTIONS } from "../../shared/live-call";
import { t } from "@/lib/i18n";
import { liveCost, liveDisclosure } from "@/lib/call-mode";
import { api, useStore, type ConfigStatus } from "@/state/store";
import type { LiveProvider, LiveSettings } from "../../shared/wire";
import { LiveKeySetup } from "./LiveKeySetup";
import { Select } from "./Select";

const IDLE_CHOICES = [1, 2, 3, 5, 10, 15, 30, 60];

export function LiveCallSettings({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const live: LiveSettings = state.config?.live ?? { configured: false, voice: "", readTypedReplies: true, idleMinutes: 5 };
  const [saving, setSaving] = useState(false);
  const [changingKey, setChangingKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typedHintId = useId();
  // Stable, so this callback ref runs once when the popover mounts, not on every save.
  const focusOnOpen = useCallback((dialog: HTMLDivElement | null) => {
    dialog?.querySelector<HTMLElement>("select, input, button")?.focus();
  }, []);
  const provider: LiveProvider = live.provider ?? "openai";
  const gemini = provider === "gemini";
  const voices = gemini ? GEMINI_LIVE_VOICE_OPTIONS : LIVE_VOICE_OPTIONS;
  const voice = gemini ? live.geminiVoice || DEFAULT_GEMINI_LIVE_VOICE : live.voice || "marin";
  const known = voices.some((option) => option.id === voice);
  const ownKey = gemini ? live.keySource === "gemini" : live.keySource === "live";

  const save = async (patch: Partial<Pick<LiveSettings, "provider" | "voice" | "geminiVoice" | "readTypedReplies" | "idleMinutes">>) => {
    setSaving(true);
    setError(null);
    try {
      const body = await api<{ live: LiveSettings }>("/api/live/settings", { method: "PATCH", body: JSON.stringify(patch) });
      if (state.config) dispatch({ type: "configStatus", config: { ...state.config, live: body.live } });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const removeKey = async () => {
    setSaving(true);
    setError(null);
    try {
      const status: ConfigStatus = window.ogb?.setCredential
        ? await window.ogb.setCredential(gemini ? "geminiLiveKey" : "openaiLiveKey", "")
        : await api("/api/config", { method: "PUT", body: JSON.stringify({ live: gemini ? { geminiKey: "" } : { key: "" } }) });
      dispatch({ type: "configStatus", config: status });
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      ref={focusOnOpen}
      role="dialog"
      tabIndex={-1}
      aria-label={t("call.live.settings")}
      className="flex w-[300px] max-w-[90vw] flex-col gap-3 rounded-xl border border-hairline bg-panel p-3 text-[12.5px] text-ink shadow-lg"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
    >
      <label className="flex items-center justify-between gap-2">
        <span className="text-ink-secondary">{t("call.live.provider")}</span>
        <Select
          size="sm"
          value={provider}
          disabled={saving}
          onChange={(event) => {
            setChangingKey(false);
            void save({ provider: event.target.value as LiveProvider });
          }}
        >
          <option value="openai">{t("call.live.providerOpenai")}</option>
          <option value="gemini">{t("call.live.providerGemini")}</option>
        </Select>
      </label>
      {gemini && <div className="-mt-2 text-[11.5px] text-ink-tertiary">{t("call.live.geminiPhones")}</div>}
      <label className="flex items-center justify-between gap-2">
        <span className="text-ink-secondary">{t("call.live.voice")}</span>
        <Select
          size="sm"
          value={voice}
          disabled={saving}
          onChange={(event) => void save(gemini ? { geminiVoice: event.target.value } : { voice: event.target.value })}
        >
          {!known && <option value={voice}>{voice}</option>}
          {voices.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </Select>
      </label>
      <div className="-mt-2 text-[11.5px] text-ink-tertiary">{t("call.live.voiceNext")}</div>
      <label className="flex items-center justify-between gap-2">
        <span className="text-ink-secondary">{t("call.live.readTyped")}</span>
        <input
          type="checkbox"
          checked={live.readTypedReplies}
          disabled={saving}
          aria-describedby={typedHintId}
          onChange={(event) => void save({ readTypedReplies: event.target.checked })}
        />
      </label>
      <div id={typedHintId} className="-mt-2 text-[11.5px] text-ink-tertiary">{t("call.live.readTypedHint")}</div>
      <label className="flex items-center justify-between gap-2">
        <span className="text-ink-secondary">{t("call.live.idle")}</span>
        <Select
          size="sm"
          value={live.idleMinutes}
          disabled={saving}
          onChange={(event) => void save({ idleMinutes: Number(event.target.value) })}
        >
          {[...new Set([...IDLE_CHOICES, live.idleMinutes])].sort((a, b) => a - b).map((minutes) => (
            <option key={minutes} value={minutes}>{minutes}</option>
          ))}
        </Select>
      </label>
      <div className="flex items-center justify-between gap-2 border-t border-hairline/60 pt-2">
        <span className="text-ink-secondary">{t(gemini ? "call.live.geminiKey" : "call.live.key")}</span>
        <span className="flex gap-2">
          <button type="button" className="text-accent hover:underline" onClick={() => setChangingKey((open) => !open)}>
            {t("call.live.keyChange")}
          </button>
          {ownKey && (
            <button type="button" className="text-danger hover:underline" disabled={saving} onClick={() => void removeKey()}>
              {t("call.live.keyRemove")}
            </button>
          )}
        </span>
      </div>
      {!ownKey && (
        <div className="-mt-2 text-[11.5px] text-ink-tertiary">
          {t(gemini ? "call.live.geminiNeedsKey" : live.keySource === "openai" ? "call.live.keyFromApiKeys" : "call.live.needsKey")}
        </div>
      )}
      {changingKey && <LiveKeySetup compact provider={provider} onSaved={() => setChangingKey(false)} />}
      <div className="text-[11.5px] text-ink-tertiary">{liveDisclosure({ cloudHome: state.config?.cloudHome === true, provider })} {liveCost(provider)}</div>
      {error && <div className="text-[12px] text-danger">{error}</div>}
    </div>
  );
}
