import {
  BarChart,
  BoxplotChart,
  CustomChart,
  FunnelChart,
  HeatmapChart,
  LineChart,
  SankeyChart,
  ScatterChart,
  TreemapChart,
} from "echarts/charts";
import {
  CalendarComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapContinuousComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { FRAME_METHODS, MAX_OFFSET } from "../protocol";
import { notify } from "./bridge";
import type { Drawn, Option, Theme } from "./charts";
import { InlineLabels } from "./controls";
import type { Result } from "./data";
import { type Format, format } from "./values";

echarts.use([
  MarkAreaComponent,
  MarkLineComponent,
  BarChart,
  BoxplotChart,
  CustomChart,
  FunnelChart,
  HeatmapChart,
  LineChart,
  SankeyChart,
  ScatterChart,
  TreemapChart,
  CalendarComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapContinuousComponent,
  CanvasRenderer,
]);

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

// ---- controls ----------------------------------------------------------------------------------------------------

export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <div className="od-filterbar">
      <InlineLabels.Provider value={true}>{children}</InlineLabels.Provider>
    </div>
  );
}

export function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange(v: string): void;
}) {
  return (
    <label className="od-field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = "Search",
}: {
  value: string;
  onChange(v: string): void;
  placeholder?: string;
}) {
  return (
    <label className="od-field od-search">
      <span>Search</span>
      <input type="search" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

// ---- chart -------------------------------------------------------------------------------------------------------

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const themeNow = () =>
  `${document.documentElement.dataset.theme ?? ""}:${matchMedia("(prefers-color-scheme: dark)").matches}`;
/** Changes when the theme does (the page's choice, or the system's): a chart redraws in its colours. */
function useThemeKey(): string {
  const [key, setKey] = useState(themeNow);
  useEffect(() => {
    const update = () => setKey(themeNow());
    const watch = new MutationObserver(update);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const system = matchMedia("(prefers-color-scheme: dark)");
    system.addEventListener("change", update);
    return () => {
      watch.disconnect();
      system.removeEventListener("change", update);
    };
  }, []);
  return key;
}

// ---- a query's chart, as drawn (charts.ts): its legend, its chart, its points read with the arrow keys ----------

/** The colours a chart draws with, from the page's theme. */
export function readTheme(): Theme {
  return {
    series: [1, 2, 3, 4, 5, 6].map((i) => css(`--chart-${i}`)),
    ink: css("--foreground"),
    muted: css("--muted"),
    rule: css("--border"),
    surface: css("--surface"),
    good: css("--success"),
    warn: css("--warning"),
    bad: css("--danger"),
  };
}

export { useThemeKey };

/** One ECharts canvas: drawn again whenever its option changes, resized with its box. */
function Canvas({
  option,
  height,
  minWidth,
  onReady,
  onPick,
}: {
  option: Option;
  height: number;
  minWidth?: number | undefined;
  onReady(chart: echarts.ECharts | null): void;
  onPick?: ((series: number, index: number) => void) | undefined;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: made once; onReady is read at mount
  useEffect(() => {
    if (!el.current) return;
    const c = echarts.init(el.current, undefined, { renderer: "canvas" });
    chart.current = c;
    onReady(c);
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      onReady(null);
      c.dispose();
    };
  }, []);
  useEffect(() => {
    chart.current?.setOption(option, true);
  }, [option]);
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    c.off("click");
    if (onPick)
      c.on("click", (p) => onPick((p as { seriesIndex: number }).seriesIndex, (p as { dataIndex: number }).dataIndex));
  }, [onPick]);
  return <div ref={el} className="od-canvas" style={{ height, ...(minWidth ? { minWidth } : {}) }} />;
}

/**
 * A query's chart: each series named beside its colour, what was cut said under it, and its points read one by one
 * with the arrow keys (left and right along a series, up and down between series or small charts, Enter opens the
 * rows behind one).
 */
export function ChartView({
  drawn,
  onPick,
}: {
  drawn: Drawn;
  onPick?: ((picked: { group: Record<string, string | number | null>; label: string }) => void) | undefined;
}) {
  // Each panel's chart by its key, so a filter that reorders the small charts still finds the right one.
  const charts = useRef(new Map<string, echarts.ECharts>());
  const chartOf = (panel: number) => charts.current.get(drawn.panels[panel]?.key ?? "");
  const [at, setAt] = useState<{ lane: number; point: number } | null>(null);
  const [said, setSaid] = useState("");
  // A new answer redraws: what was being read is gone.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the drawing changes
  useEffect(() => setAt(null), [drawn]);
  const tip = (lane: number, point: number) => {
    const l = drawn.lanes[lane];
    const p = l?.points[point];
    if (!l || !p) return;
    for (const c of charts.current.values()) c.dispatchAction({ type: "hideTip" });
    const c = chartOf(l.panel);
    if (c && p.index >= 0) c.dispatchAction({ type: "showTip", seriesIndex: l.series, dataIndex: p.index });
    setAt({ lane, point });
    setSaid(p.text);
  };
  const onKey = (e: KeyboardEvent) => {
    const lanes = drawn.lanes;
    if (!lanes.length) return;
    const lane = at?.lane ?? 0;
    const point = at?.point ?? -1;
    const length = (k: number) => lanes[k]?.points.length ?? 0;
    const go = (l: number, p: number) => {
      e.preventDefault();
      const ln = Math.max(0, Math.min(lanes.length - 1, l));
      tip(ln, Math.max(0, Math.min(length(ln) - 1, p)));
    };
    if (e.key === "ArrowRight") go(lane, point + 1);
    else if (e.key === "ArrowLeft") go(lane, point - 1);
    else if (e.key === "ArrowDown") go(lane + 1, Math.max(0, point));
    else if (e.key === "ArrowUp") go(lane - 1, Math.max(0, point));
    else if (e.key === "Home") go(lane, 0);
    else if (e.key === "End") go(lane, length(lane) - 1);
    else if (e.key === "Escape" && at) {
      e.preventDefault();
      for (const c of charts.current.values()) c.dispatchAction({ type: "hideTip" });
      setAt(null);
      setSaid("");
    } else if (e.key === "Enter" && at && onPick) {
      const l = lanes[at.lane];
      const p = l?.points[at.point];
      const picked = l && p && p.index >= 0 ? drawn.pick(l.panel, l.series, p.index) : null;
      if (picked) {
        e.preventDefault();
        onPick(picked);
      }
    }
  };
  const picker = (panel: number) =>
    onPick
      ? (series: number, index: number) => {
          const picked = drawn.pick(panel, series, index);
          if (picked) onPick(picked);
        }
      : undefined;
  const many = drawn.panels.length > 1;
  return (
    <div className="od-chartview" data-od-chart-points={drawn.points} data-od-label="">
      {drawn.legend.length > 1 ? (
        <ul className="od-legend" aria-label="Legend">
          {drawn.legend.map((l) => (
            <li key={l.name}>
              <span className={`od-key od-key-${l.mark}`} style={{ color: l.color }} aria-hidden />
              {l.name}
            </li>
          ))}
        </ul>
      ) : null}
      <div
        className={cx("od-plot", many && "od-panels", drawn.minWidth !== undefined && "od-plot-scroll")}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the chart is read point by point with the arrow keys
        tabIndex={0}
        role="application"
        aria-roledescription="chart"
        aria-label={`${drawn.summary} Arrow keys read each point${onPick ? "; Enter opens its rows" : ""}.`}
        onKeyDown={onKey}
        onBlur={() => {
          for (const c of charts.current.values()) c.dispatchAction({ type: "hideTip" });
        }}
      >
        {drawn.panels.map((p, i) => {
          // Kept by its key while it's drawn; a canvas reads this once, when it's made.
          const ready = (c: echarts.ECharts | null) => {
            if (c) charts.current.set(p.key, c);
            else charts.current.delete(p.key);
          };
          return many ? (
            <figure key={p.key} className="od-panel">
              <figcaption>{p.title}</figcaption>
              <Canvas option={p.option} height={drawn.height} onReady={ready} onPick={picker(i)} />
            </figure>
          ) : (
            <Canvas
              key={p.key}
              option={p.option}
              height={drawn.height}
              minWidth={drawn.minWidth}
              onReady={ready}
              onPick={picker(i)}
            />
          );
        })}
      </div>
      <p className="od-sr" aria-live="polite">
        {said}
      </p>
      {drawn.notes.length ? <p className="od-chart-note">{drawn.notes.join(" ")}</p> : null}
    </div>
  );
}

// ---- tables: a page of rows the server sorted, virtualized ------------------------------------------------------

/** Past this the table scrolls sideways: each column's width, or 100px for one that grows (12px gaps, 12px insets). */
const minWidth = (columns: { width?: number }[]) => columns.reduce((w, c) => w + (c.width ?? 100) + 12, 24);

export interface Column {
  key: string;
  label: string;
  /** A format, or a number drawn as a bar against the page's largest, or a value as a tag. */
  format?: Format | "bar" | "badge" | "person" | "dots";
  /** A pill's meaning by value: its tone, with its words (never colour alone). */
  tones?: Record<string, "good" | "warn" | "bad" | "neutral">;
  width?: number;
  align?: "left" | "right";
  /** A control drawn in the cell instead of its value (a worked-in list's owner, status, note). */
  render?: (row: number) => ReactNode;
  /** Kept at the right edge while the table scrolls sideways (a row's Ask and actions). */
  pin?: "end";
  /** The row's link, for a column that has one (a tracker's issue key): pressed, the page builds and opens it. */
  linkOf?: (row: number) => { url: string; dataset: string; value: string } | null;
}

/**
 * A sideways-scrolling table's pinned cells: shifted left by what's still to scroll, so they sit at the visible right
 * edge (sticky can't: the rows scroll on their own). `data-pinned` while something is under them.
 */
function usePinned(columns: Column[]) {
  const ref = useRef<HTMLDivElement>(null);
  const any = columns.some((c) => c.pin);
  useEffect(() => {
    const el = ref.current;
    if (!el || !any) return;
    const place = () => {
      const rest = Math.max(0, el.scrollWidth - el.clientWidth - el.scrollLeft);
      el.style.setProperty("--od-pin", `${-rest}px`);
      if (rest > 0) el.setAttribute("data-pinned", "");
      else el.removeAttribute("data-pinned");
    };
    place();
    el.addEventListener("scroll", place, { passive: true });
    const seen = new ResizeObserver(place);
    seen.observe(el);
    if (el.firstElementChild) seen.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", place);
      seen.disconnect();
    };
  }, [any]);
  return ref;
}

const ROW = 34;
const COMPACT_ROW = 28;
const isNumeric = (c: Column) =>
  (c.align ??
    (c.format &&
    c.format !== "text" &&
    c.format !== "date" &&
    c.format !== "badge" &&
    c.format !== "person" &&
    c.format !== "dots"
      ? "right"
      : "left")) === "right";
/** A tag's colour, fixed per value: the same value is the same colour on every page. */
const toneOf = (v: unknown) => {
  let h = 0;
  for (const ch of String(v)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return (Math.abs(h) % 6) + 1;
};

/** A cell as its column draws it: a bar against the page's largest, a tag, or its value formatted. */
function Cell({ column, value, max, row }: { column: Column; value: unknown; max: number; row: number }) {
  if (column.render) return <>{column.render(row)}</>;
  const link = column.linkOf?.(row) ?? null;
  if (link) {
    return (
      <button
        type="button"
        className="od-link-cell"
        title={link.url}
        onClick={(e) => {
          e.stopPropagation();
          notify(FRAME_METHODS.link, { dataset: link.dataset, value: link.value });
        }}
        // Its own keys: Enter or Space opens the link, never the row around it.
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") e.stopPropagation();
        }}
      >
        {format(
          value,
          column.format === "bar" || column.format === "badge" || column.format === "person" || column.format === "dots"
            ? "text"
            : (column.format ?? "text"),
        )}
      </button>
    );
  }
  if (column.format === "dots") {
    // A strip of squares: a list of levels 0..1, newest last, toned by level; said in words too.
    const raw = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.replace(/^\[|\]$/g, "").split(",")
        : [];
    const levels = raw
      .slice(-12)
      .map((x) => (x === null || x === "" || x === undefined ? null : Number(x)))
      .map((n) => (n === null || !Number.isFinite(n) ? null : Math.max(0, Math.min(1, n))));
    if (!levels.length) return <>—</>;
    const high = levels.filter((n) => n !== null && n >= 0.66).length;
    return (
      <span className="od-dots" role="img" aria-label={`${high} of ${levels.length} high`}>
        {levels.map((n, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: a strip's place is its key
            key={i}
            className="od-dot"
            data-level={n === null ? "none" : n >= 0.66 ? "high" : n >= 0.33 ? "mid" : "low"}
          />
        ))}
      </span>
    );
  }
  if (column.format === "bar") {
    const n = Number(value);
    const width = Number.isFinite(n) && max > 0 ? Math.max(0, Math.min(100, (n / max) * 100)) : 0;
    return (
      <span className="od-bar-cell">
        <span className="od-bar-track" aria-hidden>
          <span className="od-bar" style={{ width: `${width}%` }} />
        </span>
        <span className="od-bar-value">{format(value, "number")}</span>
      </span>
    );
  }
  if (column.format === "badge") {
    if (value === null || value === undefined || value === "") return <>—</>;
    const meaning = column.tones?.[String(value)];
    // A value with a meaning wears its tone; any other, a colour of its own (the same on every page).
    return meaning ? (
      <span className="od-pill" data-meaning={meaning}>
        <span className="od-pill-dot" aria-hidden />
        {String(value)}
      </span>
    ) : (
      <span className="od-badge-cell" data-tone={toneOf(value)}>
        {String(value)}
      </span>
    );
  }
  if (column.format === "person") {
    if (value === null || value === undefined || value === "")
      return <span className="od-person-none">Unassigned</span>;
    const name = String(value);
    const initials = name
      .split(/[\s._@-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("");
    return (
      <span className="od-person">
        <span className="od-avatar" data-tone={toneOf(name)} aria-hidden>
          {initials || "?"}
        </span>
        <span className="od-person-name">{name}</span>
      </span>
    );
  }
  return <>{format(value, column.format ?? "text")}</>;
}

function Rows({
  result,
  columns,
  height,
  onRow,
  selected = null,
  rowHeight = ROW,
}: {
  result: Result;
  columns: Column[];
  height: number;
  onRow?: (row: Record<string, unknown>, i: number) => void;
  selected?: number | null;
  rowHeight?: number;
}) {
  const [top, setTop] = useState(0);
  const n = result.rowCount;
  const visible = Math.ceil(height / rowHeight) + 8;
  const start = Math.max(0, Math.floor(top / rowHeight) - 4);
  const end = Math.min(n, start + visible);
  const template = columns.map((c) => (c.width ? `${c.width}px` : "minmax(0,1fr)")).join(" ");
  const cols = useMemo(() => columns.map((c) => result.col(c.key)), [result, columns]);
  // A bar column's largest on this page: its bars are drawn against it.
  const maxes = useMemo(
    () =>
      cols.map((col, j) =>
        columns[j]?.format === "bar" ? Math.max(0, ...Array.from(col, Number).filter(Number.isFinite)) : 0,
      ),
    [cols, columns],
  );
  const out: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    out.push(
      // A virtualized row: a button (and keyboard-reachable) only when it opens something.
      // biome-ignore lint/a11y/noStaticElementInteractions: its role is set when it's clickable
      <div
        key={i}
        className={cx("od-tr", onRow && "od-clickable", selected === i && "od-selected")}
        style={{ top: i * rowHeight, height: rowHeight, gridTemplateColumns: template }}
        role={onRow ? "button" : undefined}
        tabIndex={onRow ? 0 : undefined}
        onClick={onRow ? () => onRow(result.rows[i] ?? {}, i) : undefined}
        onKeyDown={onRow ? (e) => (e.key === "Enter" || e.key === " ") && onRow(result.rows[i] ?? {}, i) : undefined}
      >
        {columns.map((c, j) => (
          <span key={c.key} className={cx("od-td", isNumeric(c) && "num", c.pin && "od-pin")} data-od-cell="">
            <Cell column={c} value={cols[j]?.[i]} max={maxes[j] ?? 0} row={i} />
          </span>
        ))}
      </div>,
    );
  }
  return (
    <div
      className="od-tbody"
      data-od-scroll=""
      style={{ height }}
      onScroll={(e) => setTop((e.target as HTMLDivElement).scrollTop)}
    >
      <div style={{ height: n * rowHeight, position: "relative" }}>{out}</div>
    </div>
  );
}

function Head({
  columns,
  sort,
  onSort,
  filtering,
  onResize,
}: {
  columns: Column[];
  sort?: string;
  onSort?: (key: string) => void;
  /** Columns that filter: which have a condition now, and which one's filter is open. */
  filtering?: { active: string[]; open: string | null; onFilter(key: string): void };
  /** A column's width set by its edge (null: back to the width it was given). */
  onResize?(key: string, width: number | null): void;
}) {
  const template = columns.map((c) => (c.width ? `${c.width}px` : "minmax(0,1fr)")).join(" ");
  return (
    <div className="od-thead" style={{ gridTemplateColumns: template }}>
      {columns.map((c) => {
        const dir = sort === c.key ? "asc" : sort === `-${c.key}` ? "desc" : undefined;
        const on = filtering?.active.includes(c.key);
        return (
          <span key={c.key} className={cx("od-th-cell", isNumeric(c) && "num", c.pin && "od-pin")}>
            {c.render ? (
              // A control column (a worked-in list's) isn't the warehouse's: nothing to sort or filter by.
              <span className="od-th od-th-static">{c.label}</span>
            ) : (
              <button
                type="button"
                className={cx("od-th", isNumeric(c) && "num")}
                aria-label={`${c.label}${dir ? `, sorted ${dir === "asc" ? "up" : "down"}` : ""}: sort`}
                onClick={onSort ? () => onSort(dir === "desc" ? c.key : `-${c.key}`) : undefined}
              >
                {c.label}
                {dir ? <i aria-hidden>{dir === "asc" ? "↑" : "↓"}</i> : null}
              </button>
            )}
            {filtering && !c.render ? (
              <button
                type="button"
                className={cx("od-th-filter", on && "od-th-filter-on")}
                aria-label={`Filter ${c.label}${on ? " (filtered)" : ""}`}
                aria-expanded={filtering.open === c.key}
                onClick={() => filtering.onFilter(c.key)}
              >
                <svg viewBox="0 0 16 16" aria-hidden>
                  <path d="M2.5 3.5h11l-4.25 5v4l-2.5 1.25V8.5z" />
                </svg>
              </button>
            ) : null}
            {onResize ? <ResizeEdge label={c.label} onResize={(w) => onResize(c.key, w)} /> : null}
          </span>
        );
      })}
    </div>
  );
}

/** A column's narrowest and widest, when a person sizes it. */
const COLUMN_MIN = 56;
const COLUMN_MAX = 720;
const COLUMN_STEP = 16;

/**
 * The right edge of a column's header: drag it to size the column, arrow keys to nudge it, a double-click to give it
 * back the width it was given.
 */
function ResizeEdge({ label, onResize }: { label: string; onResize(width: number | null): void }) {
  const widthOf = (edge: HTMLElement) => edge.parentElement?.getBoundingClientRect().width ?? COLUMN_MIN;
  const clamp = (w: number) => Math.round(Math.min(COLUMN_MAX, Math.max(COLUMN_MIN, w)));
  // Its column's width now, for a screen reader: measured, and again whenever the column changes size.
  const edge = useRef<HTMLSpanElement>(null);
  const [now, setNow] = useState(COLUMN_MIN);
  useEffect(() => {
    const cell = edge.current?.parentElement;
    if (!cell) return;
    const seen = new ResizeObserver(() => setNow(Math.round(cell.getBoundingClientRect().width)));
    seen.observe(cell);
    return () => seen.disconnect();
  }, []);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a column edge that moves, as WAI-ARIA's window splitter
    <span
      ref={edge}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      aria-valuenow={now}
      aria-valuemin={COLUMN_MIN}
      aria-valuemax={COLUMN_MAX}
      tabIndex={0}
      className="od-th-resize"
      onPointerDown={(e) => {
        e.preventDefault();
        const edge = e.currentTarget;
        const start = e.clientX;
        const from = widthOf(edge);
        edge.setPointerCapture(e.pointerId);
        const move = (m: PointerEvent) => onResize(clamp(from + m.clientX - start));
        const up = () => {
          edge.removeEventListener("pointermove", move);
          edge.removeEventListener("pointerup", up);
          edge.removeEventListener("pointercancel", up);
        };
        edge.addEventListener("pointermove", move);
        edge.addEventListener("pointerup", up);
        edge.addEventListener("pointercancel", up);
      }}
      onDoubleClick={() => onResize(null)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        onResize(clamp(widthOf(e.currentTarget) + (e.key === "ArrowRight" ? COLUMN_STEP : -COLUMN_STEP)));
      }}
    />
  );
}

/** Numbered pages around the current one: 1 … 4 5 6 … 20. */
function pageList(page: number, pages: number): (number | null)[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i);
  const near = [page - 1, page, page + 1].filter((p) => p > 0 && p < pages - 1);
  const out: (number | null)[] = [0];
  if ((near[0] ?? 1) > 1) out.push(null);
  out.push(...near);
  if ((near.at(-1) ?? pages - 2) < pages - 2) out.push(null);
  out.push(pages - 1);
  return out;
}

/**
 * A page of rows the server sorted and paged: its grid holds the page and the sort, and asks for that
 * request; the table shows the answer, its place in the total, and the controls. A row pressed is selected. A data
 * grid adds its column filters (a panel under the header), a totals row, rows per page and its density.
 */
export function Table({
  result,
  columns: given,
  page,
  pageSize,
  onPage,
  sort,
  onSort,
  onRow,
  selected,
  height = 420,
  filtering,
  panel,
  totals,
  pageSizes,
  onPageSize,
  compact,
}: {
  result: Result;
  columns: Column[];
  page: number;
  pageSize: number;
  onPage(page: number): void;
  sort?: string;
  onSort?(sort: string): void;
  onRow?: (row: Record<string, unknown>, i: number) => void;
  /** The selected row's index on this page. */
  selected?: number | null;
  height?: number;
  filtering?: { active: string[]; open: string | null; onFilter(key: string): void };
  /** What opens under the header: a column's filter. */
  panel?: ReactNode;
  /** The totals row: each column's total, over every row the filters select. */
  totals?: Record<string, unknown> | null;
  pageSizes?: number[];
  onPageSize?(size: number): void;
  compact?: boolean;
}) {
  const from = result.total === 0 ? 0 : page * pageSize + 1;
  const to = page * pageSize + result.rowCount;
  // Only the pages a grid can reach (the server goes no deeper than MAX_OFFSET rows).
  const reachable = Math.floor(MAX_OFFSET / pageSize) + 1;
  const pages = Math.max(1, Math.min(Math.ceil(result.total / pageSize), reachable));
  const rowHeight = compact ? COMPACT_ROW : ROW;
  // Widths a person set by dragging a column's edge:
  // kept while the grid is open, over the widths it was given.
  const [widths, setWidths] = useState<Record<string, number>>({});
  const columns = useMemo(
    () => given.map((c) => (widths[c.key] ? { ...c, width: widths[c.key] } : c)),
    [given, widths],
  );
  const template = columns.map((c) => (c.width ? `${c.width}px` : "minmax(0,1fr)")).join(" ");
  const scroller = usePinned(columns);
  return (
    <div className={cx("od-table", compact && "od-compact")}>
      <div className="od-tscroll" data-od-scroll="" ref={scroller}>
        <div style={{ minWidth: minWidth(columns) }}>
          <Head
            columns={columns}
            onResize={(key, width) =>
              setWidths((w) => {
                const next = { ...w };
                if (width === null) delete next[key];
                else next[key] = width;
                return next;
              })
            }
            {...(sort !== undefined ? { sort } : {})}
            {...(onSort ? { onSort } : {})}
            {...(filtering ? { filtering } : {})}
          />
          {panel}
          {result.status === "error" ? (
            <p className="od-error">Couldn't load: {result.error}</p>
          ) : result.status === "ok" && result.total === 0 ? (
            <p className="od-emptystate">No rows.</p>
          ) : (
            <Rows
              result={result}
              columns={columns}
              height={Math.min(height, Math.max(result.rowCount, 1) * rowHeight)}
              {...(onRow ? { onRow } : {})}
              selected={selected ?? null}
              rowHeight={rowHeight}
            />
          )}
          {totals ? (
            <div className="od-ttotals" style={{ gridTemplateColumns: template }} data-od-label="">
              {columns.map((c, j) => {
                // A total is a number (a count under an id is a count): grouped, money kept as money.
                const shown =
                  c.key in totals
                    ? format(totals[c.key], c.format === "money" || c.format === "money-compact" ? c.format : "number")
                    : null;
                return (
                  <span key={c.key} className={cx("od-td", (isNumeric(c) || shown !== null) && j > 0 && "num")}>
                    {j === 0 ? (
                      <span>
                        Total{shown !== null ? " · " : ""}
                        {shown !== null ? <span data-od-value="">{shown}</span> : null}
                      </span>
                    ) : shown !== null ? (
                      <span data-od-value="">{shown}</span>
                    ) : null}
                  </span>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
      <div className="od-tfoot" data-od-label="">
        <span>
          <span data-od-value="">{format(from)}</span>–<span data-od-value="">{format(to)}</span> of{" "}
          <span data-od-value="">{format(result.total)}</span>
        </span>
        <span className="od-pager">
          {pageSizes && pageSizes.length > 1 && onPageSize ? (
            <label className="od-pagesize">
              <span>Rows</span>
              <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
                {pageSizes.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button type="button" disabled={page === 0} onClick={() => onPage(page - 1)} aria-label="Previous page">
            ‹
          </button>
          {pageList(page, pages).map((p, i) =>
            p === null ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: gaps between page numbers
              <span key={`gap${i}`} className="od-gap" aria-hidden>
                …
              </span>
            ) : (
              <button
                key={p}
                type="button"
                className={cx("od-pagenum", p === page && "od-pagenum-on")}
                aria-current={p === page ? "page" : undefined}
                aria-label={`Page ${p + 1}`}
                onClick={() => onPage(p)}
              >
                {p + 1}
              </button>
            ),
          )}
          <button
            type="button"
            disabled={to >= result.total || page + 1 >= pages}
            onClick={() => onPage(page + 1)}
            aria-label="Next page"
          >
            ›
          </button>
        </span>
      </div>
    </div>
  );
}
