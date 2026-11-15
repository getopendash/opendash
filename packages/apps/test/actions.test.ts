// A row's actions: their arguments are literal but for the one that's exactly "{key}"; a definition
// says where one is wrong; and after one runs, the page asks again for what it shows (as a retry).
import { describe, expect, it } from "vitest";
import { checkDefinition, type Definition } from "../src/dashboard";
import { actionArgumentsProblem, actionKey, fillAction } from "../src/dashboard/actions";
import type { WireResult } from "../src/protocol";
import { createClient } from "../src/runtime/data";
import { ACME } from "./fixtures/acme-catalog";
import { proof, SOURCE } from "./fixtures/proof";

const SERVER = "019a0000-0000-7000-8000-000000000001";
const withActions = (actions: unknown): Definition => {
  const d = structuredClone(proof());
  (d.queries.q_accounts as unknown as Record<string, unknown>).actions = actions;
  return d;
};
const problems = (d: unknown) => {
  const r = checkDefinition(d, { catalogs: { [SOURCE]: ACME } });
  return r.ok ? [] : r.problems.map((p) => p.message);
};
const action = (over: Record<string, unknown> = {}) => ({
  id: "a_done",
  label: "Move to Done",
  connection: SERVER,
  tool: "transition_issue",
  arguments: { issue: "{key}", to: { id: "31" } },
  ...over,
});

describe("a row's action", () => {
  it("fills the row's key where an argument is exactly {key}, and nowhere else", () => {
    expect(fillAction({ issue: "{key}", to: { id: "31" }, list: ["{key}", "x"] }, "ACME-1")).toEqual({
      issue: "ACME-1",
      to: { id: "31" },
      list: ["ACME-1", "x"],
    });
    expect(fillAction({ id: "{key}" }, 42)).toEqual({ id: 42 });
    expect(actionArgumentsProblem({ issue: "{key}" })).toBeNull();
    expect(actionArgumentsProblem({ issue: "ACME-{key}" })).toContain("exactly");
    expect(actionArgumentsProblem({ issue: "ACME-1" })).toContain("names its row");
    expect(actionArgumentsProblem({ issue: "{key}", big: "x".repeat(5000) })).toContain("4 KB");
    expect(actionKey(" ACME-1 ")).toBe("ACME-1");
    expect(actionKey("a\u0000b")).toBeNull();
    expect(actionKey(Number.NaN)).toBeNull();
    expect(actionKey({})).toBeNull();
  });

  it("is checked with the definition: its id, its arguments, its question, at most three", () => {
    expect(problems(withActions([action()]))).toEqual([]);
    expect(problems(withActions([action({ arguments: { issue: "ACME-1" } })]))).toEqual([
      expect.stringContaining("names its row"),
    ]);
    expect(problems(withActions([action(), action()]))).toContain("Each action's id once.");
    expect(problems(withActions([action({ confirm: "Move {key} to {status}?" })]))).toEqual([
      expect.stringContaining("nothing else in braces"),
    ]);
    expect(problems(withActions([action({ id: "done" })])).length).toBeGreaterThan(0);
    expect(problems(withActions([1, 2, 3, 4].map((n) => action({ id: `a_${n}` })))).length).toBeGreaterThan(0);
  });
});

describe("after a change", () => {
  it("asks again for every answer it shows, as a retry", async () => {
    const wire: WireResult = {
      requestId: "r",
      dataset: "issues",
      columns: [{ name: "n", kind: "number", values: [2] }],
      rowCount: 1,
      total: 1,
      truncated: false,
      hidden: [],
      asOf: "2026-11-08T09:00:00.000Z",
    };
    const calls: { ids: string[]; retry: boolean }[] = [];
    const client = createClient(async (requests, opts) => {
      calls.push({ ids: requests.map((r) => r.id), retry: opts?.retry ?? false });
      return requests.map((r) => ({ id: r.id, status: "ok" as const, result: wire }));
    });
    const ask = { query: "q_count", filters: {} };
    client.get(ask);
    await new Promise((r) => setTimeout(r, 0));
    expect(client.peek(ask)?.result.status).toBe("ok");
    client.reset();
    expect(client.peek(ask)).toBeUndefined();
    client.get(ask);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.map((c) => c.retry)).toEqual([false, true]);
    // An answer to a request made before the reset is never drawn over the new one.
    let release: (v: unknown) => void = () => {};
    const slow = createClient(async (requests) => {
      if (requests.length && !(slow as unknown as { started?: boolean }).started) {
        (slow as unknown as { started?: boolean }).started = true;
        await new Promise((r) => {
          release = r;
        });
        return requests.map((r) => ({
          id: r.id,
          status: "ok" as const,
          result: { ...wire, columns: [{ name: "n", kind: "number" as const, values: [1] }] },
        }));
      }
      return requests.map((r) => ({ id: r.id, status: "ok" as const, result: wire }));
    });
    slow.get(ask);
    await new Promise((r) => setTimeout(r, 0));
    slow.reset();
    slow.get(ask);
    await new Promise((r) => setTimeout(r, 0));
    release(null);
    await new Promise((r) => setTimeout(r, 0));
    expect(slow.peek(ask)?.result.col("n")[0]).toBe(2);
    // Then as usual again.
    client.get({ query: "q_other", filters: {} });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.at(-1)?.retry).toBe(false);
  });
});
