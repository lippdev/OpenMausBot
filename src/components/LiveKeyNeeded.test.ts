import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ dispatch: vi.fn(), dismiss: vi.fn(), api: vi.fn(), cloudHome: false, live: undefined as { provider: string } | undefined }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useId: () => "live-key-title" }));
vi.mock("@/state/store", () => ({ api: f.api, useStore: () => ({ state: { config: { cloudHome: f.cloudHome, live: f.live } }, dispatch: f.dispatch }) }));
vi.mock("@/lib/live-call-media", () => ({ dismissLiveNotice: f.dismiss }));
import { LiveKeyNeeded, OPEN_API_KEYS } from "./LiveKeyNeeded";

beforeEach(() => {
  vi.clearAllMocks();
  f.cloudHome = false;
  f.live = undefined;
});

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void }>;
const nodes = (value: ReactNode): Node[] => !isValidElement(value) ? [] : [value as Node, ...Children.toArray((value as Node).props.children).flatMap(nodes)];

it("says one plain thing, names OpenAI, and offers Settings → API keys or Gemini Live", () => {
  const html = renderToStaticMarkup(createElement(LiveKeyNeeded));
  expect(html).toContain('<h2 id="live-key-title"');
  expect(html).toContain("Live calls use your own OpenAI key. Add it in Settings → API keys.");
  expect(html).toContain(">Open API keys</button>");
  expect(html.match(/<button/g)).toHaveLength(2);
  expect(html).toContain(">Use Google Gemini Live instead</button>");
  expect(html).toContain("The OpenAI key stays on your computer.");
  for (const gone of ["Pro", "plan", "<input", "$15"]) expect(html).not.toContain(gone);
  f.cloudHome = true;
  expect(renderToStaticMarkup(createElement(LiveKeyNeeded))).toContain("The OpenAI key stays in the Cloud.");
});

it("opens Settings at API keys and puts the prompt away", () => {
  const button = nodes(LiveKeyNeeded()).find((node) => node.type === "button" && node.props.children === "Open API keys");
  expect(button).toBeTruthy();
  button!.props.onClick!();
  expect(OPEN_API_KEYS).toEqual({ type: "toggleAppSettings", open: true, section: "connections" });
  expect(f.dispatch).toHaveBeenCalledExactlyOnceWith(OPEN_API_KEYS);
  expect(f.dismiss).toHaveBeenCalledOnce();
});

it("switches Live calls to Gemini Live, then asks for the Gemini key", async () => {
  const live = { provider: "gemini", configured: false };
  f.api.mockResolvedValue({ live });
  const button = nodes(LiveKeyNeeded()).find((node) => node.type === "button" && node.props.children === "Use Google Gemini Live instead");
  button!.props.onClick!();
  await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: { cloudHome: false, live } }));
  expect(f.api).toHaveBeenCalledWith("/api/live/settings", { method: "PATCH", body: JSON.stringify({ provider: "gemini" }) });
  f.live = { provider: "gemini" };
  expect(renderToStaticMarkup(createElement(LiveKeyNeeded))).toContain("Live calls use Google Gemini Live");
});
