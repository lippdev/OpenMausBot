import { useId } from "react";
import { KeyRound } from "lucide-react";

import { liveCost, liveDisclosure } from "@/lib/call-mode";
import { dismissLiveNotice } from "@/lib/live-call-media";
import { t } from "@/lib/i18n";
import { api, useStore, type Action } from "@/state/store";
import type { LiveSettings } from "../../shared/wire";
import { LiveKeySetup } from "./LiveKeySetup";

export const OPEN_API_KEYS = { type: "toggleAppSettings", open: true, section: "connections" } as const satisfies Action;

export function LiveKeyNeeded() {
  const { state, dispatch } = useStore();
  const titleId = useId();
  const switchToGemini = async () => {
    const body = await api<{ live: LiveSettings }>("/api/live/settings", { method: "PATCH", body: JSON.stringify({ provider: "gemini" }) });
    if (state.config) dispatch({ type: "configStatus", config: { ...state.config, live: body.live } });
  };
  if (state.config?.live?.provider === "gemini") return <LiveKeySetup compact provider="gemini" onSaved={dismissLiveNotice} />;
  return <section aria-labelledby={titleId} className="flex flex-col gap-2.5 rounded-xl border border-hairline bg-panel p-4 text-left">
    <div className="flex items-start gap-2.5">
      <KeyRound size={16} className="mt-0.5 shrink-0 text-ink-secondary" aria-hidden="true" />
      <h2 id={titleId} className="text-[13.5px] font-medium leading-[1.4] text-ink">{t("call.live.needsKey")}</h2>
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className="ui-button ui-button-primary" onClick={() => { dismissLiveNotice(); dispatch(OPEN_API_KEYS); }}>{t("call.live.openApiKeys")}</button>
      <button type="button" className="text-[12.5px] text-accent hover:underline" onClick={() => void switchToGemini()}>{t("call.live.useGemini")}</button>
    </div>
    <p className="text-[11.5px] leading-[1.45] text-ink-tertiary">{liveDisclosure({ cloudHome: state.config?.cloudHome === true })} {liveCost()}</p>
  </section>;
}
