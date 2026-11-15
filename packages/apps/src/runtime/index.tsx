// The frame's runtime: one bundle (React, ECharts, the kit, the bridge) every App's frame loads by hash. The page
// around the frame sends the App to draw (its revision, definition and starting state), again for a new revision (a
// preview as the analyst builds it). The App's own bundle loads after this one and registers its page; it imports
// React and `@opendash/app` as externals that resolve to this runtime's global. The lockdown runs before any of the
// App's code exists.
import { lockdown } from "./lockdown";

declare const __OD_CSS__: string;
{
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(__OD_CSS__);
  document.adoptedStyleSheets = [sheet];
}
lockdown();

import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { createRoot, type Root } from "react-dom/client";
import { type DrawDashboard, FRAME_METHODS, HOST_METHODS } from "../protocol";
import { mark, notify } from "./bridge";
import {
  AppFilter,
  AppFilters,
  AppSearch,
  AppSelect,
  AppTabs,
  currentSpeed,
  currentStates,
  Dashboard,
  DataGrid,
  Picker,
  Chart as QueryChart,
  registerApp,
  Segmented,
  Source,
  Summary,
  TracedValue,
  useFilter,
  useQuery,
  useRecord,
} from "./dashboard";
import { Fragment as DevFragment, jsxDEV } from "./jsx-dev";
import { BLOCKED_EVENTS, createPicker } from "./pick";
import { probe, speedFindings } from "./probe";
import { AssumptionProvider, derive, format, useAssumption } from "./values";

mark("runtime");

// This script and the App's bundle after it are `defer`: they run once the document is parsed, in that order, and the
// browser may handle a message between the two. So a draw that comes before DOMContentLoaded (when both have run, and
// the App has registered its page) waits for it, and then the page hears the frame is loaded (it sends the draw then
// too, in case it came up after the frame).
let root: Root | null = null;
let loaded = false;
let waiting: DrawDashboard | null = null;
let drawn: string | null = null;
const draw = (d: DrawDashboard) => {
  // The page sends a draw at mount and again when it hears the frame loaded: the same revision once is enough.
  if (d.revision === drawn) return;
  drawn = d.revision;
  root ??= createRoot(document.getElementById("root") as HTMLElement);
  root.render(
    <AssumptionProvider>
      <Dashboard key={d.revision} draw={d} />
    </AssumptionProvider>,
  );
  mark("drawn");
};
/**
 * The render check: once the drawn revision's answers have settled (none loading, for a moment) or twelve seconds
 * pass, what's wrong at this width goes to the page.
 */
async function runProbe() {
  const started = Date.now();
  let quiet = 0;
  for (;;) {
    const { states } = currentStates();
    const loading = Object.values(states).some((s) => s.state === "loading");
    quiet = !loading && Object.keys(states).length ? quiet + 1 : 0;
    if (quiet >= 3 || Date.now() - started > 12_000) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  const { revision, states } = currentStates();
  const root = document.getElementById("root");
  // What's wrong with how it looks at this width, then with how fast its numbers come (the same at every width).
  const findings = root ? [...probe(root, states, window.innerWidth), ...speedFindings(currentSpeed())] : [];
  const unsettled = Object.values(states).some((s) => s.state === "loading");
  notify(FRAME_METHODS.probed, { revision, width: window.innerWidth, findings, ...(unsettled ? { unsettled } : {}) });
}

/**
 * Select to edit: the outline is the runtime's own box over the App (made the first time pick mode is on, once the
 * body exists), moved to the box of what the pointer is over.
 */
let outlineBox: HTMLDivElement | null = null;
const picker = createPicker({
  post: notify,
  revision: () => drawn,
  outline: (box) => {
    if (!box) {
      if (outlineBox) outlineBox.hidden = true;
      return;
    }
    if (!outlineBox) {
      outlineBox = document.createElement("div");
      outlineBox.className = "od-pick-outline";
      outlineBox.setAttribute("aria-hidden", "true");
      document.body.appendChild(outlineBox);
    }
    outlineBox.hidden = false;
    outlineBox.style.transform = `translate(${box.left}px, ${box.top}px)`;
    outlineBox.style.width = `${box.width}px`;
    outlineBox.style.height = `${box.height}px`;
  },
  shown: (on) => document.documentElement.classList.toggle("od-picking", on),
});
// On the window, in the capture phase, added before any App code exists: these run before the App's own listeners
// (React's sit on its root, further down), so a click while picking never reaches the App.
window.addEventListener("pointermove", (e) => picker.move(e.target), { capture: true, passive: true });
window.addEventListener("pointerover", (e) => picker.move(e.target), { capture: true, passive: true });
for (const type of BLOCKED_EVENTS) {
  window.addEventListener(type, (e) => picker.press(type, e), { capture: true, passive: false });
}
window.addEventListener("keydown", (e) => picker.key(e.key, e), { capture: true });
window.addEventListener("scroll", () => picker.reflow(), { capture: true, passive: true });
window.addEventListener("resize", () => picker.reflow(), { passive: true });

document.addEventListener("DOMContentLoaded", () => {
  loaded = true;
  if (waiting) draw(waiting);
  waiting = null;
  mark("loaded");
});
const parentWindow = window.parent;
window.addEventListener("message", (e) => {
  if (e.source !== parentWindow) return;
  const m = e.data as { jsonrpc?: string; method?: string; params?: { mode?: string } & Partial<DrawDashboard> };
  if (m?.jsonrpc !== "2.0") return;
  if (m.method === HOST_METHODS.theme && (m.params?.mode === "light" || m.params?.mode === "dark")) {
    document.documentElement.dataset.theme = m.params.mode;
  }
  if (m.method === HOST_METHODS.probe) void runProbe();
  if (m.method === HOST_METHODS.pick) picker.set((m.params as { on?: unknown } | undefined)?.on === true);
  if (m.method === HOST_METHODS.dashboard && typeof m.params?.revision === "string" && m.params.definition) {
    if (!loaded) waiting = m.params as DrawDashboard;
    else draw(m.params as DrawDashboard);
  }
});

/**
 * What an App imports as `@opendash/app`: React, its data (named queries, filters, the record shown,
 * what-ifs), traced values, and the primitives worth reusing (a chart, a data grid, a written summary). Everything
 * else on its page is its own code.
 */
const appRuntime = {
  React,
  jsxRuntime,
  // What an App's JSX compiles to since select to edit (check.ts builds with jsxDev): marks each DOM element with where
  // it was written. Bundles built before keep `jsxRuntime`.
  jsxDevRuntime: { jsxDEV, Fragment: DevFragment },
  registerApp,
  useQuery,
  useFilter,
  useRecord,
  useAssumption,
  derive,
  // A figure says where it comes from on hover.
  Value: TracedValue,
  format,
  Chart: QueryChart,
  DataGrid,
  Source,
  Summary,
  mark,
  // The kit's controls: never hand-rolled in an App.
  Filter: AppFilter,
  Filters: AppFilters,
  Tabs: AppTabs,
  Segmented,
  Picker,
  Select: AppSelect,
  Search: AppSearch,
};
(window as unknown as { __OD_APP__: typeof appRuntime }).__OD_APP__ = appRuntime;
// Apps bundled by an older runtime find React here: their stored bundles are what the frame runs, so it stays as long
// as any of them does (removing it once left every such App drawing nothing).
(window as unknown as { __OD_RUNTIME__: { React: typeof React; jsxRuntime: typeof jsxRuntime } }).__OD_RUNTIME__ = {
  React,
  jsxRuntime,
};
