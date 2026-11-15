// The frame's data client: a page's requests in one call, each answer kept under the request it answers, a queued one
// asked for again (with its bucket) until it lands, a failure kept until it's tried again, and an answer for filters no
// longer shown never drawn in place of the current one.
import { describe, expect, it } from "vitest";
import type { WireResult } from "../src/protocol";
import { type Answer, type Ask, createClient } from "../src/runtime/data";

const wire = (value: number): WireResult => ({
  requestId: "r",
  dataset: "accounts",
  columns: [{ name: "mrr", kind: "number", values: [value] }],
  rowCount: 1,
  total: 1,
  truncated: false,
  hidden: [],
  asOf: "2026-10-11T09:00:00.000Z",
});
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A page that answers from a script: each call takes the next list of answers by the order requests came. */
function page(script: ((ids: string[]) => Answer[])[]) {
  const calls: { id: string; at?: string }[][] = [];
  const timers: (() => void)[] = [];
  const client = createClient(
    async (requests) => {
      calls.push(requests.map((r) => ({ id: r.id, ...(r.at ? { at: r.at } : {}) })));
      const next = script.shift();
      return next ? next(requests.map((r) => r.id)) : [];
    },
    { set: (fn) => timers.push(fn) },
  );
  const poll = () => {
    for (const fn of timers.splice(0)) fn();
  };
  return { client, calls, poll };
}

const mrr: Ask = { query: "q_mrr", filters: { f_period: "this_month" } };
const growth: Ask = { query: "q_mrr", filters: { f_period: "this_month", f_plan: ["Growth"] } };

describe("the frame's data client", () => {
  it("asks for a page's requests in one call, and asks again for a queued one with its bucket", async () => {
    const at = "2026-10-11T09:00:00.000Z";
    const { client, calls, poll } = page([
      ([a, b]) => [
        { id: a as string, status: "queued", at },
        { id: b as string, status: "ok", result: wire(2) },
      ],
      ([a]) => [{ id: a as string, status: "ok", result: wire(1), previous: wire(0.5) }],
    ]);
    expect(client.get(mrr)).toBeUndefined();
    expect(client.get(growth)).toBeUndefined();
    // Asked twice in the same tick, still one request.
    expect(client.get(mrr)).toBeUndefined();
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
    expect(client.get(growth)?.result.col("mrr")).toEqual([2]);
    expect(client.pending()).toBe(1);
    poll();
    await tick();
    expect(calls[1]).toEqual([{ id: calls[0]?.[0]?.id, at }]);
    expect(client.get(mrr)?.result.col("mrr")).toEqual([1]);
    expect(client.get(mrr)?.previous?.col("mrr")).toEqual([0.5]);
    expect(client.pending()).toBe(0);
  });

  it("keeps each answer under its own request: the filters' old answer never stands for the new one", async () => {
    const { client } = page([([a]) => [{ id: a as string, status: "ok", result: wire(1) }]]);
    client.get(mrr);
    await tick();
    expect(client.get(mrr)?.result.col("mrr")).toEqual([1]);
    // The filters changed: nothing for these yet, whatever the last answer was.
    expect(client.get(growth)).toBeUndefined();
  });

  it("keeps a failure until it's tried again, and a broken bridge fails what it carried", async () => {
    const { client, calls } = page([
      ([a]) => [{ id: a as string, status: "failed", error: "The warehouse timed out." }],
      ([a]) => [{ id: a as string, status: "ok", result: wire(3) }],
    ]);
    client.get(mrr);
    await tick();
    expect(client.get(mrr)?.result).toMatchObject({ status: "error", error: "The warehouse timed out." });
    expect(calls).toHaveLength(1);
    client.forget(mrr);
    expect(client.get(mrr)).toBeUndefined();
    await tick();
    expect(client.get(mrr)?.result.col("mrr")).toEqual([3]);

    const broken = createClient(async () => {
      throw new Error("The page isn't answering.");
    });
    broken.get(mrr);
    await tick();
    await tick();
    expect(broken.get(mrr)?.result).toMatchObject({ status: "error", error: "The page isn't answering." });
  });
});

describe("a page with many queries", () => {
  it("asks in calls of at most sixteen, each request's id short however long its filter values", async () => {
    const sizes: number[] = [];
    const ids: string[] = [];
    const client = createClient(async (requests) => {
      sizes.push(requests.length);
      ids.push(...requests.map((r) => r.id));
      return requests.map((r) => ({ id: r.id, status: "ok" as const, result: wire(1) }));
    });
    const long = "x".repeat(120);
    for (let i = 0; i < 20; i++) client.get({ query: `q_${i}`, filters: { f_a: [long, long] } });
    await new Promise((r) => setTimeout(r, 0));
    expect(sizes).toEqual([16, 4]);
    expect(Math.max(...ids.map((id) => id.length))).toBeLessThanOrEqual(2);
    expect(client.get({ query: "q_19", filters: { f_a: [long, long] } })?.result.status).toBe("ok");
  });
});

describe("trying again", () => {
  it("asks the server to drop its failed answer, and lands the new one", async () => {
    const calls: { ids: string[]; retry: boolean }[] = [];
    let fail = true;
    const client = createClient(async (requests, opts) => {
      calls.push({ ids: requests.map((r) => r.id), retry: opts?.retry === true });
      return requests.map((r) =>
        fail
          ? { id: r.id, status: "failed" as const, error: "The warehouse timed out." }
          : { id: r.id, status: "ok" as const, result: wire(4) },
      );
    });
    const ask = { query: "q_mrr", filters: {} };
    client.get(ask);
    await new Promise((r) => setTimeout(r, 0));
    expect(client.get(ask)?.result.status).toBe("error");
    fail = false;
    client.retry(ask);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.map((c) => c.retry)).toEqual([false, true]);
    expect(client.get(ask)?.result.status).toBe("ok");
  });
});

describe("a request's key", () => {
  it("is the same for the same sets in another order, and different for different conditions", async () => {
    const { keyOf } = await import("../src/runtime/data");
    const a = keyOf({
      query: "q_list",
      filters: { f_c: ["US", "DE"] },
      where: [
        ["plan", "in", ["B", "A"]],
        ["mrr", ">=", 5],
      ],
    });
    const b = keyOf({
      query: "q_list",
      filters: { f_c: ["DE", "US"] },
      where: [
        ["mrr", ">=", 5],
        ["plan", "in", ["A", "B"]],
      ],
    });
    expect(a).toBe(b);
    expect(keyOf({ query: "q", filters: {}, where: [["a", ">=", "b"]] })).not.toBe(
      keyOf({ query: "q", filters: {}, where: [["b", ">=", "a"]] }),
    );
    expect(keyOf({ query: "q", filters: {}, at: "x" })).toBe(keyOf({ query: "q", filters: {} }));
    expect(keyOf({ lookup: "f_c", filters: {}, search: "u" })).not.toBe(
      keyOf({ lookup: "f_c", filters: {}, search: "us" }),
    );
  });
});

describe("an outdated request", () => {
  it("isn't asked for again once it's let go of (a search typed past), and an answer already here stays", async () => {
    const at = "2026-10-11T09:00:00.000Z";
    const old: Ask = { query: "q_list", filters: {}, search: "a" };
    const now: Ask = { query: "q_list", filters: {}, search: "acme" };
    const { client, calls, poll } = page([
      ([a]) => [{ id: a as string, status: "queued", at }],
      ([a]) => [{ id: a as string, status: "queued", at }],
      ([a]) => [{ id: a as string, status: "ok", result: wire(3) }],
    ]);
    client.get(old);
    await tick();
    // The search moves on before the old one's answer lands: it's let go of, the new one asked.
    client.letGo(old);
    client.get(now);
    await tick();
    poll();
    await tick();
    expect(calls.map((c) => c.length)).toEqual([1, 1, 1]);
    expect(client.get(now)?.result.col("mrr")).toEqual([3]);
    expect(client.pending()).toBe(0);
  });
});

describe("a search that comes back", () => {
  it("is asked again by one loop, not by the old one too", async () => {
    const at = "2026-10-11T09:00:00.000Z";
    const a: Ask = { query: "q_list", filters: {}, search: "a" };
    const acme: Ask = { query: "q_list", filters: {}, search: "acme" };
    const queued = (ids: string[]): Answer[] => ids.map((id) => ({ id, status: "queued", at }));
    const { client, calls, poll } = page([queued, queued, queued, queued, queued, queued]);
    client.get(a);
    await tick();
    client.letGo(a);
    client.get(acme);
    await tick();
    client.letGo(acme);
    client.get(a);
    await tick();
    const before = calls.length;
    poll();
    await tick();
    // One call for the search shown (a), from its own loop: the first a's loop and acme's stop.
    expect(calls.length - before).toBe(1);
    expect(calls.at(-1)).toHaveLength(1);
  });
});

describe("a named query's cells", () => {
  it("carry what opens the rows behind them: the query, the row's groups, the filters asked with, a service's read", async () => {
    const { fromWire, openingCells } = await import("../src/runtime/data");
    const result = fromWire({
      ...wire(0),
      columns: [
        { name: "country", kind: "text", values: ["DE", null] },
        { name: "accounts", kind: "number", values: [12, 3] },
      ],
      rowCount: 2,
      service: { name: "Tracker", fetchedAt: "2026-10-11T09:00:00.000Z", incomplete: false, cut: 0, snapshot: "s1" },
    });
    const cell = openingCells(result, "q_by_country", ["country"], { f_period: "last_month" });
    expect(cell(0, "accounts")).toMatchObject({
      value: 12,
      source: {
        column: "accounts",
        open: { query: "q_by_country", group: { country: "DE" }, asked: { f_period: "last_month" }, pin: "s1" },
      },
    });
    expect(cell(1, "accounts").source.open?.group).toEqual({ country: null });
  });
});

describe("what the pieces show", () => {
  it("stops asking for a request once nothing shows it, and goes on while another piece still does", async () => {
    const at = "2026-10-11T09:00:00.000Z";
    const queued = (ids: string[]): Answer[] => ids.map((id) => ({ id, status: "queued", at }));
    const { client, calls, poll } = page([queued, queued, queued]);
    const first = client.hold(mrr);
    const second = client.hold(mrr);
    await tick();
    expect(calls).toHaveLength(1);
    // One of the two pieces goes (said twice, counted once): the other still shows it, so it's asked again.
    first();
    first();
    poll();
    await tick();
    expect(calls).toHaveLength(2);
    // The last goes (a search typed on, a record changed): its loop stops.
    second();
    poll();
    await tick();
    expect(calls).toHaveLength(2);
    expect(client.pending()).toBe(0);
    // Shown again: asked for again.
    client.hold(mrr);
    await tick();
    expect(calls).toHaveLength(3);
  });

  it("keeps the answers nobody shows only up to a bound, and every answer a piece shows", async () => {
    const { KEPT_IDLE } = await import("../src/runtime/data");
    const client = createClient(async (requests) =>
      requests.map((r) => ({ id: r.id, status: "ok" as const, result: wire(1) })),
    );
    const ask = (i: number): Ask => ({ query: "q_list", filters: {}, search: `s${i}` });
    const shown = client.hold(ask(0));
    await tick();
    for (let i = 1; i <= KEPT_IDLE + 20; i++) {
      const release = client.hold(ask(i));
      await tick();
      release();
    }
    // The one still shown stays; of those let go, the most recent are kept, the oldest dropped.
    expect(client.peek(ask(0))?.result.status).toBe("ok");
    expect(client.peek(ask(KEPT_IDLE + 20))?.result.status).toBe("ok");
    expect(client.peek(ask(1))).toBeUndefined();
    const kept = Array.from({ length: KEPT_IDLE + 20 }, (_, i) => client.peek(ask(i + 1))).filter(Boolean);
    expect(kept).toHaveLength(KEPT_IDLE);
    shown();
  });
});

describe("how an open's answers came in", () => {
  const book: Ask = { query: "q_book", filters: {} };
  const account: Ask = { query: "q_account", filters: {}, record: 42 };
  const usage: Ask = { query: "q_usage", filters: {}, record: 42 };
  const timed = (value: number, ms: number): WireResult => ({ ...wire(value), ms });

  it("is one round when a screen asks for everything at once, however many looks a queued answer takes", async () => {
    const { client, poll } = page([
      ([a, b]) => [
        { id: a as string, status: "queued", at: "2026-10-11T09:00:00.000Z" },
        { id: b as string, status: "ok", result: timed(2, 310) },
      ],
      ([a]) => [{ id: a as string, status: "queued", at: "2026-10-11T09:00:00.000Z" }],
      ([a]) => [{ id: a as string, status: "ok", result: timed(1, 2400), previous: timed(1, 2600) }],
    ]);
    client.get(book);
    client.get(account);
    await tick();
    poll();
    await tick();
    poll();
    await tick();
    expect(client.speed()).toEqual({
      asked: 2,
      answered: 2,
      rounds: 1,
      looks: 3,
      // Each query's slowest answer (the period before counts), slowest first.
      slowest: [
        { query: "q_book", ms: 2600 },
        { query: "q_account", ms: 310 },
      ],
    });
  });

  it("counts a round for each query first asked after an answer has landed, and none for the kit's own follow-ups", async () => {
    const ok = ([a]: string[]): Answer[] => [{ id: a as string, status: "ok", result: timed(1, 900) }];
    const { client } = page([ok, ok, ok, ok]);
    client.get(book);
    await tick();
    // The list is in: only now is the record asked for, and only when it's in, what hangs under it.
    client.get(account);
    await tick();
    client.get(usage);
    // Asked for again, and a grid's totals: neither is a screen waiting on another.
    client.get(book);
    client.get({ totals: "q_usage", filters: {} });
    await tick();
    expect(client.speed()).toMatchObject({ asked: 4, rounds: 3 });
  });

  it("is kept as it stood once the open is over: a filter changed later isn't mixed into it", async () => {
    const ok = ([a]: string[]): Answer[] => [{ id: a as string, status: "ok", result: timed(1, 900) }];
    const { client } = page([ok, ok]);
    client.get(book);
    await tick();
    const open = client.settleSpeed();
    expect(open).toMatchObject({ asked: 1, answered: 1, rounds: 1, looks: 1 });
    client.get(growth);
    await tick();
    expect(client.get(growth)?.result.col("mrr")).toEqual([1]);
    expect(client.speed()).toEqual(open);
  });

  it("tells whoever watches when the last request waited for is let go of, so an open isn't left unfinished", async () => {
    const { client } = page([
      ([a, b]) => [
        { id: a as string, status: "ok", result: timed(1, 300) },
        { id: b as string, status: "queued", at: "2026-10-11T09:00:00.000Z" },
      ],
    ]);
    const stopBook = client.hold(book);
    const stopAccount = client.hold(account);
    await tick();
    expect(client.pending()).toBe(1);
    let heard = 0;
    client.subscribe(() => {
      heard += 1;
    });
    // The piece that waited for the queued answer goes away.
    stopAccount();
    await tick();
    expect(client.pending()).toBe(0);
    expect(heard).toBeGreaterThan(0);
    stopBook();
  });
});
