// The types an App's code is checked against: the runtime's public API, and ids.d.ts made from the App's definition,
// so a query or filter it doesn't have, or a column its query doesn't return, is a compile error, not an empty screen.
import { type Definition, outputsOf } from "../dashboard/definition";

/**
 * The shapes the App's API is written in, and the ids its definition fills in (idsDts): a module of types only, never
 * imported by an App's code (it imports `@opendash/app`, which re-exports what it needs).
 */
const SHARED_DTS = `declare module "@opendash/app-runtime" {
  /** The App's own ids (made from its definition). */
  export interface Ids {}
  /** Each query's output columns (made from its definition): a column it doesn't have is a compile error. */
  export interface Columns {}
  type Of<K extends string> = Ids extends { [P in K]: infer V } ? V & string : string;
  export type QueryId = Of<"queries">;
  export type FilterId = Of<"filters">;
  export interface CellSource { kind: "query"; requestId: string; dataset: string; column: string; row: number; key?: string | number; keyColumn?: string }
  export interface Cell { kind: "cell"; value: number | string | null; source: CellSource }
  export interface Result {
    status: "loading" | "ok" | "error"; error?: string; rowCount: number; total: number; truncated: boolean; hidden: string[];
    key?: string; pastEnd?: boolean; asOf?: string; columns: { name: string; kind: "number" | "text" | "date" }[];
    rows: Record<string, unknown>[]; col(name: string): ArrayLike<unknown>; cell(row: number, name: string): Cell;
  }
  /**
   * A named query's answer under the App's filters; the period before beside it, for a query that compares. While a
   * newer answer loads or after it failed, the last one is kept (stale), with why it failed and \`retry\` to ask again.
   */
  export type NamedResult = Result & {
    previous?: Result; asked: Record<string, string | string[]>; stale?: boolean; failed?: string; retry?: () => void;
  };
  export type Format = "money" | "money-compact" | "number" | "percent" | "date" | "text";
  export interface Derived { kind: "derived"; name: string; value: number | null; inputs: Traced[]; recipe: string }
  export interface Assumption { kind: "assumption"; name: string; label: string; value: number; unit: "share" | "money" | "count" | "days"; setBy: string }
  export type Traced = Cell | Derived | Assumption;
}
`;

/** What an App imports, as its code sees it (apps as code): the API the react-app-craft skill shows. */
export const APP_DTS = `/**
 * What an App imports (apps as code): its data (named queries, filters, the record shown, what-ifs), traced values,
 * and the primitives worth reusing. Everything else on its page is its own code.
 */
declare module "@opendash/app" {
  import type { JSX } from "react";
  import type { QueryId, FilterId, NamedResult, Traced, Format, Derived, Assumption, Cell, Columns } from "@opendash/app-runtime";
  export type { QueryId, FilterId, NamedResult, Traced, Format, Derived, Assumption, Cell };
  /** A query's columns, by name. */
  export type ColumnOf<Q extends QueryId> = Q extends keyof Columns ? Columns[Q] & string : string;
  /** A query's answer, its rows and cells named by its own columns. */
  export type QueryResult<Q extends QueryId> = Omit<NamedResult, "rows" | "cell" | "col"> & {
    rows: Record<ColumnOf<Q>, unknown>[];
    cell(row: number, column: ColumnOf<Q>): Cell;
    col(column: ColumnOf<Q>): ArrayLike<unknown>;
  };
  export type Condition = [column: string, op: "in" | "contains" | ">=" | "<=" | "<" | "is null", value?: unknown];
  /**
   * A named query's answer under the App's filters: status loading, ok or error; rows; cell(row, column) a traced
   * value for Value. Paging, sort, conditions and a record only as its query declares them (the server holds it).
   */
  export function useQuery<Q extends QueryId>(
    id: Q,
    opts?: { page?: number; pageSize?: number; sort?: string; where?: Condition[]; search?: string; record?: string | number | null },
  ): QueryResult<Q>;
  /** A filter's value, and how to set it (kept in the page's address). */
  export function useFilter(id: FilterId): [string | string[] | undefined, (value: string | string[]) => void];
  /** The record shown (its key), and how to show another (kept in the page's address). */
  export function useRecord(): [string | number | null, (key: string | number | null) => void];
  export function useAssumption(name: string, initial: number, meta: { label: string; unit: Assumption["unit"]; setBy: string; min?: number; max?: number; step?: number }): Assumption;
  export function derive(name: string, inputs: Traced[], fn: (...v: number[]) => number, recipe?: string): Derived;
  export function format(v: unknown, f?: Format, signed?: boolean): string;
  /** A number from the data, drawn so a press opens where it came from. Draw every figure from a query with it. */
  export function Value(p: { of: Traced | null | undefined; format?: Format; signed?: boolean }): JSX.Element;
  export type ChartType = "line" | "bar" | "area" | "scatter" | "bullet" | "calendar" | "funnel" | "treemap" | "waterfall" | "heatmap" | "sankey" | "timeline" | "boxplot";
  /** A query drawn as a chart: its tooltips, its numbers opening their rows, its loading and empty states. */
  export function Chart<Q extends QueryId>(p: {
    query: Q; type: ChartType; x?: ColumnOf<Q>; y: ColumnOf<Q>[]; id?: string; title?: string; format?: Format;
    horizontal?: boolean; stack?: boolean; series?: ColumnOf<Q>; facet?: ColumnOf<Q>; top?: number; target?: number | ColumnOf<Q>;
    label?: ColumnOf<Q>; stages?: string[]; cumulative?: boolean; scale?: "shared" | "own";
  }): JSX.Element;
  /** A query's rows as a data grid: sorting, paging, column filters, totals, work and actions as its query declares. */
  export function DataGrid<Q extends QueryId>(p: {
    query: Q;
    columns?: { column: ColumnOf<Q>; label?: string; format?: Format | "bar" | "badge" | "person" | "dots"; tones?: Record<string, "good" | "warn" | "bad" | "neutral"> }[];
    filterable?: boolean; pageSizes?: number[]; totals?: Record<string, "sum" | "avg" | "min" | "max" | "count">;
  }): JSX.Element;
  /** One of the App's summaries, written from its queries' answers. */
  export function Summary(p: { id: string }): JSX.Element;
  /**
   * Where a query's numbers come from, in a quiet line ("Warehouse · Accounts"). Chart and DataGrid say it under
   * themselves: put it under a piece you draw yourself from a query (a stat, a list of your own).
   */
  export function Source(p: { query: QueryId }): JSX.Element | null;
  /** A timing mark, reported to the page (for measurements). */
  export function mark(name: string): void;
  // The kit's controls: use these, never a hand-made <select>, tab strip, date input or search box.
  /** One of the App's filters as the kit draws it: a period's date range (presets, a calendar), a select's searchable picker. */
  export function Filter(p: { id: FilterId }): JSX.Element;
  /** The App's filters (or those named) in one compact row, each with its name inside it. */
  export function Filters(p: { ids?: FilterId[] }): JSX.Element;
  /** Views of the App as tabs under its header (a count beside a name when given). */
  export function Tabs(p: { tabs: { id: string; label: string; count?: number }[]; value: string; onChange(id: string): void; label?: string }): JSX.Element;
  /** A small choice of two to five, side by side (Week / Month). */
  export function Segmented(p: { options: { value: string; label: string }[]; value: string; onChange(value: string): void; label: string }): JSX.Element;
  /** A choice of the App's own, searchable (an autocomplete when there are many), one or several. */
  export function Picker(p: { label: string; value: string[]; options: (string | { value: string; count?: number })[]; onChange(value: string[]): void; multiple?: boolean; searchable?: boolean; allLabel?: string }): JSX.Element;
  /** A select of the App's own, its name inside it. */
  export function Select(p: { label: string; value: string; options: (string | { value: string; label: string })[]; onChange(value: string): void }): JSX.Element;
  /** A search field of the App's own (feed it to a query's "contains" condition). */
  export function Search(p: { value: string; onChange(value: string): void; placeholder?: string }): JSX.Element;
}

`;

export const RUNTIME_DTS = SHARED_DTS + APP_DTS;
const union = (ids: string[]) => (ids.length ? ids.map((i) => JSON.stringify(i)).join(" | ") : "never");

/** The App's ids: its queries and filters, and each query's columns. */
export function idsDts(d: Definition): string {
  return [
    'import "@opendash/app-runtime";',
    'declare module "@opendash/app-runtime" {',
    "  interface Ids {",
    `    queries: ${union(Object.keys(d.queries))};`,
    `    filters: ${union(Object.keys(d.filters))};`,
    "  }",
    "  interface Columns {",
    ...Object.entries(d.queries).map(([id, q]) => `    ${JSON.stringify(id)}: ${union(outputsOf(q))};`),
    "  }",
    "}",
    "",
  ].join("\n");
}
