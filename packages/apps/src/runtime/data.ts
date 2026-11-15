// A dashboard's data in the frame: its named queries' answers, asked for through the bridge (the frame has no network;
// the page around it asks OpenDash, which binds and compiles each request from the definition). The client batches a
// page's requests into one call, keeps each answer under the request it answers (the query, the filters it takes, a
// page and a sort), asks again while an answer is queued, and tells whoever shows a request when its answer lands.
// An answer to a request no longer shown (the filters changed meanwhile) is kept under its own key and never drawn
// in place of the current one: that's the stale-reply rule.
import type { Range } from "../dashboard/periods";
import { type ColumnKind, MAX_BATCH, type OpenSpeed, type WireResult } from "../protocol";

export type Kind = ColumnKind;
export interface CellSource {
  kind: "query";
  requestId: string;
  dataset: string;
  column: string;
  row: number;
  key?: string | number;
  /** The dataset's key column, when the row has one. */
  keyColumn?: string;
  /**
   * A cell of a named query's answer: the query, the row's groups and the filters it was asked with, so `Value` opens
   * the rows behind it as a chart's point does (and `pin`, the read a service's number came from).
   */
  open?: {
    query: string;
    group: Record<string, string | number | null>;
    asked: Record<string, string | string[]>;
    pin?: string;
  };
}
export interface Cell {
  kind: "cell";
  value: number | string | null;
  source: CellSource;
}

export interface Result {
  status: "loading" | "ok" | "error";
  error?: string;
  requestId?: string;
  dataset?: string;
  columns: { name: string; kind: Kind }[];
  rowCount: number;
  total: number;
  truncated: boolean;
  hidden: string[];
  /** The column holding each row's key, for a rows query. */
  key?: string;
  /** A page past the last: the grid goes back to its first page. */
  pastEnd?: boolean;
  asOf?: string;
  /** How long the warehouse took to answer, in milliseconds. */
  ms?: number;
  /** Read from a service: its name, when it was fetched, and whether that was all of it. */
  service?: {
    name: string;
    fetchedAt: string;
    incomplete: boolean;
    cut: number;
    unread?: number;
    /** Read with the viewer's own account, or the workspace's. */
    scope?: "personal" | "org";
    /** The read it came from: a number's drill reads the same one. */
    snapshot?: string;
  };
  /** The days its period filter chose, [from, to): a chart lines its dates up by them. */
  period?: Range;
  rows: Record<string, unknown>[];
  col(name: string): ArrayLike<unknown>;
  cell(row: number, name: string): Cell;
}

const emptyCell = (row: number, name: string): Cell => ({
  kind: "cell",
  value: null,
  source: { kind: "query", requestId: "", dataset: "", column: name, row },
});

export const empty = (status: Result["status"], error?: string): Result => ({
  status,
  ...(error ? { error } : {}),
  columns: [],
  rowCount: 0,
  total: 0,
  truncated: false,
  hidden: [],
  rows: [],
  col: () => [],
  cell: emptyCell,
});

export function fromWire(w: WireResult, period?: Range): Result {
  const cols = new Map<string, (number | string | null)[]>();
  for (const c of w.columns) cols.set(c.name, c.values);
  const keyColumn = w.key ? cols.get(w.key) : undefined;
  let rows: Record<string, unknown>[] | null = null;
  return {
    status: "ok",
    requestId: w.requestId,
    dataset: w.dataset,
    columns: w.columns.map((c) => ({ name: c.name, kind: c.kind })),
    rowCount: w.rowCount,
    total: w.total,
    truncated: w.truncated,
    hidden: w.hidden,
    ...(w.key ? { key: w.key } : {}),
    ...(w.pastEnd ? { pastEnd: true } : {}),
    asOf: w.asOf,
    ...(typeof w.ms === "number" ? { ms: w.ms } : {}),
    ...(w.service ? { service: w.service } : {}),
    ...(period ? { period } : {}),
    get rows() {
      if (!rows) {
        rows = new Array(w.rowCount);
        for (let i = 0; i < w.rowCount; i++) {
          const r: Record<string, unknown> = {};
          for (const [name, v] of cols) r[name] = v[i];
          rows[i] = r;
        }
      }
      return rows;
    },
    col: (name) => cols.get(name) ?? [],
    cell: (row, name) => ({
      kind: "cell",
      value: cols.get(name)?.[row] ?? null,
      source: {
        kind: "query",
        requestId: w.requestId,
        dataset: w.dataset,
        column: name,
        row,
        key: (keyColumn?.[row] ?? undefined) as string | number | undefined,
        ...(w.key ? { keyColumn: w.key } : {}),
      },
    }),
  };
}

/**
 * A named query's cells, each carrying what opens the rows behind it: the query, its row's value of each column the
 * query groups by, the filters it was asked with, and the read a service's number came from. What `Value` opens, as a
 * chart's point does.
 */
export function openingCells(result: Result, query: string, groups: string[], asked: Values) {
  const pin = result.service?.snapshot;
  return (row: number, name: string): Cell => {
    const c = result.cell(row, name);
    const group = Object.fromEntries(groups.map((g) => [g, (result.col(g)[row] ?? null) as string | number | null]));
    return { ...c, source: { ...c.source, open: { query, group, asked, ...(pin ? { pin } : {}) } } };
  };
}

type Values = Record<string, string | string[]>;
/** A grid's condition on one of its columns (checked on the server against the definition). */
export type Condition = [string, "in" | "contains" | ">=" | "<=" | "<" | "is null", unknown?];

/**
 * What the frame asks for (the server's DashboardRequest, without its id): a named query with the filters it takes
 * (rows: a page, a sort, a page size, a grid's conditions), a filter's values from the warehouse, a grid column's values
 * with their counts, or a grid's totals. `at` is the bucket a queued answer is in: sent back while it's asked for again.
 */
export type Ask = { filters: Values; at?: string; record?: string | number } & (
  | { query: string; page?: number; sort?: string; pageSize?: number; where?: Condition[]; search?: string }
  | { lookup: string; search?: string }
  | { facet: { query: string; column: string }; where?: Condition[]; search?: string }
  | { totals: string; where?: Condition[] }
);

/** The server's answer to one request (DashboardAnswer, as the page relays it). */
export type Answer =
  | { id: string; status: "ok"; result: WireResult; previous?: WireResult; periods?: { now: Range; before?: Range } }
  | { id: string; status: "queued"; at?: string }
  | { id: string; status: "failed"; error: string }
  | { id: string; status: "busy" };

export interface Entry {
  result: Result;
  /** The same query over the period before, for one that compares. */
  previous?: Result;
}

/**
 * How the client asks the page: one call for a batch, under the revision the frame draws. `retry` asks the server to
 * drop the failed answers it holds for these requests and ask the warehouse again.
 */
export type Call = (requests: ({ id: string } & Ask)[], opts?: { retry?: boolean }) => Promise<Answer[]>;

const sortedValues = (v: unknown) => (Array.isArray(v) ? [...v].sort((a, b) => String(a).localeCompare(String(b))) : v);

/**
 * A request's key: everything it asks (never its bucket), with its sets in one order (a filter's values, an `in`'s
 * values, the list of conditions), so one answer stands for one request. A condition's own parts keep their order.
 */
export const keyOf = (a: Ask) => {
  const { at: _at, filters, ...asked } = a as Ask & { where?: Condition[] };
  const where = asked.where?.map((c) => JSON.stringify([c[0], c[1], c[1] === "in" ? sortedValues(c[2]) : c[2]])).sort();
  const keys = Object.keys(filters).sort();
  return JSON.stringify([
    keys.map((k) => [k, sortedValues(filters[k])]),
    Object.keys(asked)
      .filter((k) => k !== "where")
      .sort()
      .map((k) => [k, (asked as Record<string, unknown>)[k]]),
    where ?? [],
  ]);
};

/**
 * How long to wait before asking again for a queued answer: quick at first, then every second (an answer
 * that had landed could otherwise wait two seconds to be shown).
 */
const backoff = (tries: number) => Math.min(1_000, 150 * 1.5 ** tries);

/** Answers nobody shows any more that are kept, the most recently let go of: what changing a filter back draws. */
export const KEPT_IDLE = 100;

export interface Client {
  /** The answer under this request's key, asking for it first if nobody has. */
  get(ask: Ask): Entry | undefined;
  /** Called when an answer lands or fails; returns how to stop listening. */
  subscribe(fn: () => void): () => void;
  /** Requests waiting on an answer (queued or in flight). */
  pending(): number;
  /**
   * A piece shows this request (asked for if nobody has); returns how to say it doesn't any more. When nothing shows a
   * request, one still coming stops being asked for (an outdated search), and its answer, once landed, is kept only
   * among the last answers nobody shows.
   */
  hold(ask: Ask): () => void;
  /** Stops asking for a request whose answer hasn't landed (nobody shows it any more: an outdated search). */
  letGo(ask: Ask): void;
  /** Drops a request's answer (a failure, to try again): the next `get` asks anew. */
  forget(ask: Ask): void;
  /** Asks again for a request that failed, the server's failed answer dropped too. */
  retry(ask: Ask): void;
  /** The answer under this request's key, asking for nothing: undefined while none has landed. */
  peek(ask: Ask): Entry | undefined;
  /** Every answer dropped (something changed outside): what's shown is asked for again. */
  reset(): void;
  /** How this open's answers have come in so far: its requests, rounds, looks and slowest queries. */
  speed(): OpenSpeed;
  /**
   * The open is over (its answers are all in): its speed is kept as it stands and nothing after counts, so a filter
   * changed later isn't mixed into it and a page open all day doesn't keep every request it ever made.
   */
  settleSpeed(): OpenSpeed;
}

export function createClient(
  call: Call,
  // Called as a function: a bare `setTimeout` called as a method of this object throws in a browser.
  timers: { set: (fn: () => void, ms: number) => unknown } = { set: (fn, ms) => setTimeout(fn, ms) },
): Client {
  const entries = new Map<string, Entry>();
  const wanted = new Map<string, Ask>();
  const tries = new Map<string, number>();
  // Each time a request is wanted anew, its generation: a retry loop of an earlier one stops when it comes due. Drawn
  // from one counter, so a request let go of (or dropped) loses its generation outright: one wanted again later gets
  // a number no earlier call carries.
  const gen = new Map<string, number>();
  let generations = 0;
  // How the answers come in (`speed`): every distinct request ever asked, the rounds its named queries were asked in
  // (a new one first asked after an answer has landed starts a round; a look for a queued answer and a request asked
  // again don't), the calls made, and each query's slowest answer.
  const asked = new Set<string>();
  const took = new Map<string, number>();
  let answered = 0;
  let rounds = 0;
  let looks = 0;
  let landedSinceRound = true;
  let settled: OpenSpeed | null = null;
  const speed = (): OpenSpeed =>
    settled ?? {
      asked: asked.size,
      answered,
      rounds,
      looks,
      slowest: [...took].map(([query, ms]) => ({ query, ms })).sort((a, b) => b.ms - a.ms),
    };
  const want = (key: string, ask: Ask) => {
    wanted.set(key, ask);
    gen.set(key, ++generations);
    if (settled || asked.has(key)) return;
    asked.add(key);
    // A grid's totals, a filter's values and a column's values are the kit's own follow-ups, not a screen waiting.
    if ("query" in ask && landedSinceRound) {
      rounds += 1;
      landedSinceRound = false;
    }
  };
  const landed = (ask: Ask, ms?: number) => {
    if (settled) return;
    answered += 1;
    landedSinceRound = true;
    if ("query" in ask && typeof ms === "number") took.set(ask.query, Math.max(took.get(ask.query) ?? 0, ms));
  };
  // How many pieces show each request now (`hold`), and the answers nobody shows any more, oldest first: kept a while
  // (a filter changed back draws at once), then dropped, so a page open all day doesn't keep every answer it ever had.
  const holds = new Map<string, number>();
  const idle = new Set<string>();
  const drop = (key: string) => {
    entries.delete(key);
    tries.delete(key);
    gen.delete(key);
    idle.delete(key);
  };
  const settle = (key: string) => {
    if ((holds.get(key) ?? 0) > 0) return;
    idle.delete(key);
    idle.add(key);
    for (const old of idle) {
      if (idle.size <= KEPT_IDLE) break;
      drop(old);
    }
  };
  const letGo = (key: string) => {
    const waited = wanted.delete(key);
    tries.delete(key);
    gen.delete(key);
    // Nothing may be waited for now: whoever watches for that hears it (after this, never in the middle of a piece
    // going away).
    if (waited) queueMicrotask(emit);
  };
  const listeners = new Set<() => void>();
  let batch: Map<string, Ask> | null = null;
  // After a reset, the next batch is asked as a retry: the server asks again for answers it was just asked for.
  let afresh = false;
  const emit = () => {
    for (const fn of listeners) fn();
  };

  /** Asks in calls of at most MAX_BATCH; each request's id is its place in its call (a key, every filter value in
   * it, can be long). */
  const send = (asks: Map<string, Ask>, retry = false) => {
    const all = [...asks];
    for (let i = 0; i < all.length; i += MAX_BATCH) sendCall(all.slice(i, i + MAX_BATCH), retry);
  };
  const sendCall = (part: [string, Ask][], retry: boolean) => {
    const sent = new Map(part.map(([key]) => [key, gen.get(key)]));
    if (!settled) looks += 1;
    call(
      part.map(([, a], i) => ({ id: String(i), ...a })),
      retry ? { retry: true } : undefined,
    )
      .then((answers) => {
        const again = new Map<string, Ask>();
        for (const a of answers) {
          const [key, ask] = part[Number(a.id)] ?? [];
          if (!key || !ask) continue;
          // Asked before a reset (or wanted anew since): this answer is for a request nobody waits on any more.
          if (gen.get(key) !== sent.get(key)) continue;
          if (a.status === "ok") {
            entries.set(key, {
              result: fromWire(a.result, a.periods?.now),
              ...(a.previous ? { previous: fromWire(a.previous, a.periods?.before) } : {}),
            });
            wanted.delete(key);
            landed(ask, Math.max(a.result.ms ?? 0, a.previous?.ms ?? 0) || undefined);
          } else if (a.status === "failed") {
            entries.set(key, { result: empty("error", a.error) });
            wanted.delete(key);
            landed(ask);
          } else if (wanted.has(key)) {
            // Asked again only while it's still wanted: one let go of (an outdated search) stops here.
            again.set(key, a.status === "queued" && a.at ? { ...ask, at: a.at } : ask);
          }
        }
        emit();
        if (again.size) {
          const n = Math.max(...[...again.keys()].map((k) => tries.get(k) ?? 0));
          for (const k of again.keys()) tries.set(k, (tries.get(k) ?? 0) + 1);
          // Only those still wanted, in the same generation, when it's time: one let go of (or wanted anew) meanwhile
          // isn't asked again by this loop.
          timers.set(() => {
            const still = new Map([...again].filter(([k]) => wanted.has(k) && gen.get(k) === sent.get(k)));
            if (still.size) send(still);
          }, backoff(n));
        }
      })
      .catch((error: Error) => {
        for (const [key] of part) {
          if (gen.get(key) !== sent.get(key)) continue;
          entries.set(key, { result: empty("error", error.message) });
          wanted.delete(key);
        }
        emit();
      });
  };

  const get = (ask: Ask) => {
    const key = keyOf(ask);
    const had = entries.get(key);
    if (had || wanted.has(key)) return had;
    want(key, ask);
    // A page's sections ask in the same tick: one call for all of them.
    if (!batch) {
      batch = new Map();
      queueMicrotask(() => {
        const asks = batch as Map<string, Ask>;
        batch = null;
        const retry = afresh;
        afresh = false;
        send(asks, retry);
      });
    }
    batch.set(key, ask);
    return undefined;
  };

  return {
    get,
    hold(ask) {
      const key = keyOf(ask);
      holds.set(key, (holds.get(key) ?? 0) + 1);
      idle.delete(key);
      // Shown again after it was let go (or dropped): asked for again.
      get(ask);
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        const n = (holds.get(key) ?? 1) - 1;
        if (n > 0) {
          holds.set(key, n);
          return;
        }
        holds.delete(key);
        // Nobody shows it now: an answer stays a while (idle), one still coming is no longer asked for.
        if (entries.has(key)) settle(key);
        else letGo(key);
      };
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    pending: () => wanted.size,
    letGo(ask) {
      const key = keyOf(ask);
      if (entries.has(key)) return;
      letGo(key);
    },
    forget(ask) {
      const key = keyOf(ask);
      entries.delete(key);
      tries.delete(key);
      idle.delete(key);
      emit();
    },
    peek: (ask) => entries.get(keyOf(ask)),
    speed,
    settleSpeed() {
      settled = speed();
      asked.clear();
      took.clear();
      return settled;
    },
    reset() {
      // Every generation goes: an answer to anything asked before lands on nothing.
      gen.clear();
      entries.clear();
      wanted.clear();
      tries.clear();
      idle.clear();
      afresh = true;
      emit();
    },
    retry(ask) {
      const key = keyOf(ask);
      if (wanted.has(key)) return;
      entries.delete(key);
      tries.delete(key);
      const { at: _at, ...fresh } = ask;
      want(key, fresh);
      emit();
      send(new Map([[key, fresh]]), true);
    },
  };
}
