// An App drawn in the frame: its bundle registers its page, and the page's own code draws it
// with the primitives here (its named queries, filters and record; a chart, a data grid, a written summary; the kit's
// controls). The store lives here (filter values, the record shown, each grid's page, sort and selected row); the page
// around the frame keeps the shareable part (filters and record) in its address and draws with it.
//
// Each piece stands alone: its reserved height, a skeleton only after 150 ms, the last answer kept while the next
// loads. A filter change bumps the generation; every piece's state goes to the page under it, again whenever one
// changes.
import {
  Component,
  type ComponentType,
  createContext,
  type ErrorInfo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { groupsOf } from "../dashboard/contracts";
import type { Definition, NamedQuery } from "../dashboard/definition";
import { PERIODS, type PeriodPreset } from "../dashboard/periods";
import { safeRowLink } from "../dashboard/service";
import {
  countAlias,
  DASHBOARD_TOOLS,
  type DashboardState,
  type DrawDashboard,
  FRAME_METHODS,
  type FrameMark,
  HOST_METHODS,
  type OpenRows,
  type OpenSpeed,
  type QueryRead,
  type RowAction,
  type SectionState,
  type SummaryState,
  type WorkState,
} from "../protocol";
import { callTool, notify } from "./bridge";
import { type ChartInput, drawChart, human, Palette } from "./charts";
import { DateRange, InlineLabels, ValuePicker } from "./controls";
import {
  type Answer,
  type Ask,
  type Client,
  type Condition,
  createClient,
  empty,
  keyOf,
  openingCells,
  type Result,
} from "./data";
import { ChartView, type Column, FilterBar, readTheme, SearchInput, Select, Table, useThemeKey } from "./kit";
import { type Format, format, type Traced, Value } from "./values";

type Values = Record<string, string | string[]>;

/** What an App's Chart draws: a query, its type and the options that type takes (charts.ts reads them). */
type ChartSpec = { id: string; query: string; title?: string; format?: Format } & Omit<
  ChartInput,
  "query" | "result" | "previous" | "theme" | "colors" | "periodColumn" | "width" | "format" | "title"
>;
/** What an App's DataGrid draws: a rows query's columns, and what its query declares (work, actions, paging, totals). */
interface GridSpec {
  /** Its query's id: the server holds every request it makes to that query's declaration. */
  id: string;
  query: string;
  columns?: { column: string; label?: string; format?: Column["format"]; tones?: Column["tones"] }[];
  work?: NamedQuery["work"];
  actions?: NamedQuery["actions"];
  filterable?: boolean;
  pageSizes?: number[];
  totals?: NonNullable<NamedQuery["rows"]>["totals"];
}
/** One of the App's written summaries: the queries it's written from, and what to look for. */
interface SummarySpec {
  id: string;
  queries: string[];
  prompt?: string;
}

interface GridState {
  page: number;
  sort?: string;
  selected: { index: number; row: Record<string, unknown> } | null;
  /** Rows a page holds, from those the grid offers. */
  pageSize?: number;
  /** Its conditions on its columns (a filterable grid). */
  where?: Condition[];
  /** The column whose filter is open. */
  open?: string | null;
}

interface Store {
  definition: Definition;
  revision: string;
  filters: Values;
  setFilter(id: string, value: string | string[]): void;
  grids: Record<string, GridState>;
  setGrid(id: string, patch: Partial<GridState>): void;
  client: Client;
  /** The record the App shows (its key), or none. */
  record: string | number | null;
  setRecord(key: string | number | null): void;
  /** Rows' links are drawn (the dashboard's owner is looking). */
  links: boolean;
  report(id: string, state: SectionState, error?: string): void;
  /** Goes up with each filter change: every piece reports again for it, an answer already there included. */
  generation: number;
  /** Where each query reads ("Warehouse · Accounts"), for the line under its piece; none when the page didn't say. */
  reads: Record<string, QueryRead>;
}

const StoreContext = createContext<Store | null>(null);
const useStore = () => {
  const s = useContext(StoreContext);
  if (!s) throw new Error("An App's hooks work inside its page.");
  return s;
};

// ---- data -------------------------------------------------------------------------------------------------------------

/**
 * A query's answer, and the period before for one that compares, with the filters it was asked with. While a newer
 * answer loads, or after it failed, the last answer stays (stale), with why the newer one failed and a way to try again.
 */
export type NamedResult = Result & {
  previous?: Result;
  /** The filters this answer was asked with: what a click on one of its numbers opens. */
  asked: Values;
  /** The last answer, shown while the next one loads or after it failed. */
  stale?: boolean;
  /** Why the next answer failed, the last one kept. */
  failed?: string;
  /** Asks again after a failure, the server's failed answer dropped too. */
  retry?: () => void;
  /** The record it was asked for. */
  record?: string | number | null;
  /** Drawn for a record, and none is picked: nothing is asked. */
  noRecord?: boolean;
};

/** A record's key for a query drawn for one (`record`), when one is shown: what every ask of that query carries. */
const scoped = (store: Store, queryId: string) =>
  store.definition.queries[queryId]?.record && store.record !== null ? { record: store.record } : {};

/** The filters a query takes, with their values now. */
const applicable = (q: NamedQuery | undefined, filters: Values): Values =>
  Object.fromEntries(Object.keys(q?.filters ?? {}).map((f) => [f, filters[f] ?? []]));

/** A named query's answer under the filters as they are (rows: a page and a sort). Nothing ever flashes empty. */
export function useNamedQuery(
  queryId: string,
  opts: {
    page?: number;
    sort?: string;
    pageSize?: number;
    where?: Condition[];
    search?: string;
    /** A query with a key asked for one record. */
    record?: string | number | null;
  } = {},
): NamedResult {
  const store = useStore();
  const q = store.definition.queries[queryId];
  const filters = applicable(q, store.filters);
  // A query drawn for a record takes the record shown, and asks nothing until one is.
  const record = q?.record ? store.record : (opts.record ?? null);
  const waiting = Boolean(q?.record) && record === null;
  const ask: Ask = {
    query: queryId,
    filters,
    ...(record !== null ? { record } : {}),
    ...(opts.page ? { page: opts.page } : {}),
    ...(opts.sort ? { sort: opts.sort } : {}),
    ...(opts.pageSize ? { pageSize: opts.pageSize } : {}),
    ...(opts.where?.length ? { where: opts.where } : {}),
    ...(opts.search ? { search: opts.search } : {}),
  };
  const entry = useSyncExternalStore(store.client.subscribe, () => (waiting ? undefined : store.client.get(ask)));
  useHold(store.client, waiting || !q ? null : ask);
  const last = useRef<NamedResult | null>(null);
  if (!q) return { ...empty("error", `There's no query ${queryId}.`), asked: filters };
  if (waiting) return { ...empty("ok"), asked: filters, record, noRecord: true };
  // The last answer stays while the next loads, only for the same record: never one record's under another's head.
  const kept = last.current && last.current.record === record ? last.current : null;
  const retry = () => store.client.retry(ask);
  if (entry?.result.status === "ok") {
    const result = entry.result;
    const shown: NamedResult = {
      ...result,
      // Each of its cells carries what opens the rows behind it, for Value.
      cell: openingCells(result, queryId, groupsOf(q), filters),
      ...(entry.previous ? { previous: entry.previous } : {}),
      asked: filters,
      record,
    };
    last.current = shown;
    return shown;
  }
  if (entry?.result.status === "error") {
    const why = entry.result.error ?? "It failed.";
    // A service's answer is its account's: when it fails (signed out, refused, changed), nothing from before stays.
    const own = store.definition.datasets?.[q.source.dataset];
    const service = Boolean(own && "service" in own);
    // Gone for good: a retry starts from nothing, never from the rows before.
    if (service) last.current = null;
    return kept && !service
      ? { ...kept, stale: true, failed: why, retry }
      : { ...entry.result, asked: filters, record, retry };
  }
  return kept ? { ...kept, status: "loading", stale: true } : { ...empty("loading"), asked: filters, record };
}

/**
 * Any other answer the frame asks for (a filter's values, a column's counts, a grid's totals), or nothing while `ask`
 * is null (a panel that's closed asks for nothing).
 */
function useAnswer(ask: Ask | null): Result | null {
  const store = useStore();
  const entry = useSyncExternalStore(store.client.subscribe, () => (ask ? store.client.get(ask) : undefined));
  useHold(store.client, ask);
  if (!ask) return null;
  return entry ? entry.result : empty("loading");
}

/**
 * This piece shows a request while it's drawn with it: when it shows another (a search typed on, another record) or
 * goes, the request stops being asked for, and its answer is kept only among the last few nobody shows.
 */
function useHold(client: Client, ask: Ask | null) {
  const key = ask ? keyOf(ask) : null;
  const asked = useRef(ask);
  asked.current = ask;
  useEffect(() => (key && asked.current ? client.hold(asked.current) : undefined), [client, key]);
}

/** A filter's value, and how to set it. */
export function useFilter(filterId: string): [string | string[] | undefined, (value: string | string[]) => void] {
  const store = useStore();
  return [store.filters[filterId], (value) => store.setFilter(filterId, value)];
}

// ---- pieces: a chart, a grid, a summary ---------------------------------------------------------------------------

// A query drawn for a record with none picked asked nothing, so nothing came back empty: the render check used to tell
// the analyst it "returned no rows", a finding that can't be fixed.
const stateOf = (r: NamedResult): SectionState =>
  r.status === "loading"
    ? "loading"
    : r.status === "error" || r.failed
      ? "error"
      : r.rowCount === 0 && !r.noRecord
        ? "empty"
        : "data";

/** The App's boundary: what its code throws is shown in its place, and reported. */
class Boundary extends Component<
  { id: string; report: Store["report"]; children: ReactNode },
  { error: Error | null }
> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.report(this.props.id, "error", error.message);
    notify(FRAME_METHODS.error, {
      section: this.props.id,
      message: error.message,
      stack: info.componentStack?.slice(0, 600),
    });
  }
  override render() {
    return this.state.error ? (
      <p className="od-error">This App hit an error: {this.state.error.message}</p>
    ) : (
      this.props.children
    );
  }
}

/** Shows a skeleton only once loading has lasted 150 ms: a quick answer draws without a flash. */
function useLate(loading: boolean): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!loading) {
      setLate(false);
      return;
    }
    const t = setTimeout(() => setLate(true), 150);
    return () => clearTimeout(t);
  }, [loading]);
  return late && loading;
}

/** Reports a piece's state whenever it changes, and again for each filter generation. */
function useReport(id: string, result: NamedResult) {
  const { report, generation } = useStore();
  const state = stateOf(result);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new generation reports the same state again
  useEffect(() => report(id, state, result.error), [id, state, result.error, report, generation]);
}

/**
 * Opens the rows behind a number of a query that declares its drill (nothing for one that doesn't), under the filters
 * the number was asked with: a kept answer opens its own rows, never the ones of filters still loading.
 */
function useOpen(queryId: string) {
  const store = useStore();
  const q = store.definition.queries[queryId];
  // Every number opens its rows: a declared drill, or the columns the dashboard shows of its dataset (the server's).
  return q?.drill || q?.measures
    ? (group: Record<string, string | number | null>, label: string, asked: Values, pin?: string) => {
        const note = rowsNote(q);
        const open: OpenRows = {
          drill: queryId,
          filters: asked,
          group,
          label,
          ...(note ? { note } : {}),
          // A service's number: its rows are read from the read it was made from.
          ...(pin ? { pin } : {}),
          ...scoped(store, queryId),
        };
        notify(FRAME_METHODS.open, open);
      }
    : null;
}

/**
 * What the rows behind a number are, when they aren't one row per thing it counts: a distinct count lists every row
 * (one may appear more than once), a named measure is worked out from them.
 */
function rowsNote(q: Definition["queries"][string]): string | null {
  const ms = Object.entries(q.measures ?? {});
  const distinct = ms.find(([, m]) => m[0] === "count_distinct");
  if (distinct)
    return `It counts distinct ${String(distinct[1][1]).replace(/_/g, " ")}: one may appear in several rows.`;
  const named = ms.find(([, m]) => m[0] === "measure" || m[0] === "metric");
  if (named) return `${humanName(named[0])} is worked out from these rows, not one row each.`;
  return null;
}

const humanName = human;

/** Where a service's rows came from, and when: "From Jira · as of 10:42", and when it wasn't all of it. */
function ServiceNote({ service, read }: { service: NonNullable<Result["service"]>; read: QueryRead | undefined }) {
  const at = new Date(service.fetchedAt);
  // Where, then when: "Fullstory · Checkout funnel · as of 10:42".
  const where = read ? `${read.source} · ${read.dataset}` : service.name;
  const time = Number.isNaN(at.getTime())
    ? where
    : `${where} · as of ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return (
    <p
      className="od-service-note"
      title={
        service.scope === "org"
          ? `Read from ${service.name} with the workspace's account: everyone sees the same`
          : `Read from ${service.name} with your own account: each person sees their own`
      }
    >
      <Mark mark={read?.mark} />
      <span className="od-source-text">
        {time}
        {service.incomplete ? ` · ${service.name} had more than it returned: counts here are of what it returned` : ""}
        {service.unread
          ? ` · ${service.unread} ${service.unread === 1 ? "value" : "values"} didn't read as ${service.unread === 1 ? "its column's type" : "their columns' types"} and count as empty`
          : ""}
      </span>
    </p>
  );
}

/** After 3 s of loading, a piece says so. */
function useSlow(loading: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!loading) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), 3000);
    return () => clearTimeout(t);
  }, [loading]);
  return slow && loading;
}

/** The filters that narrow an answer, in words: "Country: DE · Period: Last month". */
function narrowedBy(definition: Definition, asked: Values): string {
  return Object.entries(asked)
    .flatMap(([id, v]) => {
      const f = definition.filters[id];
      if (!f) return [];
      if (f.kind === "period") {
        const value = Array.isArray(v) ? v[0] : v;
        return value ? [`${f.label}: ${PERIOD_LABELS[value as PeriodPreset] ?? value}`] : [];
      }
      const values = Array.isArray(v) ? v : [];
      return values.length ? [`${f.label}: ${values.join(", ")}`] : [];
    })
    .join(" · ");
}

/** A piece's shape while its first answer loads: its bars or rows, never a made-up number. */
function Skeleton({ kind, slow }: { kind: "chart" | "grid"; slow: boolean }) {
  const note = slow ? <p className="od-slow">Still loading…</p> : null;
  if (kind === "chart") {
    return (
      <div className="od-skel-chart">
        <div className="od-skel-bars">
          {Array.from({ length: 12 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: identical ghost bars
            <span key={i} className="od-bone" />
          ))}
        </div>
        {note}
      </div>
    );
  }
  return (
    <div className="od-skel-grid">
      {Array.from({ length: 7 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: identical ghost rows
        <span key={i} className={`od-bone${i === 0 ? " od-bone-head" : ""}`} />
      ))}
      {note}
    </div>
  );
}

/**
 * How a piece looks in each of its states: its shape from the first moment (a skeleton after 150 ms, so a
 * quick answer draws without a flash); "Still loading" after 3 s; a newer answer loading over the last one, which stays,
 * faded, under a thin line; empty, naming the filters that emptied it; an error in the source's words with Try again,
 * the last answer kept when there was one.
 */
function StateFrame({
  kind,
  query,
  result,
  children,
  emptyShown = false,
}: {
  kind: "chart" | "grid";
  /** The query it shows: its source is said under it. */
  query: string;
  result: NamedResult;
  children: ReactNode;
  /** Its own content says it's empty (a grid narrowed by its own conditions keeps them, to undo). */
  emptyShown?: boolean;
}) {
  const store = useStore();
  const loading = result.status === "loading";
  const late = useLate(loading && !result.stale);
  const slow = useSlow(loading);
  const retry = result.retry ? (
    <button type="button" className="od-retry" onClick={result.retry}>
      Try again
    </button>
  ) : null;
  if (result.noRecord) {
    return (
      <div className={`od-empty od-for-${kind}`}>
        <p>Pick a record to see this.</p>
      </div>
    );
  }
  if (result.status === "error" && !result.stale) {
    return (
      <div className={`od-state-error od-for-${kind}`} role="alert">
        <p>
          <strong>Couldn't load this</strong>
          <span>{result.error}</span>
        </p>
        {retry}
      </div>
    );
  }
  if (loading && !result.stale) {
    return (
      <div className={`od-skel od-skel-for-${kind}`} role="status" aria-busy="true" aria-label="Loading">
        {late ? <Skeleton kind={kind} slow={slow} /> : null}
      </div>
    );
  }
  const by = narrowedBy(store.definition, result.asked);
  return (
    <div className={`od-stateful od-for-${kind}${result.stale ? " od-stale" : ""}`} aria-busy={loading || undefined}>
      {loading ? <span className="od-progress" aria-hidden /> : null}
      {result.failed ? (
        <div className="od-refresh-failed" role="alert">
          <span>Couldn't refresh: {result.failed} The last answer is shown.</span>
          {retry}
        </div>
      ) : null}
      {result.rowCount === 0 && !emptyShown ? (
        <div className="od-empty">
          <p>Nothing to show{by ? ` for ${by}` : ""}.</p>
          {by ? <p className="od-empty-hint">Try other values in the filters above.</p> : null}
        </div>
      ) : (
        children
      )}
      {/* A service's rows say where and when they were read, and when they weren't all of it; any other piece says
          where its numbers come from. */}
      {result.service ? <ServiceNote service={result.service} read={store.reads[query]} /> : <Source query={query} />}
      {slow ? <p className="od-slow">Still loading…</p> : null}
    </div>
  );
}

/** The column a query's period filter narrows, when one does. */
const periodColumnOf = (definition: Definition, q: NamedQuery | undefined) =>
  Object.entries(q?.filters ?? {}).find(([f]) => definition.filters[f]?.kind === "period")?.[1];

/** A box's width, in steps of 20 px, while `on`: what a calendar fits its cells to. Watched from when the box is. */
function useWidth(el: HTMLElement | null, on: boolean): number | undefined {
  const [width, setWidth] = useState<number>();
  useEffect(() => {
    if (!on || !el) return;
    const ro = new ResizeObserver(() => setWidth(Math.round(el.clientWidth / 20) * 20));
    ro.observe(el);
    return () => ro.disconnect();
  }, [on, el]);
  return width;
}

function ChartSection({ s }: { s: ChartSpec }) {
  const definition = useStore().definition;
  const q = definition.queries[s.query];
  const result = useNamedQuery(s.query);
  useReport(s.id, result);
  const open = useOpen(s.query);
  const theme = useThemeKey();
  const [palette] = useState(() => new Palette());
  // The box appears with the first answer (the skeleton comes before it): watched from then.
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const width = useWidth(box, s.type === "calendar");
  // Drawn again when the answer, the theme or the width (a calendar's) changes; not on every render.
  const answer = `${result.status}:${result.requestId}:${result.asOf}:${result.previous?.requestId}:${result.period?.from}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the answer, not its wrapper
  const drawn = useMemo(
    () =>
      q
        ? drawChart({
            ...s,
            title: s.title,
            format: (s.format ?? "number") as Format,
            query: q,
            result,
            previous: result.previous,
            theme: readTheme(),
            colors: palette,
            width,
            periodColumn: periodColumnOf(definition, q),
          })
        : null,
    [answer, theme, width, s, q, palette, definition],
  );
  return (
    <StateFrame
      kind="chart"
      query={s.query}
      result={result}
      emptyShown={!!drawn && drawn.points === 0 && result.rowCount > 0}
    >
      <div ref={setBox}>
        {drawn ? (
          drawn.points === 0 && result.rowCount > 0 ? (
            <div className="od-empty">
              <p>Nothing to draw.</p>
              {drawn.notes.length ? <p className="od-empty-hint">{drawn.notes.join(" ")}</p> : null}
            </div>
          ) : (
            <ChartView
              drawn={drawn}
              {...(open
                ? {
                    onPick: (picked: { group: Record<string, string | number | null>; label: string }) =>
                      open(picked.group, picked.label, result.asked, result.service?.snapshot),
                  }
                : {})}
            />
          )
        ) : null}
      </div>
    </StateFrame>
  );
}

/** A condition in words: "Plan: Growth, Scale", "MRR ≥ 100", "Name contains acme". */
function conditionWords(c: Condition, label: string): string {
  const v = c[2];
  if (c[1] === "in") return `${label}: ${(v as unknown[]).join(", ")}`;
  if (c[1] === "contains") return `${label} contains ${String(v)}`;
  if (c[1] === "is null") return `${label} is empty`;
  const date = typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v);
  if (c[1] === "<" && date) {
    // A day's end is the next midnight, not included: the last day in it is the one before.
    const last = new Date(`${String(v).slice(0, 10)}T00:00:00Z`);
    last.setUTCDate(last.getUTCDate() - 1);
    return `${label} ≤ ${last.toISOString().slice(0, 10)}`;
  }
  const shown = date ? String(v).slice(0, 10) : format(v, "number");
  return `${label} ${c[1] === ">=" ? "≥" : c[1] === "<" ? "<" : "≤"} ${shown}`;
}

/** A column's filter, by its kind: its values with their counts (searched), or a range of numbers or days. */
function ColumnFilter({
  queryId,
  column,
  label,
  kind,
  where,
  onApply,
}: {
  queryId: string;
  column: string;
  label: string;
  kind: "text" | "number" | "date";
  where: Condition[];
  onApply(conditions: Condition[]): void;
}) {
  const store = useStore();
  const mine = where.filter((c) => c[0] === column);
  const [search, setSearch] = useState("");
  const [typed, setTyped] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSearch(typed), 250);
    return () => clearTimeout(t);
  }, [typed]);
  const chosen = (mine.find((c) => c[1] === "in")?.[2] as string[] | undefined) ?? [];
  const emptyChosen = mine.some((c) => c[1] === "is null");
  const facet = useAnswer(
    kind === "text"
      ? {
          facet: { query: queryId, column },
          ...scoped(store, queryId),
          filters: applicable(store.definition.queries[queryId], store.filters),
          ...(where.length ? { where } : {}),
          ...(search.trim() ? { search: search.trim() } : {}),
        }
      : null,
  );
  const lo = mine.find((c) => c[1] === ">=")?.[2];
  // The last day of a range is stored as the next midnight, not included: shown as the day before.
  const before = mine.find((c) => c[1] === "<")?.[2];
  const hi =
    mine.find((c) => c[1] === "<=")?.[2] ??
    (typeof before === "string"
      ? new Date(new Date(`${before.slice(0, 10)}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10)
      : undefined);
  const [from, setFrom] = useState(lo === undefined ? "" : String(lo).slice(0, kind === "date" ? 10 : undefined));
  const [to, setTo] = useState(hi === undefined ? "" : String(hi).slice(0, kind === "date" ? 10 : undefined));
  if (kind === "text") {
    const values = facet?.status === "ok" ? Array.from(facet.col(column)) : [];
    const counts = facet?.status === "ok" ? Array.from(facet.col(countAlias(column))) : [];
    // Empty (null) is its own choice: rows with no value, never ones with "" in them. Conditions all hold together,
    // so it's chosen alone, and a value chosen after it replaces it.
    const toggle = (v: string | null) => {
      if (v === null) return onApply(emptyChosen ? [] : [[column, "is null"]]);
      const next = chosen.includes(v) ? chosen.filter((x) => x !== v) : [...chosen, v];
      onApply(next.length ? [[column, "in", next]] : []);
    };
    return (
      <div className="od-colfilter">
        <input
          className="od-picker-search"
          type="search"
          placeholder={`Search ${label.toLowerCase()}`}
          aria-label={`Search ${label}`}
          value={typed}
          // biome-ignore lint/a11y/noAutofocus: the filter opened to search
          autoFocus
          onChange={(e) => setTyped(e.target.value)}
        />
        <ul className="od-picker-list" aria-busy={facet?.status === "loading" || undefined}>
          {values.map((v, i) => {
            const value = v === null ? null : String(v);
            const on = value === null ? emptyChosen : chosen.includes(value);
            return (
              <li key={value ?? "\u0000empty"}>
                <button
                  type="button"
                  className={on ? "od-option od-option-on" : "od-option"}
                  aria-pressed={on}
                  onClick={() => toggle(value)}
                >
                  <span className="od-check" aria-hidden>
                    {on ? "✓" : ""}
                  </span>
                  <span className="od-option-label">{value ?? "(empty)"}</span>
                  <span className="od-count">{format(counts[i], "number")}</span>
                </button>
              </li>
            );
          })}
          {facet?.status === "ok" && !values.length ? <li className="od-picker-none">Nothing matches.</li> : null}
          {facet?.status === "loading" && !values.length ? <li className="od-picker-none">Looking…</li> : null}
          {facet?.status === "error" ? <li className="od-picker-none">{facet.error}</li> : null}
        </ul>
      </div>
    );
  }
  const type = kind === "date" ? "date" : "number";
  const value = (v: string) => (kind === "number" ? Number(v) : v);
  return (
    <form
      className="od-colfilter od-colrange"
      aria-label={`Filter ${label}`}
      onSubmit={(e) => {
        e.preventDefault();
        const next: Condition[] = [];
        if (from !== "") next.push([column, ">=", value(from)]);
        if (to !== "" && kind === "date") {
          // To the end of its last day: before the next midnight, so no time later that day is left out.
          const end = new Date(`${to}T00:00:00Z`);
          end.setUTCDate(end.getUTCDate() + 1);
          next.push([column, "<", end.toISOString().slice(0, 10)]);
        } else if (to !== "") next.push([column, "<=", value(to)]);
        onApply(next);
      }}
    >
      <label className="od-field">
        <span>From</span>
        <input type={type} value={from} onChange={(e) => setFrom(e.target.value)} />
      </label>
      <label className="od-field">
        <span>To</span>
        <input type={type} value={to} onChange={(e) => setTo(e.target.value)} />
      </label>
      <button type="submit" className="od-btn">
        Apply
      </button>
    </form>
  );
}

/**
 * A grid (the DataGrid): its rows a page at a time, sorted, sized and narrowed by its own column filters (chips to
 * undo each), a totals row over every row its filters select, and its density. Nothing in its state is anything but
 * names and values the server checks against the definition.
 */
function GridSection({ s }: { s: GridSpec }) {
  const store = useStore();
  const q = store.definition.queries[s.query];
  const grid = store.grids[s.id] ?? { page: 0, selected: null };
  const where = grid.where ?? [];
  const pageSize = grid.pageSize ?? s.pageSizes?.[0] ?? q?.page ?? 50;
  const result = useNamedQuery(s.query, {
    page: grid.page,
    ...(grid.sort ? { sort: grid.sort } : {}),
    ...(s.pageSizes ? { pageSize } : {}),
    ...(where.length ? { where } : {}),
  });
  const totals = useAnswer(
    s.totals && !result.noRecord
      ? {
          totals: s.id,
          filters: applicable(q, store.filters),
          ...scoped(store, s.query),
          ...(where.length ? { where } : {}),
        }
      : null,
  );
  useReport(s.id, result);
  // A page past the last (the data changed, or an old address): back to the first.
  useEffect(() => {
    if (result.pastEnd && grid.page > 0) store.setGrid(s.id, { page: 0, selected: null });
  }, [result.pastEnd, grid.page, s.id, store]);
  const kinds = new Map(result.columns.map((c) => [c.name, c.kind]));
  const declared: {
    column: string;
    label?: string;
    format?: Column["format"];
    tones?: Column["tones"];
  }[] = s.columns ?? (q?.select ?? []).map((column) => ({ column }));
  // A service dataset's row link (its declared template, on its declared host only).
  const ownDs = q ? store.definition.datasets?.[q.source.dataset] : undefined;
  // Drawn for the dashboard's owner only (store.links): others' rows are read with their own accounts.
  const link = ownDs && "service" in ownDs && store.links ? ownDs.link : undefined;
  const columns: Column[] = declared.map((c) => {
    const kind = kinds.get(c.column);
    return {
      ...(link && link.column === c.column
        ? {
            linkOf: (i: number) => {
              const value = result.rows[i]?.[link.column];
              const url = safeRowLink(link.url, result.rows[i] ?? {});
              return url && value !== null && value !== undefined && q
                ? { url, dataset: q.source.dataset, value: String(value) }
                : null;
            },
          }
        : {}),
      ...(c.tones ? { tones: c.tones } : {}),
      key: c.column,
      label: c.label ?? human(c.column),
      // A key is an id, not an amount: no grouping.
      format:
        c.format ??
        (c.column === result.key ? "text" : kind === "number" ? "number" : kind === "date" ? "date" : "text"),
    };
  });
  // A worked-in list: its records' owner, status, follow-up and note, drawn after its own columns.
  const work = useWork(s, result);
  // A worked record's history, opened from its row's ⋯.
  const [historyKey, setHistoryKey] = useState<string | null>(null);
  if (work) {
    // The list's own columns keep their names: a worked-in one that would read the same is said as ours.
    const taken = new Set(columns.map((c) => c.label.toLowerCase()));
    columns.push(
      ...work.columns.map((c) =>
        c.label && taken.has(c.label.toLowerCase()) ? { ...c, label: `Our ${c.label.toLowerCase()}` } : c,
      ),
    );
  }
  // A row's tools, kept at the right edge: its actions (a change in a service, confirmed on the page) and Ask.
  const tools = rowTools(s, result, (key) => setHistoryKey((k) => (k === key ? null : key)));
  if (tools) columns.push(tools);
  const workError = work?.error ?? null;
  const labelOf = (key: string) => columns.find((c) => c.key === key)?.label ?? human(key);
  const setWhere = (next: Condition[]) => store.setGrid(s.id, { where: next, page: 0, selected: null });
  const open = grid.open ?? null;
  // Totals stand beside the rows they total: none while the rows shown are an earlier answer.
  const totalsRow =
    !result.stale && totals?.status === "ok" && totals.rowCount
      ? Object.fromEntries(Object.keys(s.totals ?? {}).map((col) => [col, totals.col(col)[0]]))
      : null;
  const panel = open ? (
    <div className="od-filter-panel">
      <p className="od-filter-title">
        Filter {labelOf(open)}
        <button
          type="button"
          className="od-icon-btn"
          aria-label="Close the filter"
          onClick={() => store.setGrid(s.id, { open: null })}
        >
          ×
        </button>
      </p>
      <ColumnFilter
        key={open}
        queryId={s.query}
        column={open}
        label={labelOf(open)}
        kind={kinds.get(open) ?? "text"}
        where={where}
        onApply={(mine) => setWhere([...where.filter((c) => c[0] !== open), ...mine])}
      />
    </div>
  ) : null;
  return (
    <StateFrame kind="grid" query={s.query} result={result} emptyShown={where.length > 0}>
      <div className="od-grid-bar">
        <div className="od-chips">
          {where.map((c, i) => (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: a condition is its place in the list
              key={i}
              type="button"
              className="od-chip"
              aria-label={`Remove ${conditionWords(c, labelOf(c[0]))}`}
              onClick={() => setWhere(where.filter((_, j) => j !== i))}
            >
              {conditionWords(c, labelOf(c[0]))} <span aria-hidden>×</span>
            </button>
          ))}
          {where.length > 1 ? (
            <button type="button" className="od-btn-quiet" onClick={() => setWhere([])}>
              Clear
            </button>
          ) : null}
        </div>
      </div>
      {workError ? (
        <p className="od-work-error" role="status">
          {workError}
        </p>
      ) : null}
      {historyKey && s.work ? (
        <WorkHistory s={s} result={result} recordKey={historyKey} onClose={() => setHistoryKey(null)} />
      ) : null}
      <Table
        result={result}
        columns={columns}
        page={grid.page}
        pageSize={pageSize}
        onPage={(page) => store.setGrid(s.id, { page, selected: null })}
        {...(grid.sort ? { sort: grid.sort } : {})}
        onSort={(sort) => store.setGrid(s.id, { sort, page: 0, selected: null })}
        onRow={(row, index) => store.setGrid(s.id, { selected: { index, row } })}
        selected={grid.selected?.index ?? null}
        // One density, comfortable: no Comfortable/Compact choice.
        {...(s.pageSizes && s.pageSizes.length > 1
          ? {
              pageSizes: s.pageSizes,
              onPageSize: (n: number) => store.setGrid(s.id, { pageSize: n, page: 0, selected: null }),
            }
          : {})}
        {...(totalsRow ? { totals: totalsRow } : {})}
        {...(s.filterable
          ? {
              filtering: {
                active: [...new Set(where.map((c) => c[0]))],
                open,
                onFilter: (key: string) => store.setGrid(s.id, { open: open === key ? null : key }),
              },
              panel,
            }
          : {})}
      />
    </StateFrame>
  );
}

/** A source of a summary: its title, opening the rows behind it under the page's filters. */
function SummarySourceLink({ query, title }: { query: string; title: string }) {
  const store = useStore();
  const open = useOpen(query);
  return open ? (
    <button type="button" className="od-summary-source" onClick={() => open({}, title, store.filters)}>
      {title}
    </button>
  ) : (
    <span>{title}</span>
  );
}

function SummarySection({ s }: { s: SummarySpec }) {
  const store = useStore();
  // The page's filters as they are (a period is one value, a select a list): the server binds them.
  const filters = store.filters;
  const key = `${store.revision}:${s.id}:${JSON.stringify(filters)}`;
  const [held, setHeld] = useState<{ key: string; state: SummaryState }>({ key, state: { status: "waiting" } });
  // What's shown is this key's: another filter's words are never left on the page while these load.
  const state: SummaryState = held.key === key ? held.state : { status: "waiting" };
  const current = useRef(key);
  current.current = key;
  const setState = (next: SummaryState, forKey = key) => {
    if (current.current === forKey) setHeld({ key: forKey, state: next });
  };
  const [asked, setAsked] = useState(0);
  const ask = (write: boolean, again = false, angle?: string) =>
    callTool<SummaryState>(DASHBOARD_TOOLS.summary, {
      revision: store.revision,
      section: s.id,
      filters,
      ...(write ? { write: true } : {}),
      ...(again ? { again: true } : {}),
      ...(angle ? { angle } : {}),
    });
  // Read when it draws and whenever its filters change; asked again while its numbers load or it's being written.
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again by key and by presses
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const at = key;
    const read = async () => {
      try {
        const got = await ask(false);
        if (stopped) return;
        setState(got, at);
        if (got.status === "waiting" || got.status === "writing") timer = setTimeout(() => void read(), 2000);
      } catch (error) {
        if (!stopped) setState({ status: "failed", error: error instanceof Error ? error.message : "It failed." }, at);
      }
    };
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [key, asked]);
  const { report, generation } = store;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new generation reports again
  useEffect(() => {
    report(
      s.id,
      state.status === "failed"
        ? "error"
        : state.status === "ok" || state.status === "stale"
          ? "data"
          : state.status === "none"
            ? "empty"
            : "loading",
      state.status === "failed" ? state.error : undefined,
    );
  }, [s.id, state.status, report, generation]);
  const [angles, setAngles] = useState(false);
  const write = async (again: boolean, angle?: string) => {
    const at = key;
    setAngles(false);
    setState({ status: "writing" }, at);
    try {
      setState(await ask(true, again, angle), at);
    } catch (error) {
      setState({ status: "failed", error: error instanceof Error ? error.message : "It failed." }, at);
    }
    setAsked((n) => n + 1);
  };
  const at = state.status === "ok" || state.status === "stale" ? new Date(state.writtenAt) : null;
  const sources = "sources" in state ? (state.sources ?? []) : [];
  return (
    <div className={`od-summary od-summary-${state.status}`} aria-live="polite">
      <div className="od-summary-body">
        {state.status === "ok" ? (
          <p className="od-summary-text">{state.text}</p>
        ) : state.status === "stale" ? (
          <p className="od-summary-text od-summary-old">{state.text}</p>
        ) : state.status === "writing" ? (
          <p className="od-summary-empty">Writing a summary of the numbers shown…</p>
        ) : state.status === "waiting" ? (
          <p className="od-summary-empty">Waiting for its numbers…</p>
        ) : state.status === "failed" ? (
          <p className="od-summary-empty">{state.error}</p>
        ) : (
          <p className="od-summary-empty">
            An AI summary of {s.queries.length === 1 ? "this number" : "these numbers"}, written when you ask.
          </p>
        )}
        {sources.length && (state.status === "ok" || state.status === "stale") ? (
          // What it's written from: each opens the rows behind it (never a guess from a number in its words).
          <p className="od-summary-sources">
            From{" "}
            {sources.map((src, i) => (
              <span key={src.query}>
                {i ? (i === sources.length - 1 ? " and " : ", ") : null}
                {state.status === "ok" ? (
                  <SummarySourceLink query={src.query} title={src.title} />
                ) : (
                  // An older note's numbers aren't these: its sources are named, not opened.
                  <span>{src.title}</span>
                )}
              </span>
            ))}
          </p>
        ) : null}
        <div className="od-summary-foot">
          {at && !Number.isNaN(at.getTime()) ? (
            <span>
              {state.status === "stale" ? "Written from older numbers, " : "Written "}
              {at.toLocaleDateString([], { day: "numeric", month: "short" })},{" "}
              {at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              {state.status === "ok" ? " from the numbers shown · checked: it uses only them" : ""}
              {state.status === "ok" && state.cost
                ? ` · ${state.cost.note < 0.01 ? "under 1¢" : `${Math.round(state.cost.note * 100)}¢`} a rewrite, $${state.cost.month.toFixed(2)} this month`
                : ""}
            </span>
          ) : null}
          {state.status === "none" || state.status === "failed" ? (
            <button type="button" className="od-summary-act" onClick={() => void write(state.status === "failed")}>
              {state.status === "failed" ? "Try again" : "Write a summary"}
            </button>
          ) : state.status === "stale" ? (
            <button type="button" className="od-summary-act" onClick={() => void write(false)}>
              Refresh
            </button>
          ) : state.status === "ok" ? (
            <span className="od-summary-regen">
              <button
                type="button"
                className="od-summary-act"
                aria-expanded={angles}
                aria-haspopup="menu"
                onClick={() => setAngles((v) => !v)}
              >
                Regenerate
              </button>
              {angles ? (
                <span className="od-summary-angles" role="menu">
                  {(
                    [
                      ["fresh", "Same facts, new words", "keeps every figure"],
                      ["lead", "Lead with what to do", "the next step first"],
                      ["short", "Shorter", "one sentence"],
                      ["email", "Written for an email", "for someone outside the team"],
                    ] as const
                  ).map(([id, label, hint]) => (
                    <button
                      key={id}
                      type="button"
                      role="menuitem"
                      className="od-summary-angle"
                      onClick={() => void write(true, id)}
                    >
                      <span>{label}</span>
                      <span className="od-summary-angle-hint">{hint}</span>
                    </button>
                  ))}
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---- working in it ---------------------------------------------------------------------------------------------

/** A control in a row: its own clicks and keys, never the row's (which opens a record). */
const own = {
  onClick: (e: { stopPropagation(): void }) => e.stopPropagation(),
  onKeyDown: (e: { stopPropagation(): void }) => e.stopPropagation(),
};

const FIELD_WORDS = { owner: "the owner", status: "the status", note: "a note", follow_up: "the follow-up" } as const;

/**
 * A worked record: where it stands, its note, and its history, newest first: who changed what, when.
 * Read for the record as this viewer may see it (a list read with each person's own account: from their read).
 */
function WorkHistory({
  s,
  result,
  recordKey,
  onClose,
}: {
  s: GridSpec;
  result: NamedResult;
  recordKey: string;
  onClose: () => void;
}) {
  const store = useStore();
  const [state, setState] = useState<WorkState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const snapshot = result.service?.snapshot;
  useEffect(() => {
    let stopped = false;
    setState(null);
    callTool<WorkState>(DASHBOARD_TOOLS.work, {
      revision: store.revision,
      section: s.id,
      keys: [recordKey],
      history: recordKey,
      ...(snapshot ? { snapshot } : {}),
    })
      .then((got) => {
        if (!stopped) setState(got);
      })
      .catch((e: unknown) => {
        if (!stopped) setError(e instanceof Error ? e.message : "Its history didn't load.");
      });
    return () => {
      stopped = true;
    };
  }, [recordKey, store.revision, s.id, snapshot]);
  const people = new Map((state?.people ?? []).map((p) => [p.id, p.name]));
  const w = state?.work.find((x) => x.key === recordKey);
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const said = (field: keyof typeof FIELD_WORDS, value: string | null) =>
    field === "owner"
      ? value
        ? `gave it to ${people.get(value) ?? "someone"}`
        : "left it unassigned"
      : value === null
        ? `cleared ${FIELD_WORDS[field]}`
        : field === "note"
          ? "added a note"
          : field === "follow_up"
            ? `set a follow-up for ${day(`${value}T12:00:00Z`)}`
            : `set the status to ${value}`;
  return (
    <section className="od-work-card" aria-label={`${recordKey}: its work and history`}>
      <header className="od-work-card-head">
        <strong>{recordKey}</strong>
        {w?.status ? (
          <span className="od-work-status" data-meaning={s.work?.tones?.[w.status] ?? "neutral"}>
            {w.status}
          </span>
        ) : null}
        <span className="od-work-card-by">kept by OpenDash</span>
        <button type="button" className="od-icon-btn" aria-label="Close its history" onClick={onClose}>
          ×
        </button>
      </header>
      {error ? <p className="od-work-error">{error}</p> : null}
      {!state && !error ? <p className="od-work-card-muted">Reading its history…</p> : null}
      {state ? (
        <>
          <dl className="od-work-card-facts">
            <div>
              <dt>Owner</dt>
              <dd>{w?.ownerId ? (people.get(w.ownerId) ?? "Someone") : "Unassigned"}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{w?.status ?? "No status"}</dd>
            </div>
            <div>
              <dt>Follow up</dt>
              <dd>{w?.followUp ? day(`${w.followUp}T12:00:00Z`) : "None"}</dd>
            </div>
          </dl>
          {w?.note ? <p className="od-work-card-note">{w.note}</p> : null}
          <ol className="od-work-card-history">
            {(state.history ?? []).map((h, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a history's place is its key
              <li key={i}>
                <span>
                  {h.by ? (people.get(h.by) ?? "Someone") : "Someone"} {said(h.field, h.value)}
                </span>
                <span className="od-work-card-muted">{day(h.at)}</span>
              </li>
            ))}
            {state.history?.length ? null : <li className="od-work-card-muted">Nothing changed yet.</li>}
          </ol>
        </>
      ) : null}
    </section>
  );
}

/**
 * A row's tools in a list with a key: its actions, each proposed to the page (which shows what it would send and runs
 * it only when the person confirms), and, in a worked-in list, Ask about the record.
 */
function rowTools(s: GridSpec, result: NamedResult, onHistory: (key: string) => void): Column | null {
  const keyCol = result.key;
  const actions = s.actions ?? [];
  if (!keyCol || (!s.work && !actions.length)) return null;
  const keyAt = (i: number) => result.rows[i]?.[keyCol] as string | number | undefined;
  return {
    key: "__tools",
    label: "",
    pin: "end",
    width: 16 + actions.reduce((w, a) => w + 18 + a.label.length * 7, 0) + (s.work ? 72 : 0),
    render: (i) => {
      const key = keyAt(i);
      if (key === undefined || key === null || key === "") return null;
      return (
        <span className="od-row-tools">
          {actions.map((a) => (
            <button
              key={a.id}
              type="button"
              className="od-row-action"
              aria-label={`${a.label}: ${key}`}
              onClick={(e) => {
                e.stopPropagation();
                const act: RowAction = {
                  section: s.id,
                  action: a.id,
                  key,
                  ...(result.service?.snapshot ? { snapshot: result.service.snapshot } : {}),
                };
                notify(FRAME_METHODS.act, act);
              }}
              onKeyDown={own.onKeyDown}
            >
              {a.label}
            </button>
          ))}
          {s.work ? (
            <button
              type="button"
              className="od-work-more"
              aria-label={`History of ${key}`}
              onClick={(e) => {
                e.stopPropagation();
                onHistory(String(key));
              }}
              onKeyDown={own.onKeyDown}
            >
              ⋯
            </button>
          ) : null}
          {s.work ? (
            <button
              type="button"
              className="od-work-ask"
              aria-label={`Ask about ${key}`}
              onClick={(e) => {
                e.stopPropagation();
                notify(FRAME_METHODS.section, { section: s.id, action: "ask", record: String(key) });
              }}
              onKeyDown={own.onKeyDown}
            >
              Ask
            </button>
          ) : null}
        </span>
      );
    },
  };
}

/**
 * A worked-in list's records: read for the keys shown, changed one at a time (each change saved at once), and drawn
 * as four columns (owner, status, follow-up, note) and an Ask. Someone who only reads sees the work, unchanged.
 */
function useWork(s: GridSpec, result: NamedResult): { columns: Column[]; error: string | null } | null {
  const store = useStore();
  const keyCol = result.key;
  const keys =
    s.work && keyCol && result.status === "ok" ? result.rows.map((r) => String(r[keyCol] ?? "")).filter(Boolean) : [];
  const keysText = keys.join("\u0001");
  const [state, setState] = useState<WorkState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The rows on screen now: an answer for other rows (a page left, a save that came back late) isn't shown here.
  const shown = useRef(keysText);
  shown.current = keysText;
  // A record being saved: its controls wait, so two changes to it never cross.
  const [saving, setSaving] = useState<Set<string>>(new Set());
  // A note being written, by record: kept while another field's save comes back.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the keys shown change
  useEffect(() => {
    if (!s.work || !keys.length) return;
    let stopped = false;
    callTool<WorkState>(DASHBOARD_TOOLS.work, {
      revision: store.revision,
      section: s.id,
      keys,
      ...(result.service?.snapshot ? { snapshot: result.service.snapshot } : {}),
    })
      .then((got) => {
        if (stopped) return;
        setState(got);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!stopped) setError(e instanceof Error ? e.message : "Its work didn't load.");
      });
    return () => {
      stopped = true;
    };
  }, [keysText, store.revision]);
  if (!s.work || !keyCol) return null;
  const byKey = new Map((state?.work ?? []).map((w) => [w.key, w]));
  const people = new Map((state?.people ?? []).map((p) => [p.id, p.name]));
  const can = Boolean(state?.canWork);
  const save = (key: string, patch: Record<string, string | null>) => {
    const at = keysText;
    setError(null);
    setSaving((now) => new Set(now).add(key));
    callTool<WorkState>(DASHBOARD_TOOLS.work, {
      revision: store.revision,
      section: s.id,
      keys,
      set: { key, ...patch },
      ...(result.service?.snapshot ? { snapshot: result.service.snapshot } : {}),
    })
      .then((got) => {
        if (shown.current === at) setState(got);
        if ("note" in patch) {
          setDrafts((d) => {
            const { [key]: _done, ...rest } = d;
            return rest;
          });
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "It wasn't saved."))
      .finally(() =>
        setSaving((now) => {
          const next = new Set(now);
          next.delete(key);
          return next;
        }),
      );
  };
  const keyOf = (i: number) => String(result.rows[i]?.[keyCol] ?? "");
  const today = new Date().toISOString().slice(0, 10);
  const statuses = s.work.statuses;
  const tones = s.work.tones ?? {};
  const columns: Column[] = [
    {
      key: "__owner",
      label: "Owner",
      render: (i) => {
        const w = byKey.get(keyOf(i));
        const name = w?.ownerId ? (people.get(w.ownerId) ?? "Someone") : null;
        return can ? (
          <select
            className="od-work-select"
            aria-label={`Owner of ${keyOf(i)}`}
            disabled={saving.has(keyOf(i))}
            value={w?.ownerId ?? ""}
            onChange={(e) => save(keyOf(i), { ownerId: e.target.value || null })}
            {...own}
          >
            <option value="">Unassigned</option>
            {state?.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : (
          <span className={name ? "" : "od-person-none"}>{name ?? "Unassigned"}</span>
        );
      },
    },
    {
      key: "__status",
      label: "Status",
      render: (i) => {
        const w = byKey.get(keyOf(i));
        const by = w?.updatedBy ? people.get(w.updatedBy) : undefined;
        const title = w ? `Changed${by ? ` by ${by}` : ""} ${new Date(w.updatedAt).toLocaleDateString()}` : undefined;
        return can ? (
          <select
            className="od-work-select od-work-status"
            data-meaning={w?.status ? (tones[w.status] ?? "neutral") : undefined}
            aria-label={`Status of ${keyOf(i)}`}
            disabled={saving.has(keyOf(i))}
            title={title}
            value={w?.status ?? ""}
            onChange={(e) => save(keyOf(i), { status: e.target.value || null })}
            {...own}
          >
            <option value="">No status</option>
            {statuses.map((st) => (
              <option key={st} value={st}>
                {st}
              </option>
            ))}
          </select>
        ) : w?.status ? (
          <span className="od-pill" data-meaning={tones[w.status] ?? "neutral"} title={title}>
            <span className="od-pill-dot" aria-hidden />
            {w.status}
          </span>
        ) : (
          <span className="od-person-none">No status</span>
        );
      },
    },
    {
      key: "__follow",
      label: "Follow up",
      render: (i) => {
        const w = byKey.get(keyOf(i));
        const late = Boolean(w?.followUp && w.followUp < today);
        return can ? (
          <input
            type="date"
            className={`od-work-date${late ? " late" : ""}`}
            aria-label={`Follow up on ${keyOf(i)}${late ? " (past)" : ""}`}
            disabled={saving.has(keyOf(i))}
            value={w?.followUp ?? ""}
            onChange={(e) => save(keyOf(i), { followUp: e.target.value || null })}
            {...own}
          />
        ) : (
          <span className={late ? "od-work-late" : ""}>{w?.followUp ?? "—"}</span>
        );
      },
    },
    {
      key: "__note",
      label: "Note",
      render: (i) => {
        const w = byKey.get(keyOf(i));
        return can ? (
          <input
            className="od-work-note"
            aria-label={`Note on ${keyOf(i)}`}
            placeholder="Add a note"
            value={drafts[keyOf(i)] ?? w?.note ?? ""}
            maxLength={2000}
            onChange={(e) => {
              const v = e.target.value;
              setDrafts((d) => ({ ...d, [keyOf(i)]: v }));
            }}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== (w?.note ?? "")) save(keyOf(i), { note: v || null });
              else
                setDrafts((d) => {
                  const { [keyOf(i)]: _same, ...rest } = d;
                  return rest;
                });
            }}
            onClick={own.onClick}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        ) : (
          <span className="od-work-note-text">{w?.note ?? ""}</span>
        );
      },
    },
  ];
  return { columns, error };
}

// ---- filters --------------------------------------------------------------------------------------------------------

const PERIOD_LABELS: Record<(typeof PERIODS)[number], string> = {
  this_month: "This month",
  last_month: "Last month",
  last_3_months: "Last 3 months",
  last_6_months: "Last 6 months",
  last_12_months: "Last 12 months",
  this_year: "This year",
  last_year: "Last year",
};

/** The option that stands for several values chosen at once. */
const SEVERAL = "\u0000several";

/** A select filter: a plain choice of one listed value, or the value picker (several, searched, from the warehouse). */
function SelectFilter({ id, f }: { id: string; f: Extract<Definition["filters"][string], { kind: "select" }> }) {
  const store = useStore();
  const value = store.filters[id];
  const chosen = Array.isArray(value) ? value : [];
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  // Its values from the warehouse, asked only while its picker is open, under the other filters as they are.
  const lookup = useAnswer(
    f.values && open
      ? { lookup: id, filters: store.filters, ...scoped(store, f.values.from), ...(search ? { search } : {}) }
      : null,
  );
  if (f.multiple === false && !f.search && !f.values) {
    // Several chosen (an old address) show as they are, kept until another is picked.
    const several = chosen.length > 1;
    return (
      <Select
        label={f.label}
        value={several ? SEVERAL : (chosen[0] ?? "")}
        options={[
          { value: "", label: "All" },
          ...(several ? [{ value: SEVERAL, label: chosen.join(", ") }] : []),
          ...f.options.map((o) => ({ value: o, label: o })),
        ]}
        onChange={(v) => {
          if (v !== SEVERAL) store.setFilter(id, v ? [v] : []);
        }}
      />
    );
  }
  // A value from the warehouse comes back in the column the filter narrows in its query, with its count.
  const column = f.values ? store.definition.queries[f.values.from]?.filters[id] : undefined;
  const options =
    f.values && column && lookup?.status === "ok"
      ? Array.from(lookup.col(column), (v, i) => ({
          value: v === null ? "" : String(v),
          count: Number(lookup.col(countAlias(column))[i] ?? 0),
        })).filter((o) => o.value)
      : f.values
        ? []
        : f.options.map((o) => ({ value: o }));
  return (
    <ValuePicker
      label={f.label}
      value={chosen}
      multiple={f.multiple !== false}
      searchable={Boolean(f.search || f.values)}
      options={options}
      loading={lookup?.status === "loading"}
      {...(f.values ? { onSearch: setSearch } : {})}
      onOpenChange={setOpen}
      onChange={(v) => store.setFilter(id, v)}
    />
  );
}

/** The values to start from: the page's (checked against the definition), else each filter's default. */
function startingFilters(d: Definition, given: Values | undefined): Values {
  const out: Values = {};
  for (const [id, f] of Object.entries(d.filters)) {
    const v = given?.[id];
    if (f.kind === "period") out[id] = typeof v === "string" ? v : f.default;
    else if (!Array.isArray(v)) out[id] = f.default;
    else {
      // Listed: only its options. From the warehouse: any value of text the server would take (it checks again).
      const kept = f.values
        ? v.filter((x) => typeof x === "string" && x.length <= 200).slice(0, 50)
        : v.filter((x) => f.options.includes(x));
      out[id] = f.multiple === false ? kept.slice(0, 1) : kept;
    }
  }
  return out;
}

/** The drawn revision's pieces' states, as last reported: what the render check reads. */
let lastStates: { revision: string; states: Record<string, { state: SectionState; error?: string }> } = {
  revision: "",
  states: {},
};
export const currentStates = () => lastStates;

/** The drawn revision's data client: how its answers came in is what the render check says about its speed. */
let lastClient: Client | null = null;
export const currentSpeed = (): OpenSpeed | null => lastClient?.speed() ?? null;

/**
 * How long nothing may be asked for before an open's answers count as all in: a piece that waits for another's answer
 * asks within a render of it landing.
 */
const SETTLED_MS = 400;
/** An App that has asked for nothing by now asks for nothing: its open is said with no answers. */
const NOTHING_ASKED_MS = 2_000;

// ---- an App: its bundle registers the page it is, and its CSS ------------------------------------------------------

let app: { App: ComponentType; css: string } | null = null;
const appListeners = new Set<() => void>();
/** The App's bundle calls this as it loads: its page, and its CSS (Tailwind for its classes, then its own). */
export function registerApp(App: ComponentType, css: string) {
  app = { App, css };
  let style = document.getElementById("od-app-css") as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = "od-app-css";
    document.head.appendChild(style);
  }
  style.textContent = css;
  for (const fn of appListeners) fn();
}
const useApp = () =>
  useSyncExternalStore(
    (fn) => {
      appListeners.add(fn);
      return () => appListeners.delete(fn);
    },
    () => app,
  );

/** The App, once its bundle is in; until then its page waits (the bundle loads after the runtime). */
function AppRoot() {
  const store = useStore();
  const loaded = useApp();
  if (!loaded) return <div className="od-app-wait" aria-busy="true" />;
  const App = loaded.App;
  return (
    <Boundary id="app" report={store.report}>
      <App />
    </Boundary>
  );
}

/** A named query's answer, as an App asks for it: reported to the page like a piece's (its readiness). */
export function useQuery(queryId: string, opts: Parameters<typeof useNamedQuery>[1] = {}): NamedResult {
  const result = useNamedQuery(queryId, opts);
  useReport(`query:${queryId}`, result);
  return result;
}

/** The record shown (its key), and how to show another: in the address, so a link opens it. */
export function useRecord(): [string | number | null, (key: string | number | null) => void] {
  const store = useStore();
  return [store.record, store.setRecord];
}

type ChartProps = Omit<ChartSpec, "id"> & { id?: string };
/**
 * A query drawn as a chart (an App's primitive): every chart type the kit draws, its tooltips, its numbers opening the
 * rows behind them, its states. Its frame, title and layout are the App's own.
 */
export function Chart(props: ChartProps) {
  return <ChartSection s={{ ...props, id: props.id ?? `${props.query}:${props.type}` }} />;
}

type GridProps = Omit<GridSpec, "id">;
/**
 * A query's rows as a data grid (an App's primitive): sorting, paging, column conditions, totals, work and actions as
 * its query declares them; its id is the query's, so the server holds every request to that declaration.
 */
export function DataGrid(props: GridProps) {
  // What its query declares comes with it (an App's grid once never got its query's work or
  // actions): work on each row, its row actions, column conditions, page sizes and totals; props narrow them.
  const q = useStore().definition.queries[props.query];
  const declared = {
    ...(q?.work ? { work: q.work } : {}),
    ...(q?.actions ? { actions: q.actions } : {}),
    ...(q?.rows?.conditions ? { filterable: true } : {}),
    ...(q?.rows?.pageSizes ? { pageSizes: q.rows.pageSizes } : {}),
    ...(q?.rows?.totals ? { totals: q.rows.totals } : {}),
  };
  return <GridSection s={{ ...declared, ...props, id: props.query }} />;
}

/**
 * Where a query's numbers come from, in a quiet line: "Warehouse · Accounts", "Fullstory · Checkout funnel" (an App's
 * primitive). Charts and grids say it under themselves; a piece the App draws itself from a query puts this under it.
 * Verified or not is said on hover, never as a label on every piece.
 */
export function Source({ query }: { query: string }) {
  const read = useStore().reads[query];
  if (!read) return null;
  const where = [read.source, read.dataset].filter(Boolean).join(" · ");
  const why =
    read.provenance === "verified"
      ? "Verified: definitions an admin released"
      : read.provenance === "table"
        ? "The analyst's own SQL over the source's tables: checked to run safely, not verified by an admin"
        : read.provenance === "service"
          ? `Read from ${read.source}, live`
          : read.provenance === "unverified"
            ? "A definition not released by an admin yet: its checks passed"
            : "";
  return (
    <p className="od-source" title={[where, why].filter(Boolean).join(". ")}>
      <Mark mark={read.mark} />
      <span className="od-source-text">{where}</span>
    </p>
  );
}

/**
 * The source's mark before its name ("[Jira] Jira · Issues"): one path on the source's colour, sent with the read (the
 * frame loads nothing). None when OpenDash has no mark for it: the name alone, as before.
 */
function Mark({ mark }: { mark: QueryRead["mark"] }) {
  if (!mark) return null;
  return (
    <span
      className="od-source-mark"
      style={
        mark.onWhite ? { backgroundColor: "#ffffff", color: mark.bg } : { backgroundColor: mark.bg, color: mark.fg }
      }
      aria-hidden
    >
      <svg viewBox={mark.viewBox} fill="currentColor" aria-hidden>
        <path d={mark.path} />
      </svg>
    </span>
  );
}

/** The datasets a figure was read from: a cell's own, every input's for one worked out from others. */
function datasetsOf(of: Traced): { dataset: string; query?: string }[] {
  if (of.kind === "cell")
    return [{ dataset: of.source.dataset, ...(of.source.open ? { query: of.source.open.query } : {}) }];
  if (of.kind === "derived") return of.inputs.flatMap(datasetsOf);
  return [];
}

/**
 * A figure from the data (an App's primitive): the kit's Value, saying where it comes from on hover, so a stat an App
 * draws itself is traced to its source like a chart. Found by the dataset its cells were read from.
 * A cell of a query's answer opens the rows behind it when pressed, as a chart's point does (its query's drill, under
 * the filters it was asked with); a figure worked out from others, or a query whose numbers don't open, only says where.
 */
export function TracedValue(props: Parameters<typeof Value>[0]) {
  const { definition, reads } = useStore();
  const of = props.of;
  const target = of?.kind === "cell" ? of.source.open : undefined;
  const open = useOpen(target?.query ?? "");
  const onOpen =
    props.onOpen ??
    (open && target && of?.kind === "cell"
      ? () =>
          open(
            target.group,
            [
              human(of.source.column),
              ...Object.values(target.group).map((v) => (v === null ? "(none)" : String(v))),
            ].join(", "),
            target.asked,
            target.pin,
          )
      : undefined);
  const from = of
    ? [
        ...new Set(
          datasetsOf(of).flatMap(({ dataset, query }) => {
            // Its own query when the cell says (two queries may read one dataset from two sources), else its dataset's.
            const qid =
              query ?? Object.keys(definition.queries).find((q) => definition.queries[q]?.source.dataset === dataset);
            const read = qid ? reads[qid] : undefined;
            return read ? [`${read.source} · ${read.dataset}`] : [];
          }),
        ),
      ].join(", ")
    : "";
  return <Value {...props} {...(from ? { from } : {})} {...(onOpen ? { onOpen } : {})} />;
}

/** One of the App's summaries, written from its queries' answers (an App's primitive). */
export function Summary({ id }: { id: string }) {
  const own = useStore().definition.summaries?.[id];
  if (!own) return <p className="od-error">There's no summary {id}.</p>;
  return <SummarySection s={{ id, queries: own.queries, ...(own.prompt ? { prompt: own.prompt } : {}) }} />;
}

export function Dashboard({ draw }: { draw: DrawDashboard }) {
  const definition = draw.definition as Definition;
  const { revision } = draw;
  const [filters, setFilters] = useState(() => startingFilters(definition, draw.state?.filters));
  const [grids, setGrids] = useState<Record<string, GridState>>({});
  const [record, setRecord] = useState<string | number | null>(draw.state?.record ?? null);
  const generation = useRef(0);
  const [generationShown, setGenerationShown] = useState(0);
  const client = useMemo(
    () =>
      createClient((requests, opts) =>
        callTool<Answer[]>(DASHBOARD_TOOLS.query, { revision, requests, ...(opts?.retry ? { retry: true } : {}) }),
      ),
    [revision],
  );

  // How this open went, said to the page once each: when its first answer landed, and when every answer was in (with
  // how they came in). The page logs it; nothing here is drawn from it.
  useEffect(() => {
    lastClient = client;
    let first = false;
    let all = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const said = (m: FrameMark) => notify(FRAME_METHODS.mark, m);
    const heard = () => {
      const speed = client.speed();
      if (!first && speed.answered > 0) {
        first = true;
        said({ name: "answer", t: Math.round(performance.now()) });
      }
      clearTimeout(timer);
      if (all || !speed.asked || client.pending()) return;
      const t = Math.round(performance.now());
      timer = setTimeout(() => {
        if (all || client.pending()) return;
        all = true;
        // What's asked after this (a filter changed, a page turned) isn't this open's.
        said({ name: "answers", t, speed: client.settleSpeed() });
      }, SETTLED_MS);
    };
    const stop = client.subscribe(heard);
    const nothing = setTimeout(() => {
      if (all || client.speed().asked) return;
      all = true;
      said({ name: "answers", t: Math.round(performance.now()), speed: client.settleSpeed() });
    }, NOTHING_ASKED_MS);
    return () => {
      stop();
      clearTimeout(timer);
      clearTimeout(nothing);
    };
  }, [client]);

  // Something changed outside (a row's action ran): every answer is read again.
  useEffect(() => {
    const parent = window.parent;
    const heard = (e: MessageEvent) => {
      const m = e.data as { jsonrpc?: string; method?: string } | null;
      if (e.source === parent && m?.jsonrpc === "2.0" && m.method === HOST_METHODS.refresh) client.reset();
    };
    window.addEventListener("message", heard);
    return () => window.removeEventListener("message", heard);
  }, [client]);

  // Every piece's state, sent again whenever one changes (one that fails later included).
  const states = useRef<Record<string, { state: SectionState; error?: string }>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const report = useCallback(
    (id: string, state: SectionState, error?: string) => {
      const had = states.current[id];
      if (had?.state === state && had.error === error) return;
      states.current = { ...states.current, [id]: { state, ...(error ? { error } : {}) } };
      lastStates = { revision, states: states.current };
      clearTimeout(timer.current);
      timer.current = setTimeout(
        () => notify(FRAME_METHODS.ready, { revision, generation: generation.current, sections: states.current }),
        50,
      );
    },
    [revision],
  );

  // A grid on a query drawn for a record starts again with another record: its page, sort, conditions and the row
  // picked were the last record's. A grid's id is its query's.
  const clearRecordGrids = () => {
    setGrids((g) => Object.fromEntries(Object.entries(g).filter(([id]) => !definition.queries[id]?.record)));
  };
  const store: Store = {
    definition,
    revision,
    filters,
    setFilter: (id, value) => {
      generation.current += 1;
      setGenerationShown(generation.current);
      states.current = {};
      // What the filters narrow starts again: every grid's first page, nothing selected.
      setGrids((g) => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, { ...v, page: 0, selected: null }])));
      setFilters((f) => ({ ...f, [id]: value }));
    },
    grids,
    setGrid: (id, patch) => setGrids((g) => ({ ...g, [id]: { ...(g[id] ?? { page: 0, selected: null }), ...patch } })),
    client,
    record,
    setRecord: (key) => {
      if (key === record) return;
      clearRecordGrids();
      setRecord(key);
    },
    links: draw.links === true,
    report,
    generation: generationShown,
    reads: draw.reads ?? {},
  };

  // The shareable part goes to the page, which keeps it in its address.
  useEffect(() => {
    const state: DashboardState = { filters, ...(record !== null ? { record } : {}) };
    notify(FRAME_METHODS.state, state);
  }, [filters, record]);

  // Its own code is the page, given the store.
  return (
    <StoreContext.Provider value={store}>
      <AppRoot />
    </StoreContext.Provider>
  );
}

// ---- the kit's controls for an App ----------------------------------------------------------------------------------
// The kit's controls: an App's filter as its date range or searchable picker,
// tabs, a segmented choice, a select, a search field, a picker of the App's own. Drawn in the kit's look, keyboard
// first; an App doesn't hand-roll any of them.

/** One of the App's filters, drawn as the kit draws it: a period's date range, a select's (searchable) picker. */
export function AppFilter({ id }: { id: string }) {
  const store = useStore();
  const f = store.definition.filters[id];
  if (!f) return null;
  if (f.kind === "period") {
    const value = store.filters[id];
    return (
      <DateRange
        label={f.label}
        value={String(Array.isArray(value) ? (value[0] ?? f.default) : (value ?? f.default))}
        presets={PERIODS.map((p) => ({ value: p, label: PERIOD_LABELS[p] }))}
        onChange={(v) => store.setFilter(id, v)}
      />
    );
  }
  return <SelectFilter id={id} f={f} />;
}

/** The App's filters (or those named) in one row, each with its name inside it: "Plan · All". */
export function AppFilters({ ids }: { ids?: string[] }) {
  const store = useStore();
  const shown = (ids ?? Object.keys(store.definition.filters)).filter((id) => store.definition.filters[id]);
  if (!shown.length) return null;
  return (
    <FilterBar>
      {shown.map((id) => (
        <AppFilter key={id} id={id} />
      ))}
    </FilterBar>
  );
}

/** Views of the App, as tabs under its header: the one shown is marked; a count beside a name when given. */
export function AppTabs({
  tabs,
  value,
  onChange,
  label = "Views",
}: {
  tabs: { id: string; label: string; count?: number }[];
  value: string;
  onChange(id: string): void;
  label?: string;
}) {
  return (
    <nav className="od-tabs od-app-tabs" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          aria-current={t.id === value ? "page" : undefined}
          onClick={() => onChange(t.id)}
        >
          <span className="od-page-name">{t.label}</span>
          {t.count !== undefined ? <span className="od-tab-count">{t.count.toLocaleString()}</span> : null}
        </button>
      ))}
    </nav>
  );
}

/** A small choice of two to five, side by side (Chart / Table, Week / Month). */
export function Segmented({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange(value: string): void;
  label: string;
}) {
  return (
    <fieldset className="od-seg">
      <legend className="od-sr">{label}</legend>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}

/** A choice of the App's own (not one of its filters), searchable, one or several: the kit's picker. */
export function Picker({
  label,
  value,
  options,
  onChange,
  multiple = false,
  searchable,
  allLabel,
}: {
  label: string;
  value: string[];
  options: (string | { value: string; count?: number })[];
  onChange(value: string[]): void;
  multiple?: boolean;
  searchable?: boolean;
  allLabel?: string;
}) {
  const [search, setSearch] = useState("");
  const all = options.map((o) => (typeof o === "string" ? { value: o } : o));
  const shown = search ? all.filter((o) => o.value.toLowerCase().includes(search.toLowerCase())) : all;
  return (
    <InlineLabels.Provider value={true}>
      <ValuePicker
        label={label}
        value={value}
        multiple={multiple}
        searchable={searchable ?? all.length > 8}
        options={shown}
        onSearch={setSearch}
        onChange={onChange}
        {...(allLabel ? { allLabel } : {})}
      />
    </InlineLabels.Provider>
  );
}

/** A select of the App's own: its name inside, one 32 px row. */
export function AppSelect(p: {
  label: string;
  value: string;
  options: (string | { value: string; label: string })[];
  onChange(value: string): void;
}) {
  return (
    <Select
      label={p.label}
      value={p.value}
      options={p.options.map((o) => (typeof o === "string" ? { value: o, label: o } : o))}
      onChange={p.onChange}
    />
  );
}

/** A search field of the App's own (a query's "contains" condition, a list's own search). */
export function AppSearch(p: { value: string; onChange(value: string): void; placeholder?: string }) {
  return (
    <SearchInput value={p.value} onChange={p.onChange} {...(p.placeholder ? { placeholder: p.placeholder } : {})} />
  );
}
