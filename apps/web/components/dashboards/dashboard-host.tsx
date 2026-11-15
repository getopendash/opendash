"use client";

import { AlertDialog, Button, toast } from "@heroui/react";
import { type DashboardPage, isDefinedError } from "@opendash/api/client";
import {
  DASHBOARD_TOOLS,
  type DashboardState,
  type DrawDashboard,
  FRAME_METHODS,
  type FrameMark,
  HOST_METHODS,
  type OpenRows,
  type Probed,
  type Readiness,
  type RowAction,
  type SectionAction,
  type WireResult,
} from "@opendash/apps/protocol";
import { SidePanel } from "@opendash/ui";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_ATTACHED } from "@/components/ask/attach-picker";
import { usePanelIfAny } from "@/components/panel/panel-context";
import { api } from "@/lib/api";
import { pickedSelection, selectionGate } from "@/lib/app-selection";
import { clearSettled, markSettled, openCount, openMs } from "./app-settled";
import { setPicking, usePicking } from "./select-mode";

type Filters = Record<string, { kind?: string; default?: string | string[] }>;
const filtersOf = (definition: unknown): Filters => (definition as { filters?: Filters }).filters ?? {};
const sameValue = (a: string | string[] | undefined, b: string | string[] | undefined) =>
  Array.isArray(a) && Array.isArray(b) ? [...a].sort().join("\n") === [...b].sort().join("\n") : a === b;

/**
 * The shareable state in the address: `?f_period=last_month&f_plan=Growth&f_plan=Scale&r=42`. Only what differs from
 * the definition's defaults is written. A choice of options is one parameter per value (a value may hold a
 * comma); an empty choice (every value) is the parameter with nothing in it. The frame checks each value against the
 * definition again.
 */
export function stateFromSearch(search: string, definition: unknown): Partial<DashboardState> {
  const params = new URLSearchParams(search);
  const filters: DashboardState["filters"] = {};
  for (const [id, f] of Object.entries(filtersOf(definition))) {
    if (!params.has(id)) continue;
    if (f.kind === "period") filters[id] = params.get(id) ?? "";
    else if (f.kind === "select") filters[id] = params.getAll(id).filter(Boolean);
  }
  // The record shown, as text: the server types it by its column.
  const record = params.get("r");
  // A key too long to be one is no key (never cut to another's).
  return { filters, ...(record && record.length <= 200 ? { record } : {}) };
}

/** The address for a state, the page's own parameters (`?draft=1`) kept. */
export function searchFromState(search: string, state: DashboardState, definition: unknown): string {
  const params = new URLSearchParams(search);
  const filters = filtersOf(definition);
  for (const id of Object.keys(filters)) params.delete(id);
  params.delete("r");
  for (const [id, f] of Object.entries(filters)) {
    const v = state.filters[id];
    if (v === undefined || sameValue(v, f.default)) continue;
    if (!Array.isArray(v)) params.set(id, v);
    else if (v.length === 0) params.set(id, "");
    else for (const x of v) params.append(id, x);
  }
  if (state.record !== undefined && state.record !== null && state.record !== "") params.set("r", String(state.record));
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** A frame that hasn't said it drew by now is uncovered anyway: what it shows (an error, nothing) is seen. */
const UNCOVER_MS = 8_000;
/** How long the App must have drawn with nothing loading before the render check's copies start. */
const SETTLE_QUIET_MS = 1_000;
/**
 * After this the render check starts whatever the App shows: one that never settles is still measured. Short enough
 * that with the check's own wait for answers (twelve seconds) a first measurement is kept before the analyst's
 * app_check stops waiting (twenty-five).
 */
const SETTLE_ANYWAY_MS = 6_000;
/** How long the line that logs an open may take. */
const OPENED_MS = 10_000;

const inFlight = new Map<string, Promise<unknown>>();

/**
 * The same requests for the same revision, asked while one is still on its way, wait for that one: the App and the
 * render check's copies open together and asked four times (a service's call ran six times). Only calls in flight are
 * shared: once an answer lands the next ask goes to the server, so a queued answer polled again is fresh (results
 * once stuck loading until a reload, when answers were held for 30 seconds). A Try again is never shared.
 */
function sharedAnswers<T>(
  input: { dashboardId: string; revision: string; requests: unknown; retry?: boolean },
  ask: () => Promise<T>,
): Promise<T> {
  if (input.retry) return ask();
  const key = JSON.stringify([input.dashboardId, input.revision, input.requests]);
  const held = inFlight.get(key);
  if (held) return held as Promise<T>;
  const answer = ask().finally(() => inFlight.delete(key));
  inFlight.set(key, answer);
  return answer;
}

/**
 * An App's frame and the page's half of its bridge: it sends the frame the App to draw (its revision, definition and
 * the state in the address) and the theme; it relays the frame's requests to the API under that
 * revision (only that one), mirrors its shareable state into the address, and opens the rows behind a number it
 * names. The frame's sandbox has no same-origin, so its origin is opaque ("null"): messages count only from this
 * frame's own window, and go only to it (the page's policy keeps the frame on the frames origin).
 */
export function DashboardHost({
  dashboard,
  draw,
  frameUrl,
  probe,
}: {
  dashboard: DashboardPage;
  /** What the frame draws: the saved version, or for its owner, their draft. */
  draw: {
    revision: string;
    definition: unknown;
    /** Draw rows' links: for its owner. */
    links?: boolean;
    /** Where each query reads, for the line under its piece. */
    reads?: DrawDashboard["reads"];
  };
  frameUrl: string;
  /**
   * The render check (apps as code): this frame is a hidden copy at a fixed width that only answers its frame's data
   * and, once it's loaded, asks it to measure itself; what it found goes to `onProbed`, which says (true) when to
   * measure again (its answers were still loading). Nothing else it says is acted on (no address, no panels, no
   * actions).
   */
  probe?: { onProbed(probed: Probed): boolean };
}) {
  const panel = usePanelIfAny();
  const frame = useRef<HTMLIFrameElement>(null);
  // One link per revision (the page is keyed by it): a refresh that signs a new link doesn't reload the frame.
  const [src] = useState(frameUrl);
  const { resolvedTheme } = useTheme();
  const [ready, setReady] = useState<Readiness | null>(null);
  // The frame said it drew: until then a quiet placeholder stands where the App will be (a frame is blank while its
  // runtime comes down), and from then its moments are this open's.
  const [drawn, setDrawn] = useState(false);
  // A frame that hasn't said it drew for a while is uncovered anyway (what it shows, an error or nothing, is seen):
  // that isn't a draw, so nothing that waits for one starts because of it.
  const [uncovered, setUncovered] = useState(false);
  // This open's moments, on this page's clock since it showed the App; the frame's clock runs from its own start, so
  // the gap between the two is taken from each mark as it arrives.
  const shownAt = useRef(0);
  const open = useRef<{ drawn?: number; answer?: number; gap?: number; frame: { runtime?: number; loaded?: number } }>({
    frame: {},
  });
  const logged = useRef(false);
  const [rows, setRows] = useState<OpenRows | null>(null);
  // A row's action being confirmed: what the server would send (its ticket), then how it went.
  const [acting, setActingState] = useState<ActingState | null>(null);
  const setActing = setActingState;
  // Each request about an action, numbered: an answer is shown only while its request is the latest (a dialog closed,
  // another action pressed or looked again since, and it's dropped).
  const actingSeq = useRef(0);

  const post = useCallback((message: unknown) => frame.current?.contentWindow?.postMessage(message, "*"), []);
  const send = useCallback(() => {
    const params: DrawDashboard = { ...draw, state: stateFromSearch(window.location.search, draw.definition) };
    post({ jsonrpc: "2.0", method: HOST_METHODS.theme, params: { mode: resolvedTheme === "dark" ? "dark" : "light" } });
    post({ jsonrpc: "2.0", method: HOST_METHODS.dashboard, params });
  }, [draw, post, resolvedTheme]);

  useEffect(() => {
    post({ jsonrpc: "2.0", method: HOST_METHODS.theme, params: { mode: resolvedTheme === "dark" ? "dark" : "light" } });
  }, [resolvedTheme, post]);
  // The dashboard goes when the frame says it's loaded, and now, in case it loaded before this page could hear it. The
  // same revision drawn again keeps the frame's state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, at mount
  useEffect(() => {
    shownAt.current = performance.now();
    send();
  }, []);
  // A frame that never says it drew (its code failed before it could) doesn't stay covered.
  useEffect(() => {
    const timer = setTimeout(() => setUncovered(true), UNCOVER_MS);
    return () => clearTimeout(timer);
  }, []);
  // The App a person sees has drawn and nothing of it is loading, for a moment: the render check's hidden copies may
  // start (app-settled.ts). After SETTLE_ANYWAY_MS they start whatever it shows: a broken or a slow App is still
  // measured, and within the time the analyst's app_check waits. It holds for this showing of the App only.
  useEffect(() => {
    if (probe) return;
    const anyway = setTimeout(() => markSettled(draw.revision), SETTLE_ANYWAY_MS);
    return () => {
      clearTimeout(anyway);
      clearSettled(draw.revision);
    };
  }, [probe, draw.revision]);
  useEffect(() => {
    if (probe || !drawn) return;
    if (Object.values(ready?.sections ?? {}).some((s) => s.state === "loading")) return;
    const quiet = setTimeout(() => markSettled(draw.revision), SETTLE_QUIET_MS);
    return () => clearTimeout(quiet);
  }, [probe, drawn, ready, draw.revision]);
  /**
   * Ask about a record, from a worked-in list's row: its owner asks in the conversation it was built in (the analyst
   * can change it there); anyone else, anew. Its key named, so the analyst can look it up, or act on it in a connected
   * service (which asks the person first).
   */
  const onAsk = (a: SectionAction) =>
    panel?.show({
      threadId: dashboard.mine ? (dashboard.threadId ?? null) : null,
      text: `About ${a.record} in “${a.section}” on the ${dashboard.title} dashboard: `,
    });
  const probeRef = useRef(probe);
  probeRef.current = probe;
  const onAskRef = useRef(onAsk);
  onAskRef.current = onAsk;

  // Select to edit: pick mode, turned on by the toggle of whoever changes it (its owner, an editor), for this frame only
  // (a render check's copy never picks).
  // What the frame says was clicked is taken only while it's on, for the revision drawn here, through the page's gate;
  // it becomes a chip on the panel's question, and nothing is sent until the person sends it.
  const picking = usePicking(dashboard.id) && dashboard.canEdit && !probe;
  const pickingRef = useRef(picking);
  pickingRef.current = picking;
  const gate = useRef(selectionGate({ max: MAX_ATTACHED, gapMs: 250 }));
  const hinted = useRef(false);
  useEffect(() => {
    if (picking) {
      gate.current = selectionGate({ max: MAX_ATTACHED, gapMs: 250 });
      hinted.current = false;
    }
    post({ jsonrpc: "2.0", method: HOST_METHODS.pick, params: { on: picking } });
  }, [picking, post]);
  const onPicked = (params: unknown) => {
    if (!pickingRef.current || !panel) return;
    const got = pickedSelection(params, { dashboardId: dashboard.id, revision: draw.revision }, () =>
      crypto.randomUUID(),
    );
    if (!got.ok) {
      // A bundle built before marks: said once a time pick mode is on.
      if (got.why === "unmarked" && !hinted.current) {
        hinted.current = true;
        toast("Save the App once to select pieces of it.");
      }
      return;
    }
    const taken = gate.current(got.piece);
    if (taken === "full") toast.danger(`A question takes ${MAX_ATTACHED} things: send it, or take one off.`);
    if (taken === "added") panel.attach(got.piece);
  };
  const onPickedRef = useRef(onPicked);
  onPickedRef.current = onPicked;

  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== "null") return;
      const m = e.data as { jsonrpc?: string; id?: number; method?: string; params?: unknown };
      if (m?.jsonrpc !== "2.0") return;
      if (m.method === FRAME_METHODS.call && typeof m.id === "number") {
        const call = m.params as {
          name?: string;
          arguments?: { revision?: string; requests?: unknown[]; retry?: boolean };
        };
        // A worked-in list's records: read, or one changed, under the revision this page sent.
        if (call.name === DASHBOARD_TOOLS.work && call.arguments?.revision === draw.revision) {
          const a = call.arguments as {
            section?: unknown;
            keys?: unknown;
            set?: unknown;
            snapshot?: unknown;
            history?: unknown;
          };
          // An App writes work on purpose (a call log, owners, statuses): the code that sends it is the analyst's, so the
          // server rate-limits its writes per App under a lock (core dashboards/work.ts).
          try {
            const result = await api.dashboards.work({
              dashboardId: dashboard.id,
              revision: draw.revision,
              section: String(a.section ?? ""),
              keys: (Array.isArray(a.keys) ? a.keys : []).map(String).slice(0, 200),
              ...(a.set && typeof a.set === "object" ? { set: a.set as never } : {}),
              ...(typeof a.snapshot === "string" ? { snapshot: a.snapshot } : {}),
              ...(typeof a.history === "string" && a.history.length <= 200 ? { history: a.history } : {}),
            });
            post({ jsonrpc: "2.0", id: m.id, result });
          } catch (error) {
            post({
              jsonrpc: "2.0",
              id: m.id,
              error: { message: error instanceof Error ? error.message : "It failed." },
            });
          }
          return;
        }
        // A summary's words: read, or asked to be written, under the revision this page sent.
        if (call.name === DASHBOARD_TOOLS.summary && call.arguments?.revision === draw.revision) {
          const a = call.arguments as {
            section?: unknown;
            filters?: unknown;
            write?: unknown;
            again?: unknown;
            angle?: unknown;
          };
          try {
            const result = await api.dashboards.summary({
              dashboardId: dashboard.id,
              revision: draw.revision,
              section: String(a.section ?? ""),
              filters: (a.filters ?? {}) as Record<string, string | string[]>,
              ...(a.write === true ? { write: true } : {}),
              ...(a.again === true ? { again: true } : {}),
              ...(a.angle === "lead" || a.angle === "short" || a.angle === "email" || a.angle === "fresh"
                ? { angle: a.angle }
                : {}),
            });
            post({ jsonrpc: "2.0", id: m.id, result });
          } catch (error) {
            post({
              jsonrpc: "2.0",
              id: m.id,
              error: { message: error instanceof Error ? error.message : "It failed." },
            });
          }
          return;
        }
        // Only the dashboard's own tools, and only under the revision this page sent.
        if (call.name !== DASHBOARD_TOOLS.query || call.arguments?.revision !== draw.revision) {
          post({ jsonrpc: "2.0", id: m.id, error: { message: "That isn't something this dashboard can ask." } });
          return;
        }
        try {
          const input = {
            dashboardId: dashboard.id,
            revision: draw.revision,
            requests: (call.arguments.requests ?? []) as never,
            // Try again: the server drops the failed answers it holds for these requests first.
            ...(call.arguments.retry === true ? { retry: true } : {}),
          };
          const result = await sharedAnswers(input, () => api.dashboards.query(input));
          post({ jsonrpc: "2.0", id: m.id, result });
        } catch (error) {
          post({ jsonrpc: "2.0", id: m.id, error: { message: error instanceof Error ? error.message : "It failed." } });
        }
        return;
      }
      // This open's moments (the frame's marks): kept, and once its answers are all in, logged as one line. A render
      // check's copy only uncovers itself.
      if (m.method === FRAME_METHODS.mark) {
        const mark = (m.params ?? {}) as Partial<FrameMark>;
        const since = openMs(performance.now() - shownAt.current);
        const t = openMs(mark.t);
        if (mark.name !== "answers" && since !== undefined && t !== undefined) open.current.gap = since - t;
        if (mark.name === "runtime" || mark.name === "loaded") open.current.frame[mark.name] = t;
        if (mark.name === "drawn") {
          open.current.drawn ??= since;
          setDrawn(true);
        }
        if (mark.name === "answer") open.current.answer ??= since;
        if (mark.name === "answers" && !probeRef.current && !logged.current) {
          logged.current = true;
          const speed = mark.speed;
          // When the last answer landed, on this page's clock: the frame says it a moment after, once nothing follows.
          const answers = t !== undefined && open.current.gap !== undefined ? openMs(t + open.current.gap) : since;
          const slowest = openMs(speed?.slowest?.[0]?.ms);
          void api.dashboards
            .opened(
              {
                dashboardId: dashboard.id,
                ...(open.current.drawn !== undefined ? { drawn: open.current.drawn } : {}),
                ...(open.current.answer !== undefined ? { answer: open.current.answer } : {}),
                ...(answers !== undefined ? { answers } : {}),
                frame: open.current.frame,
                asked: openCount(speed?.asked, 10_000),
                rounds: openCount(speed?.rounds, 1_000),
                looks: openCount(speed?.looks, 10_000),
                ...(slowest !== undefined ? { slowest } : {}),
              },
              // A log line: given up on after a while, and nothing waits for it.
              { signal: AbortSignal.timeout(OPENED_MS) },
            )
            .catch(() => {});
        }
      }
      if (m.method === FRAME_METHODS.mark && (m.params as { name?: string })?.name === "loaded") {
        send();
        if (probeRef.current) post({ jsonrpc: "2.0", method: HOST_METHODS.probe, params: {} });
        // A frame that loaded again while picking is told again.
        if (pickingRef.current) post({ jsonrpc: "2.0", method: HOST_METHODS.pick, params: { on: true } });
      }
      if (probeRef.current) {
        // Measured before its answers came in: measured again (the frame waits for them once more).
        if (m.method === FRAME_METHODS.probed && probeRef.current.onProbed(m.params as Probed)) {
          post({ jsonrpc: "2.0", method: HOST_METHODS.probe, params: {} });
        }
        return;
      }
      if (m.method === FRAME_METHODS.picked) {
        onPickedRef.current(m.params);
        return;
      }
      if (m.method === FRAME_METHODS.pickEnd) {
        if (pickingRef.current) setPicking(null);
        return;
      }
      if (m.method === FRAME_METHODS.state) {
        const search = searchFromState(window.location.search, m.params as DashboardState, draw.definition);
        if (search !== window.location.search)
          window.history.replaceState(null, "", `${window.location.pathname}${search}`);
      }
      if (m.method === FRAME_METHODS.ready) setReady(m.params as Readiness);
      if (m.method === FRAME_METHODS.section) {
        const a = m.params as Partial<SectionAction>;
        if (
          typeof a?.section === "string" &&
          a.section.length <= 64 &&
          a.action === "ask" &&
          typeof a.record === "string" &&
          a.record.length <= 200
        ) {
          onAskRef.current({ section: a.section, action: "ask", record: a.record });
        }
      }
      if (m.method === FRAME_METHODS.open) setRows(m.params as OpenRows);
      // A row's action: the frame only proposes it. The server says what it would send; this page shows that and runs
      // it only when the person confirms.
      if (m.method === FRAME_METHODS.act) {
        const a = m.params as Partial<RowAction> | undefined;
        const key = a?.key;
        if (
          typeof a?.section === "string" &&
          typeof a.action === "string" &&
          ((typeof key === "string" && key.length > 0 && key.length <= 200) ||
            (typeof key === "number" && Number.isFinite(key)))
        ) {
          const seq = ++actingSeq.current;
          const mine = (next: ActingState) => {
            if (actingSeq.current === seq) setActing(next);
          };
          setActing({ phase: "preparing" });
          api.dashboards
            .action({
              dashboardId: dashboard.id,
              revision: draw.revision,
              section: a.section,
              action: a.action,
              key,
              ...(typeof a.snapshot === "string" ? { snapshot: a.snapshot } : {}),
            })
            .then((prepared) => mine({ phase: "confirm", prepared }))
            .catch((e: unknown) =>
              mine({
                phase: "settled",
                status: "failed",
                result: isDefinedError(e) ? (e as { message: string }).message : "It couldn't be prepared.",
              }),
            );
        }
      }
      // A row's link: built here from its dataset's template and the one value pressed (never an address the frame
      // sends), for the dashboard's owner, https only.
      if (m.method === FRAME_METHODS.link && dashboard.mine) {
        const p = m.params as { dataset?: unknown; value?: unknown } | undefined;
        const ds =
          typeof p?.dataset === "string"
            ? (
                draw.definition as {
                  datasets?: Record<string, { service?: unknown; link?: { column?: string; url?: string } }>;
                }
              ).datasets?.[p.dataset]
            : undefined;
        const template = ds?.service && typeof ds.link?.url === "string" ? ds.link.url : null;
        if (template && typeof p?.value === "string" && p.value.length <= 200) {
          const url = template.replace(`{${ds?.link?.column}}`, encodeURIComponent(p.value));
          try {
            const u = new URL(url);
            const origin = new URL(template.replace(/\{[^}]*\}/g, "x")).origin;
            if (u.protocol === "https:" && !u.username && !u.password && u.origin === origin && !/[{}]/.test(url)) {
              window.open(u.toString(), "_blank", "noopener,noreferrer");
            }
          } catch {
            // Not an address: nothing opens.
          }
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [dashboard.id, dashboard.mine, draw.revision, draw.definition, post, send]);

  const counts = Object.values(ready?.sections ?? {}).reduce<Record<string, number>>((out, s) => {
    out[s.state] = (out[s.state] ?? 0) + 1;
    return out;
  }, {});
  return (
    <div className="flex min-h-0 flex-1">
      <div
        className={`relative min-h-0 min-w-0 flex-1 ${picking ? "outline-2 -outline-offset-2 outline-accent" : ""}`}
        data-od-revision={draw.revision}
        data-od-generation={ready?.generation ?? -1}
        data-od-sections={JSON.stringify(counts)}
      >
        {picking ? (
          <p
            role="status"
            className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-accent px-3 py-1 text-small text-accent-foreground"
          >
            Click a piece of the App to add it to your question · Esc to stop
          </p>
        ) : null}
        <iframe
          ref={frame}
          src={src}
          title={dashboard.title}
          sandbox="allow-scripts"
          className="h-full w-full border-0"
        />
        {drawn || uncovered || probe ? null : (
          <div aria-hidden className="pointer-events-none absolute inset-0 flex flex-col gap-6 bg-background p-6">
            <span className="h-5 w-48 animate-pulse rounded-sm bg-surface-secondary" />
            <span className="h-24 w-full animate-pulse rounded-sm bg-surface-secondary" />
            <span className="h-48 w-full animate-pulse rounded-sm bg-surface-secondary" />
          </div>
        )}
      </div>
      <ActionDialog
        state={acting}
        onClose={() => {
          actingSeq.current++;
          setActing(null);
        }}
        onConfirm={(ticket) => {
          const seq = ++actingSeq.current;
          const setActing = (next: ActingState) => {
            if (actingSeq.current === seq) setActingState(next);
          };
          setActingState((s) =>
            s?.phase === "confirm" ? { ...s, phase: "running" } : s?.phase === "settled" ? { ...s, checking: true } : s,
          );
          api.dashboards
            .actionRun({ ticket })
            .then((out) => {
              if (out.status === "running") {
                setActing({
                  phase: "settled",
                  status: "unknown",
                  result: "It's still running: look again in a moment.",
                  ticket,
                });
                return;
              }
              setActing({ phase: "settled", status: out.status, result: out.result });
              if (out.status === "done") {
                // A replay of one that already ran says it again, quietly.
                if (!out.again) toast.success("Done.");
                // The service changed: the page reads it again.
                post({ jsonrpc: "2.0", method: HOST_METHODS.refresh });
              }
            })
            .catch((e: unknown) =>
              setActing(
                isDefinedError(e)
                  ? { phase: "settled", status: "failed", result: (e as { message: string }).message }
                  : {
                      // The answer was lost on the way: it may have run. The same ticket says how it settled; a new
                      // press could change it twice.
                      phase: "settled",
                      status: "unknown",
                      result: "OpenDash didn't hear back. Look again to see whether it ran.",
                      ticket,
                    },
              ),
            );
        }}
      />
      {rows ? (
        <SidePanel title="Rows" subtitle={rows.label} onClose={() => setRows(null)} wide>
          <RowsList
            key={JSON.stringify(rows)}
            dashboardId={dashboard.id}
            revision={draw.revision}
            open={rows}
            onAsk={(n) =>
              panel?.show({
                threadId: dashboard.mine ? (dashboard.threadId ?? null) : null,
                text: `About the ${n} rows behind “${rows.label}” on the ${dashboard.title} dashboard (${rowsWords(rows)}): `,
              })
            }
          />
        </SidePanel>
      ) : null}
    </div>
  );
}

type ActingState =
  | { phase: "preparing" }
  | { phase: "confirm" | "running"; prepared: PreparedAction }
  /** `ticket`: an outcome not known yet, looked for again with the same ticket (never a new one). */
  | { phase: "settled"; status: "done" | "failed" | "unknown"; result: string; ticket?: string; checking?: boolean };

type PreparedAction = Awaited<ReturnType<typeof api.dashboards.action>>;

/**
 * A row's action, confirmed on this page (never in the frame): the question, the service and whose account, and
 * exactly what will be sent. Then how it went, in the service's own words as plain text.
 */
function ActionDialog({
  state,
  onClose,
  onConfirm,
}: {
  state: ActingState | null;
  onClose: () => void;
  onConfirm: (ticket: string) => void;
}) {
  const open = state !== null;
  const prepared = state && "prepared" in state ? state.prepared : null;
  return (
    <AlertDialog>
      <AlertDialog.Backdrop isOpen={open} onOpenChange={(o) => (!o && state?.phase !== "running" ? onClose() : null)}>
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Heading>
                {state?.phase === "settled"
                  ? state.status === "done"
                    ? "Done"
                    : state.status === "unknown"
                      ? "Not sure it ran"
                      : "It didn't change"
                  : (prepared?.question ?? "Getting it ready…")}
              </AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              {prepared && state?.phase !== "settled" ? (
                <div className="grid gap-3">
                  <p className="text-body text-muted">
                    It changes {prepared.server}, as you
                    {prepared.account ? ` (${prepared.account})` : " (your own account)"}: {prepared.tool} with
                  </p>
                  <dl className="grid gap-1.5 rounded-lg border border-border p-3 text-small">
                    {Object.entries(prepared.arguments).map(([k, v]) => (
                      <div key={k} className="flex min-w-0 gap-3">
                        <dt className="shrink-0 text-muted">{k}</dt>
                        <dd className="min-w-0 break-words font-mono text-small">
                          {typeof v === "string" ? v : JSON.stringify(v)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ) : state?.phase === "settled" ? (
                <p className="text-body text-muted">{state.result}</p>
              ) : (
                <p className="text-body text-muted">Checking what it would send…</p>
              )}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              {state?.phase === "settled" ? (
                <>
                  {state.ticket ? (
                    <Button
                      variant="ghost"
                      isPending={state.checking ?? false}
                      onPress={() => state.ticket && onConfirm(state.ticket)}
                    >
                      Look again
                    </Button>
                  ) : null}
                  <Button variant="secondary" onPress={onClose}>
                    Close
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" onPress={onClose} isDisabled={state?.phase === "running"}>
                    Cancel
                  </Button>
                  <Button
                    isDisabled={!prepared || state?.phase !== "confirm"}
                    isPending={state?.phase === "running"}
                    onPress={() => prepared && onConfirm(prepared.ticket)}
                  >
                    {prepared?.label ?? "Confirm"}
                  </Button>
                </>
              )}
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}

const time = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const day = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
const human = (name: string) => name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
/** A cell as the frame shows it: dates as UTC days, amounts grouped, a key as it is. */
function cellText(v: number | string | null | undefined, kind: string, key: boolean): string {
  if (v === null || v === undefined || v === "") return "—";
  if (kind === "date") {
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? String(v) : day.format(d);
  }
  return kind === "number" && !key ? Number(v).toLocaleString("en-US") : String(v);
}

/** The rows behind a number: its drill query under the same filters, narrowed to its group, asked until they land. */
/** Which rows a sheet holds, in words the analyst can read them again by: its query, its group and its filters. */
function rowsWords(open: OpenRows): string {
  const said = (v: unknown) => (Array.isArray(v) ? v.join(" or ") : String(v));
  const group = Object.entries(open.group).map(([k, v]) => `${human(k)} ${v === null ? "empty" : said(v)}`);
  const filters = Object.entries(open.filters)
    .filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== "" && v !== undefined))
    .map(([k, v]) => `${k} ${said(v)}`);
  return [
    `the rows of ${open.drill}`,
    group.length ? `where ${group.join(", ")}` : null,
    filters.length ? `under ${filters.join(", ")}` : null,
    open.record !== undefined ? `for record ${open.record}` : null,
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 400);
}

/** One page of the rows behind a number, asked until it lands (a queued answer is asked again). */
async function readRows(
  dashboardId: string,
  revision: string,
  open: OpenRows,
  page: number,
): Promise<{ result?: WireResult; error?: string }> {
  let at: string | undefined;
  for (let tries = 0; tries < 40; tries++) {
    const [a] = await api.dashboards.query({
      dashboardId,
      revision,
      requests: [
        {
          id: "rows",
          drill: open.drill,
          filters: open.filters,
          group: open.group,
          page,
          ...(open.record !== undefined ? { record: open.record } : {}),
          ...(open.pin ? { pin: open.pin } : {}),
          ...(at ? { at } : {}),
        },
      ],
    });
    if (!a) return { error: "It didn't answer." };
    if (a.status === "ok") return { result: a.result };
    if (a.status === "failed") return { error: a.error };
    if (a.status === "queued") at = a.at;
    await new Promise((r) => setTimeout(r, Math.min(2_000, 300 * 1.5 ** tries)));
  }
  return { error: "It took too long: try again." };
}

/** The most rows a CSV holds. */
const CSV_ROWS = 5_000;

/**
 * A cell as CSV: quoted when it must be, and never a formula (a spreadsheet would run a cell that starts with = + - @,
 * a tab, a line break, or one of their full-width forms): those start with an apostrophe.
 */
export function csvCell(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return "";
  let t = String(v);
  // A formula's first character, a control a spreadsheet trims, or their full-width forms.
  if (typeof v === "string" && /^[=+\-@\t\r\n\uFF1D\uFF0B\uFF0D\uFF20]/.test(t)) t = `'${t}`;
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

function RowsList({
  dashboardId,
  revision,
  open,
  onAsk,
}: {
  dashboardId: string;
  revision: string;
  open: OpenRows;
  /** Asks about these rows, in the Ask panel. */
  onAsk: (count: number) => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const [page, setPage] = useState(0);
  const [answer, setAnswer] = useState<{ result?: WireResult; error?: string } | null>(null);
  useEffect(() => {
    let stopped = false;
    let at: string | undefined;
    setAnswer(null);
    const ask = async (tries: number) => {
      try {
        const [a] = await api.dashboards.query({
          dashboardId,
          revision,
          requests: [
            {
              id: "rows",
              drill: open.drill,
              filters: open.filters,
              group: open.group,
              page,
              ...(open.record !== undefined ? { record: open.record } : {}),
              ...(open.pin ? { pin: open.pin } : {}),
              ...(at ? { at } : {}),
            },
          ],
        });
        if (stopped || !a) return;
        // A page past the last (fewer rows now): back to the first.
        if (a.status === "ok" && a.result.pastEnd && page > 0) setPage(0);
        else if (a.status === "ok") setAnswer({ result: a.result });
        else if (a.status === "failed") setAnswer({ error: a.error });
        else {
          if (a.status === "queued") at = a.at;
          setTimeout(() => void ask(tries + 1), Math.min(2_000, 300 * 1.5 ** tries));
        }
      } catch (error) {
        if (!stopped) setAnswer({ error: error instanceof Error ? error.message : "It failed." });
      }
    };
    void ask(0);
    return () => {
      stopped = true;
    };
  }, [dashboardId, revision, open, page]);
  const r = answer?.result;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-6">
      <p className="text-small text-muted">
        The rows under this number's filters{Object.keys(open.group).length ? " and its group" : ""}.{" "}
        {open.note ?? "They add up to the number."}
      </p>
      {answer?.error ? <p className="text-body text-danger">{answer.error}</p> : null}
      {!answer ? <p className="text-body text-muted">Reading the rows…</p> : null}
      {r ? (
        <>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-small">
              <thead>
                <tr className="border-b border-border text-left text-muted">
                  {r.columns.map((c) => (
                    <th
                      key={c.name}
                      className={`whitespace-nowrap px-3 py-2 font-medium ${c.kind === "number" && c.name !== r.key ? "text-right" : ""}`}
                    >
                      {human(c.name)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: r.rowCount }, (_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows have no key of their own here
                  <tr key={i} className="border-b border-border last:border-0">
                    {r.columns.map((c) => (
                      <td
                        key={c.name}
                        className={`whitespace-nowrap px-3 py-1.5 ${c.kind === "number" && c.name !== r.key ? "text-right tabular-nums" : ""}`}
                      >
                        {cellText(c.values[i], c.kind, c.name === r.key)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-small text-muted">
            <span>{r.total ? `${page * 50 + 1}–${page * 50 + r.rowCount} of ${r.total}` : "No rows."}</span>
            <span className="flex gap-1">
              <Button size="sm" variant="ghost" isDisabled={page === 0} onPress={() => setPage(page - 1)}>
                Previous
              </Button>
              <Button
                size="sm"
                variant="ghost"
                isDisabled={(page + 1) * 50 >= r.total}
                onPress={() => setPage(page + 1)}
              >
                Next
              </Button>
            </span>
          </div>
          {r.total ? (
            // Where they came from, and what to do with them.
            <div className="flex flex-col gap-2 border-t border-border pt-3">
              <p className="text-small text-muted">
                {r.service
                  ? `From ${r.service.name}${r.service.scope === "personal" ? ", read as you" : ""} · read ${time.format(new Date(r.service.fetchedAt))}`
                  : `From ${human(r.dataset)} · read ${time.format(new Date(r.asOf))}`}
              </p>
              <span className="flex flex-wrap gap-2">
                <Button size="sm" onPress={() => onAsk(r.total)}>
                  Ask about {r.total === 1 ? "this row" : `these ${r.total.toLocaleString("en-US")}`}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  isPending={downloading}
                  onPress={() => {
                    setDownloading(true);
                    void (async () => {
                      try {
                        const pages: WireResult[] = [r];
                        for (let p = 1; p * 50 < Math.min(r.total, CSV_ROWS); p++) {
                          const got = await readRows(dashboardId, revision, open, p);
                          if (!got.result) throw new Error(got.error ?? "A page didn't load.");
                          pages.push(got.result);
                        }
                        // The first page is the one on screen when it's page 0; otherwise read it too.
                        if (page !== 0) {
                          const first = await readRows(dashboardId, revision, open, 0);
                          if (!first.result) throw new Error(first.error ?? "A page didn't load.");
                          pages[0] = first.result;
                        }
                        const head = r.columns.map((c) => csvCell(human(c.name))).join(",");
                        const lines = pages.flatMap((pg) =>
                          Array.from({ length: pg.rowCount }, (_, i) =>
                            pg.columns.map((c) => csvCell(c.values[i] as number | string | null)).join(","),
                          ),
                        );
                        const blob = new Blob([`${head}\n${lines.slice(0, CSV_ROWS).join("\n")}\n`], {
                          type: "text/csv;charset=utf-8",
                        });
                        const url = URL.createObjectURL(blob);
                        const link = document.createElement("a");
                        link.href = url;
                        link.download = `${
                          open.label
                            .replace(/[^\p{L}\p{N} ,._-]+/gu, " ")
                            .trim()
                            .slice(0, 80) || "rows"
                        }.csv`;
                        link.click();
                        URL.revokeObjectURL(url);
                        if (r.total > CSV_ROWS) toast(`The first ${CSV_ROWS.toLocaleString("en-US")} rows were saved.`);
                      } catch (e) {
                        toast.danger(e instanceof Error ? e.message : "It couldn't be saved.");
                      } finally {
                        setDownloading(false);
                      }
                    })();
                  }}
                >
                  Download CSV
                </Button>
              </span>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
