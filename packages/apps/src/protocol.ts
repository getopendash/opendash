/**
 * What a dashboard's frame and OpenDash say to each other, and the data API's shapes. Types and constants only, so the
 * web app's client code, the worker and the frame runtime all import it.
 *
 * The frame draws a dashboard's definition (dashboard/definition.ts) and has no network: it asks the OpenDash page
 * around it for its named queries' answers over postMessage (JSON-RPC 2.0, in the shape MCP Apps use), and the page
 * asks the server, which binds and compiles each from the definition.
 */

export type ColumnKind = "number" | "text" | "date";

/** What a dashboard may read from one dataset: the columns its queries name. */
export interface DatasetGrant {
  columns: string[];
  /** Its text columns may be searched. */
  search?: boolean;
}

export interface Grants {
  datasets: Record<string, DatasetGrant>;
}

/** A column of a dataset as the data API knows it. */
export interface CatalogColumn {
  kind: ColumnKind;
  description?: string;
  /** Text a person typed or that names a person (emails, phone numbers): readable only when granted by name. */
  personal?: boolean;
  /** A text column a search looks in. */
  search?: boolean;
  /** The values a short list column holds, when known: they become the column's type. */
  values?: string[];
}

/** A dataset a dashboard can read, by its name in the semantic layer. */
export interface CatalogDataset {
  title: string;
  description?: string;
  columns: Record<string, CatalogColumn>;
  /** Named aggregates the semantic layer defines on the dataset (verified numbers): `["measure", "mrr"]`. */
  measures?: Record<string, { description?: string; format?: "number" | "usd" | "percent" }>;
  /** The column that tells rows apart, when there is one: tables page on it, and a number opens its record by it. */
  key?: string;
  /** Its links to other datasets (the semantic layer's relationships): `on` maps its column to theirs. */
  links?: { to: string; on: Record<string, string> }[];
  /** Not released by an admin: its current version, checked, read as unverified. */
  unverified?: true;
  /** A table of snapshots (one row per thing per period): its numbers are a state, read one snapshot at a time. */
  snapshot?: { at: string };
  /** Metrics defined on it: `["metric", "name"]`, the business's definition of a number (its segments, its time). */
  metrics?: Record<
    string,
    {
      title: string;
      /** The date its periods and grains use; null: a number about now, no time at all. */
      timeColumn?: string | null;
      /** Segments it always applies, on top of the dataset's defaults. */
      segments?: string[];
      unverified?: true;
    }
  >;
  /** The dashboard's own: SQL the analyst wrote over the source's tables, checked like Ask's (`t_` names). */
  own?: true;
  /** Read from a service's tool (an MCP server), as its owner's account: no metrics, no change against before. */
  service?: true;
}

export type Catalog = Record<string, CatalogDataset>;

/**
 * What a query reads, in words for its label: a released definition, one not released yet, the analyst's SQL, or a
 * service's tool (Jira, say).
 */
export type Provenance = "verified" | "unverified" | "table" | "service";

export type Op = "=" | "!=" | ">" | ">=" | "<" | "<=" | "in" | "not in" | "contains" | "is null" | "is not null";
export const OPS: readonly Op[] = [
  "=",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "in",
  "not in",
  "contains",
  "is null",
  "is not null",
];
export type Grain = "day" | "week" | "month" | "quarter" | "year";
export const GRAINS: readonly Grain[] = ["day", "week", "month", "quarter", "year"];
export type Aggregate = "count" | "sum" | "avg" | "min" | "max" | "count_distinct";
export const AGGREGATES: readonly Aggregate[] = ["count", "sum", "avg", "min", "max", "count_distinct"];

/**
 * A request for data: rows (`select`, paged) or an aggregate (`measures`, grouped `by` columns, a date column at a
 * grain as `created_at:month`). Never SQL.
 */
export interface QuerySpec {
  from: string;
  select?: string[];
  measures?: Record<string, [Aggregate, string?] | ["measure", string] | ["metric", string]>;
  by?: string[];
  where?: [string, Op, unknown?][];
  /** Segments of the dataset narrowing the rows (a metric's, carried to the rows behind its number). */
  segments?: string[];
  search?: string;
  /** The columns a search looks in: the asked query's own (never every column granted on the dataset). */
  searchIn?: string[];
  sort?: string[];
  page?: { size: number; offset?: number };
  limit?: number;
}

/** The most rows one request returns, whatever it asks for. */
export const ROW_CAP = 1_000;
/** A table's page, at most. */
export const PAGE_CAP = 500;

/** A request's answer: columns of values, in the order asked for. */
export interface WireResult {
  requestId: string;
  dataset: string;
  columns: { name: string; kind: ColumnKind; values: (number | string | null)[] }[];
  rowCount: number;
  /** The column holding each row's key, for a rows request: a number in it opens its record. */
  key?: string;
  /** All the rows that matched, before paging or the cap. */
  total: number;
  /** A page past the last: no rows, and no total to go by (the frame goes back to the first page). */
  pastEnd?: true;
  /** The rows were cut at the cap. */
  truncated: boolean;
  /** Personal columns the dataset has that the dashboard doesn't read. */
  hidden: string[];
  /** When the warehouse answered (ISO). A cached answer is older than the request. */
  asOf: string;
  /** How long the warehouse took to answer, in milliseconds: the same for everyone who reads the kept answer. */
  ms?: number;
  /**
   * Read from a service (its name): when its answer was fetched, and whether it was all of it (`incomplete`: it said
   * there was more; `cut`: records past the cap). Totals over a partial answer aren't totals.
   */
  service?: {
    name: string;
    fetchedAt: string;
    incomplete: boolean;
    cut: number;
    unread?: number;
    /** Read with the viewer's own account, or the workspace's. */
    scope?: "personal" | "org";
    /** This read's own id: the rows behind a number on it are read from it, never from a newer read. */
    snapshot?: string;
  };
}

/** The deepest row a grid pages to: its pages past this aren't offered. */
export const MAX_OFFSET = 100_000;

/** The name of a column's row count in a lookup or a column's counts: never the column's own name. */
export const countAlias = (column: string) => (column === "n" ? "n_rows" : "n");

/** The most requests in one `dashboard.query` call: the frame splits a page's asks into calls of at most this many. */
export const MAX_BATCH = 16;

/** The JSON-RPC methods the frame sends. `tools/call` is a request (it has an id); the rest are notifications. */
export const FRAME_METHODS = {
  call: "tools/call",
  /** A number was pressed: the page opens the rows behind it (`OpenRows`). */
  open: "records/open",
  /** Each section's state (`Readiness`), sent again whenever one changes. */
  ready: "ui/ready",
  /** The shareable state changed (`DashboardState`): the page mirrors it into its address. */
  state: "ui/state",
  error: "ui/error",
  mark: "ui/mark",
  /** What the render check found at this frame's width (`Probed`), once its answers settled. */
  probed: "ui/probed",
  /** Ask about a record from its row (`SectionAction`). */
  section: "ui/section",
  /**
   * A row's action was pressed (`RowAction`): the page asks the server what it would send, shows that on its own
   * dialog, and runs it only when the person confirms. The frame only proposes.
   */
  act: "ui/act",
  /**
   * A row's link was pressed (`{ dataset, value }`): the page builds the address from the dataset's template and that
   * one value, and opens it (for the dashboard's owner).
   */
  link: "ui/link",
  /**
   * Select to edit: in pick mode, the piece of the App the person clicked (`Picked`). A hint only: App code shares the
   * frame and could send one, so the page takes it only while it turned pick mode on, and the server checks it again.
   */
  picked: "ui/picked",
  /** The person pressed Escape in the frame: pick mode is off there, and the page turns its toggle off. */
  pickEnd: "ui/pick-end",
} as const;

/** What the frame says was clicked in pick mode: the element's mark (none on a bundle built before marks), tag, text. */
export interface Picked {
  revision: string;
  /** `/components/Queue.tsx:42:7`, from the nearest marked element; absent when nothing under the click has one. */
  src?: string;
  tag: string;
  /** The element's text, whitespace collapsed, at most 200 characters. */
  text: string;
}

/** Ask about a record, from a worked-in list's row: the grid it's in (its query) and the record's key. */
export interface SectionAction {
  section: string;
  action: "ask";
  record: string;
}

/** A row's action pressed: which, on which row, in the read the list shows. */
export interface RowAction {
  section: string;
  action: string;
  key: string | number;
  /** A service's list: the read it shows (the key must be in it). */
  snapshot?: string;
}

/** What the page tells the frame: the theme OpenDash shows, and the dashboard to draw (`DrawDashboard`). */
export const HOST_METHODS = {
  theme: "ui/theme",
  dashboard: "ui/dashboard",
  /** Something changed outside (a row's action ran): every answer is asked for again. */
  refresh: "ui/refresh",
  /** Measure the App as drawn (the render check): the frame answers with `FRAME_METHODS.probed`. */
  probe: "ui/probe",
  /** Select to edit (`{ on: boolean }`): the frame outlines what the pointer is over and a click selects it. */
  pick: "ui/pick",
} as const;

/** The tool the frame calls through the bridge: its sections' requests, in one batch. */
export const DASHBOARD_TOOLS = {
  query: "dashboard.query",
  summary: "dashboard.summary",
  work: "dashboard.work",
} as const;

/** A worked-in list's records (`dashboard.work`): their owner, status, note and follow-up, and who may change them. */
export interface WorkState {
  work: {
    key: string;
    ownerId: string | null;
    status: string | null;
    note: string | null;
    followUp: string | null;
    updatedBy: string | null;
    updatedAt: string;
  }[];
  people: { id: string; name: string }[];
  canWork: boolean;
  /** Asked with `history`: that record's changes, newest first. */
  history?: { field: "owner" | "status" | "note" | "follow_up"; value: string | null; by: string | null; at: string }[];
}

/** What a summary shows (`dashboard.summary`). */
export type SummaryState =
  | { status: "none"; sources?: { query: string; title: string }[] }
  | { status: "waiting" | "writing" }
  | {
      status: "ok";
      text: string;
      writtenAt: string;
      sources?: { query: string; title: string }[];
      /** For owners and admins: this note's cost and the dashboard's summaries this month, in dollars. */
      cost?: { note: number; month: number };
    }
  | { status: "stale"; text: string; writtenAt: string; sources?: { query: string; title: string }[] }
  | { status: "failed"; error: string };

/** What an App shows that someone can share: its filters' values and the record. */
export interface DashboardState {
  filters: Record<string, string | string[]>;
  /** The record it shows: its key (`r=` in the address). */
  record?: string | number;
}

/** Where a query reads, for the quiet line under a piece: "Warehouse · Accounts", "Fullstory · Checkout funnel". */
export interface QueryRead {
  /** The source's name: the warehouse connection's, or the connected service's. */
  source: string;
  /** What it reads there: the dataset's title (a released one's, or the App's own). */
  dataset: string;
  /** Verified or not, said on hover only, so no piece carries a "not verified" label. */
  provenance?: Provenance;
  /**
   * The source's mark on its colour, drawn before its name (a database's by its dialect, a service's by its address):
   * sent with the read, as the frame loads nothing. None for a source OpenDash has no mark for.
   */
  mark?: SourceMark;
}

/**
 * A mark as the frame draws it: one path in the brand's colour (`bg`) on a white tile, as the web app's logos are; a
 * colour that wouldn't read on white (`onWhite` false) keeps its colour as the tile, the path in `fg`.
 */
export interface SourceMark {
  title: string;
  viewBox: string;
  path: string;
  bg: string;
  fg: string;
  onWhite: boolean;
}

/** The page's message to draw a dashboard: the revision, its definition, and where to start. */
export interface DrawDashboard {
  revision: string;
  definition: unknown;
  state?: Partial<DashboardState>;
  /** Where each query reads, by its id: worked out on the server from the definition and the source's catalog. */
  reads?: Record<string, QueryRead>;
  /** Draw rows' links: for the dashboard's owner (the host opens them). */
  links?: boolean;
}

export type SectionState = "loading" | "data" | "empty" | "error";

/** Every section's state under one filter generation: what the page and the analyst read. */
export interface Readiness {
  revision: string;
  /** Bumped by every filter change: a state from an older generation is stale. */
  generation: number;
  sections: Record<string, { state: SectionState; error?: string }>;
}

/** A number was pressed: its query's rows under the same filters, narrowed to its group. */
export interface OpenRows {
  drill: string;
  filters: Record<string, string | string[]>;
  group: Record<string, string | number | null>;
  /** What was pressed, for the panel's title: "MRR, September 2026". */
  label: string;
  /** What the rows are when they aren't one per thing counted: "It counts distinct users: one may appear in several rows." */
  note?: string;
  /** The record the number is drawn for. */
  record?: string | number;
  /** On a service: the read the number was made from (its rows are read from it). */
  pin?: string;
}

/**
 * How an open's answers came in, counted in the frame: what the page logs for each open, and what the render check
 * tells the analyst about an App's speed.
 */
export interface OpenSpeed {
  /** Distinct requests asked for. */
  asked: number;
  /** Answers that have landed (failed ones too). */
  answered: number;
  /**
   * Times a named query was first asked for after an earlier answer had landed: 1 when a screen asks for everything
   * at once, more when a piece waits for another's answer before it asks. A look for a queued answer isn't one.
   */
  rounds: number;
  /** Calls to the page: each look for queued answers is one. */
  looks: number;
  /** Each named query's slowest answer, in the warehouse's own milliseconds, slowest first. */
  slowest: { query: string; ms: number }[];
}

/**
 * A moment in a frame's open (`FRAME_METHODS.mark`), in milliseconds since the frame started loading: the runtime ran,
 * the document loaded, the App drew, its first answer landed (`answer`), every answer was in (`answers`, with how
 * they came in).
 */
export interface FrameMark {
  name: "runtime" | "loaded" | "drawn" | "answer" | "answers";
  t: number;
  speed?: OpenSpeed;
}

/** What the render check found in one frame at its width. */
export interface Probed {
  revision: string;
  width: number;
  findings: { kind: "overflow" | "overlap" | "clipped" | "empty" | "failed" | "error" | "speed"; message: string }[];
  /** The answers hadn't all settled when it measured (it waited as long as it could). */
  unsettled?: boolean;
}
