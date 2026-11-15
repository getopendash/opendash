// The run vocabulary: events in, the rows the Ask UI shows out.
import { describe, expect, it } from "vitest";
import {
  answerDraft,
  checkedDetail,
  latestThought,
  type RunEventLike,
  runSteps,
  runSummary,
  shortDuration,
  standingEvents,
} from "../lib/run-steps";

let seq = 0;
const t0 = Date.parse("2026-10-10T12:00:00Z");
const ev = (type: string, data: Record<string, unknown> = {}, at = 0, attempt = 1): RunEventLike => ({
  seq: ++seq,
  attempt,
  type,
  data,
  createdAt: new Date(t0 + at).toISOString(),
});

describe("run steps", () => {
  it("says what each dashboard step did: planned, a draft that didn't pass, the draft saved", () => {
    seq = 0;
    const call = (id: string, tool: string, input: Record<string, unknown>, result: Record<string, unknown>) => [
      ev("tool_started", { callId: id, tool, input }, 100),
      ev("tool_result", { callId: id, tool, status: "succeeded", ...result }, 150),
    ];
    const steps = runSteps(
      [
        ev("attempt_started", { attempt: 1 }),
        ...call("a", "dashboard_plan", { title: "Sign-ups" }, { title: "Sign-ups", pages: 2 }),
        ...call("b", "dashboard_save", {}, { failed: true, message: "The definition doesn't pass its check" }),
        ...call(
          "c",
          "dashboard_save",
          {},
          { dashboardId: "d", title: "Sign-ups", revision: "r", made: true, sections: 4, parts: 1 },
        ),
        ...call("d", "dashboard_open", { dashboard_id: "d" }, { dashboardId: "d", title: "Sign-ups" }),
      ],
      { source: "demo" },
    );
    expect(steps.slice(1).map((x) => [x.label, x.status, x.detail ?? ""])).toEqual([
      ["Planned Sign-ups", "ok", "2 pages"],
      // Quiet, never a warning: the agent fixing its own work.
      ["The check found something to fix", "info", "fixing it"],
      ["Saved the draft of Sign-ups", "ok", "4 sections · 1 custom part · only you see it"],
      ["Read Sign-ups", "ok", ""],
    ]);
  });

  it("turns a run's events into the Ask UI's rows, with no tool names", () => {
    seq = 0;
    const events = [
      ev("attempt_started", { attempt: 1 }),
      ev("assistant_message", { reasoning: "September against August, split by plan." }, 4000),
      // A table's file from the knowledge folder, then catalog_describe as a run from before it called it.
      ev(
        "tool_started",
        { callId: "a", tool: "read", input: { path: "/sources/acme_production/tables/public.subscriptions.md" } },
        4100,
      ),
      ev("tool_result", { callId: "a", tool: "read", status: "succeeded" }, 4200),
      ev("tool_started", { callId: "b", tool: "catalog_describe", input: { table: "public.plans" } }, 4300),
      ev("tool_result", { callId: "b", tool: "catalog_describe", status: "succeeded" }, 4400),
      ev("tool_started", { callId: "c", tool: "value_lookup", input: { term: "Germany" } }, 5000),
      ev("tool_result", { callId: "c", tool: "value_lookup", status: "succeeded", common: ["country"] }, 5050),
      ev("tool_started", { callId: "c2", tool: "value_lookup", input: { term: "growth" } }, 5060),
      ev(
        "tool_result",
        { callId: "c2", tool: "value_lookup", status: "succeeded", best: { column: "name", value: "Growth" } },
        5080,
      ),
      ev(
        "tool_started",
        { callId: "d", tool: "sql_query", input: { title: "Churned MRR by plan", sql: "select 1" } },
        6000,
      ),
      ev(
        "tool_result",
        {
          callId: "d",
          tool: "sql_query",
          status: "succeeded",
          alias: "q1",
          title: "Churned MRR by plan",
          rows: 2,
          durationMs: 98,
        },
        6100,
      ),
      ev("tool_started", { callId: "e", tool: "sql_query", input: { title: "Payments" } }, 7000),
      ev(
        "tool_result",
        { callId: "e", tool: "sql_query", status: "failed", failed: true, message: "No access to billing.payments" },
        7100,
      ),
      ev("tool_started", { callId: "f", tool: "answer", input: {} }, 8000),
      ev(
        "tool_result",
        {
          callId: "f",
          tool: "answer",
          status: "succeeded",
          accepted: true,
          verified: true,
          numbers: 4,
          crossChecks: 1,
        },
        8100,
      ),
      ev("run_end", { status: "succeeded", outcome: "answer" }, 8200),
    ];
    const steps = runSteps(events, { source: "acme_production" });
    expect(steps.map((x) => [x.label, x.status, x.detail])).toEqual([
      ["Read context", "ok", "Catalog of acme_production"],
      ["Thinking", "ok", "Thought for 4s"],
      ["Looked at 2 tables", "ok", "public.subscriptions, public.plans"],
      ['Looked up "Germany"', "ok", "read the most common values of country"],
      ['Matched "growth"', "ok", "name = 'Growth'"],
      ["q1 · Churned MRR by plan", "ok", "98 ms · 2 rows"],
      ["Payments", "fail", "No access to billing.payments"],
      ["Checked the results", "ok", "4 numbers checked · cross-check passed"],
    ]);
    expect(steps[1]?.notes).toMatch(/September against August/);
    expect(JSON.stringify(steps)).not.toMatch(/sql_query|value_lookup|catalog_describe|"read"/);
  });

  it("shows a capped query, a repair, a wrap-up and a takeover, and drops what a dead attempt never committed", () => {
    seq = 0;
    const events = [
      ev("attempt_started", { attempt: 1 }),
      ev("tool_started", { callId: "a", tool: "sql_query", input: { title: "Canceled subscriptions" } }, 100),
      ev(
        "tool_result",
        { callId: "a", tool: "sql_query", status: "succeeded", alias: "q1", rows: 1000, truncated: true },
        200,
      ),
      ev("tool_started", { callId: "x", tool: "sql_query", input: { title: "Never finished" } }, 300),
      ev("attempt_started", { attempt: 2, discardAfterSeq: 3 }, 400, 2),
      ev("note", { text: "Time to answer." }, 500, 2),
      ev("tool_started", { callId: "b", tool: "answer", input: {} }, 600, 2),
      ev("tool_result", { callId: "b", tool: "answer", accepted: false, problems: ["typed number"] }, 700, 2),
    ];
    expect(standingEvents(events).map((e) => e.seq)).not.toContain(4);
    expect(runSteps(events, { source: "s" }).map((x) => [x.label, x.status, x.detail])).toEqual([
      ["Read context", "running", "Catalog of s"],
      ["q1 · Canceled subscriptions", "warn", "first 1,000 rows"],
      ["Picked up where it left off", "info", undefined],
      ["Wrapping up", "info", "time to answer"],
      ["Checking the results", "running", "fixing 1 problem"],
    ]);
  });

  it("marks a query whose result the gateway warned about", () => {
    seq = 0;
    const events = [
      ev("tool_started", { callId: "a", tool: "sql_query", input: { title: "Signups this month", sql: "select 1" } }),
      ev("tool_result", {
        callId: "a",
        tool: "sql_query",
        status: "succeeded",
        alias: "q1",
        title: "Signups this month",
        rows: 1,
        durationMs: 40,
        warnings: ["October isn't over yet: its numbers are partial."],
      }),
    ];
    expect(runSteps(events, { source: "s" }).map((x) => [x.label, x.status, x.detail])).toEqual([
      ["q1 · Signups this month", "warn", "40 ms · 1 row · 1 warning"],
    ]);
  });

  it("says what was checked from the answer once the run's events are gone", () => {
    const at = (s: number) => new Date(t0 + s * 1000).toISOString();
    const done = { status: "succeeded", queuedAt: at(0), startedAt: at(0), finishedAt: at(19) };
    expect(runSummary([], done, 0, { verified: true, checked: { numbers: 14, crossChecks: 1 } })).toBe(
      "Analyzed for 19s · 14 numbers checked · cross-check passed",
    );
    expect(runSummary([], done, 0, null)).toBe("Analyzed for 19s");
    expect(checkedDetail(false, { numbers: 3, crossChecks: 0 })).toBe("some numbers couldn't be verified");
    expect(checkedDetail(true, { numbers: 0, crossChecks: 0 })).toBe("no numbers to check");
  });

  it("summarises the run as it stands", () => {
    const steps = [
      { key: "q1", status: "ok" as const, label: "q1 · x", alias: "q1" },
      { key: "check", status: "ok" as const, label: "Checked the results", detail: "4 numbers checked" },
    ];
    const at = (s: number) => new Date(t0 + s * 1000).toISOString();
    expect(runSummary([], { status: "queued", queuedAt: at(0), startedAt: null, finishedAt: null }, t0)).toBe(
      "Starting…",
    );
    expect(
      runSummary(steps, { status: "running", queuedAt: at(0), startedAt: at(0), finishedAt: null }, t0 + 12_000),
    ).toBe("Working · 12s · 1 query · 4 numbers checked");
    expect(runSummary(steps, { status: "succeeded", queuedAt: at(0), startedAt: at(0), finishedAt: at(24) }, 0)).toBe(
      "Analyzed for 24s · 1 query · 4 numbers checked",
    );
    expect(runSummary([], { status: "cancelled", queuedAt: at(0), startedAt: at(0), finishedAt: at(8) }, 0)).toBe(
      "Stopped · 8s",
    );
    expect(shortDuration(98)).toBe("98 ms");
    expect(shortDuration(64_000)).toBe("1 m 04 s");
  });
});

describe("a dashboard built a page at a time", () => {
  it("is made at Build it, names each page and its sections as they're written, and says why a page failed", () => {
    seq = 0;
    const events = [
      ev("attempt_started", { attempt: 1 }),
      ev("tool_started", { callId: "a", tool: "dashboard_start", input: {} }, 100),
      ev(
        "tool_result",
        { callId: "a", tool: "dashboard_start", status: "succeeded", dashboardId: "d", title: "Desk" },
        150,
      ),
      ev("delta", { building: ["b"] }, 200),
      ev(
        "delta",
        {
          outline: [
            {
              callId: "b",
              items: [
                { id: "p_c", title: "Customers" },
                { id: "s_1", title: "Summary" },
              ],
            },
          ],
        },
        300,
      ),
    ];
    const writing = runSteps(events, { source: "demo" });
    expect(writing.map((x) => [x.label, x.status])).toContainEqual(["Started Desk", "ok"]);
    expect(writing.at(-1)).toMatchObject({ label: "Writing Customers", lines: ["Summary"], status: "running" });
    const refused = runSteps(
      [
        ...events,
        ev("tool_started", { callId: "b", tool: "dashboard_page", input: { page: { title: "Customers" } } }, 400),
        ev(
          "tool_result",
          {
            callId: "b",
            tool: "dashboard_page",
            status: "succeeded",
            failed: true,
            message: "The definition doesn't pass its check: nothing was saved.",
            problems: ["“Users by status” on Customers: a chart type: line, bar…"],
          },
          500,
        ),
      ],
      { source: "demo" },
    );
    expect(refused.at(-1)).toMatchObject({
      label: "The check found 1 thing to fix",
      status: "info",
      icon: "fix",
      found: ["“Users by status” on Customers: a chart type: line, bar…"],
    });
    const saved = runSteps(
      [
        ...events,
        ev("tool_started", { callId: "b", tool: "dashboard_page", input: { page: { title: "Customers" } } }, 400),
        ev(
          "tool_result",
          {
            callId: "b",
            tool: "dashboard_page",
            status: "succeeded",
            dashboardId: "d",
            revision: "r",
            page: "Customers",
            sections: 6,
          },
          500,
        ),
      ],
      { source: "demo" },
    );
    expect(saved.at(-1)).toMatchObject({ label: "Saved Customers", status: "ok" });
    expect(saved.at(-1)?.lines).toBeUndefined();
  });
});

describe("a dashboard being built", () => {
  it("is written, then checked, in one row", () => {
    seq = 0;
    const live = [ev("attempt_started", { attempt: 1 }), ev("delta", { building: ["d1"] }, 200)];
    expect(runSteps(live, { source: "demo" }).at(-1)).toMatchObject({
      label: "Writing",
      status: "running",
    });
    const after = runSteps(
      [...live, ev("tool_started", { callId: "d1", tool: "dashboard_save", input: { dashboard_id: "x" } }, 900)],
      { source: "demo" },
    );
    expect(after.filter((x) => x.key === "d1")).toEqual([
      expect.objectContaining({ label: "Saving it", status: "running" }),
    ]);
  });

  it("names each file of an App's save as it's typed, then each its own row before the build that checks them", () => {
    seq = 0;
    const live = [
      ev("attempt_started", { attempt: 1 }),
      ev("delta", { building: ["d1"] }, 200),
      ev(
        "delta",
        {
          files: [
            {
              callId: "d1",
              items: [
                { kind: "manifest" },
                { kind: "write", path: "/App.tsx", lines: 40 },
                { kind: "write", path: "/components/Queue.tsx", lines: 12 },
              ],
            },
          ],
        },
        400,
      ),
    ];
    expect(runSteps(live, { source: "demo" }).map((x) => [x.label, x.status, x.detail ?? ""])).toEqual([
      ["Read context", "ok", "Catalog of demo"],
      ["Wrote the manifest", "ok", "its queries and filters"],
      ["Wrote App.tsx", "ok", "40 lines"],
      ["Writing components/Queue.tsx", "running", "12 lines"],
    ]);
    const input = {
      dashboard_id: "x",
      definition: { version: 2 },
      files: { "/App.tsx": "a\nb", "/components/Queue.tsx": "q" },
      edits: [{ file: "/lib/format.ts", old: "a", new: "b\nc" }],
    };
    const failed = runSteps(
      [
        ...live,
        ev("tool_started", { callId: "d1", tool: "dashboard_save", input }, 900),
        ev(
          "tool_result",
          { callId: "d1", tool: "dashboard_save", status: "succeeded", failed: true, count: 2, problems: ["x"] },
          950,
        ),
      ],
      { source: "demo" },
    );
    expect(failed.slice(1).map((x) => [x.label, x.status, x.icon ?? ""])).toEqual([
      ["Wrote the manifest", "ok", "file"],
      ["Wrote App.tsx", "ok", "file"],
      ["Wrote components/Queue.tsx", "ok", "file"],
      ["Edited lib/format.ts", "ok", "edit"],
      ["The check found 2 things to fix", "info", "fix"],
    ]);
  });
});

describe("streaming", () => {
  it("fills in a live Thinking row and Writing a query rows, then the committed ones take their place", () => {
    seq = 0;
    const live = [
      ev("attempt_started", { attempt: 1 }),
      ev("delta", { thinking: "September against " }, 100),
      ev("delta", { thinking: "August.", writing: ["c1"] }, 300),
    ];
    const during = runSteps(live, { source: "demo" });
    // The model is writing, so what it was given has been read.
    expect(during.map((x) => [x.label, x.status])).toEqual([
      ["Read context", "ok"],
      ["Thinking", "running"],
      ["Writing a query", "running"],
    ]);
    expect(during[1]?.notes).toBe("September against August.");
    const after = runSteps(
      [
        ...live,
        ev("assistant_message", { reasoning: "September against August." }, 4000),
        ev("tool_started", { callId: "c1", tool: "sql_query", input: { title: "MRR by month" } }, 4100),
      ],
      { source: "demo" },
    );
    expect(after.map((x) => [x.label, x.status])).toEqual([
      ["Read context", "ok"],
      ["Thinking", "ok"],
      ["MRR by month", "running"],
    ]);
    // "Thought for 4s" counts from the event before the call, not from its last delta.
    expect(after[1]?.detail).toBe("Thought for 4s");
  });

  it("shows the answer being written, then its check in the same place", () => {
    seq = 0;
    const live = [
      ev("attempt_started", { attempt: 1 }),
      ev("delta", { answer: { callId: "a1", text: "MRR was " } }, 100),
    ];
    expect(runSteps(live, { source: "demo" }).map((x) => x.label)).toEqual(["Read context", "Writing the answer"]);
    const checked = runSteps(
      [
        ...live,
        ev("assistant_message", {}, 900),
        ev("tool_started", { callId: "a1", tool: "answer", input: {} }, 950),
        ev("tool_result", { callId: "a1", tool: "answer", accepted: true, verified: true, numbers: 1 }, 990),
      ],
      { source: "demo" },
    );
    expect(checked.map((x) => [x.label, x.status])).toEqual([
      ["Read context", "ok"],
      ["Checked the results", "ok"],
    ]);
  });

  it("keeps the latest answer call's draft, drops a refused one, and an earlier attempt's", () => {
    seq = 0;
    const first = [
      ev("attempt_started", { attempt: 1 }),
      ev("delta", { answer: { callId: "a1", text: "MRR was 412" } }, 100),
    ];
    expect(answerDraft(first)).toBe("MRR was 412");
    const refused = [...first, ev("tool_result", { callId: "a1", tool: "answer", accepted: false }, 200)];
    expect(answerDraft(refused)).toBeNull();
    // A call that failed (its input didn't match its form) is gone too.
    const failed = [...first, ev("tool_result", { callId: "a1", tool: "answer", status: "failed", failed: true }, 200)];
    expect(answerDraft(failed)).toBeNull();
    const repaired = [
      ...refused,
      ev("delta", { answer: { callId: "a2", text: "MRR was " } }, 300),
      ev("delta", { answer: { callId: "a2", text: "⟦q1:0:mrr⟧." } }, 400),
    ];
    expect(answerDraft(repaired)).toBe("MRR was ⟦q1:0:mrr⟧.");
    // A new attempt took over: what the old one streamed is gone.
    const taken = [...repaired, ev("attempt_started", { attempt: 2, discardAfterSeq: 99 }, 500, 2)];
    expect(answerDraft(taken)).toBeNull();
    expect(standingEvents(taken).filter((e) => e.type === "delta")).toEqual([]);
  });
});

describe("several sources", () => {
  it("names the source a step read when it isn't the one the question started from", () => {
    seq = 0;
    const steps = runSteps(
      [
        ev("attempt_started", { attempt: 1 }),
        ev(
          "tool_started",
          { callId: "a", tool: "read", input: { path: "/sources/support_db/tables/support.tickets.md" } },
          100,
        ),
        ev("tool_result", { callId: "a", tool: "read", status: "succeeded", source: "support_db" }, 150),
        // A skill read is a line of its own.
        ev("tool_started", { callId: "r", tool: "read", input: { path: "/skills/churn/SKILL.md" } }, 160),
        ev("tool_result", { callId: "r", tool: "read", status: "succeeded" }, 170),
        ev("tool_started", { callId: "b", tool: "sql_query", input: { title: "Tickets", source: "support_db" } }, 200),
        ev(
          "tool_result",
          {
            callId: "b",
            tool: "sql_query",
            status: "succeeded",
            alias: "q2",
            title: "Tickets",
            rows: 2,
            durationMs: 41,
            source: "support_db",
          },
          300,
        ),
        ev("tool_started", { callId: "c", tool: "sql_query", input: { title: "MRR" } }, 400),
        ev(
          "tool_result",
          { callId: "c", tool: "sql_query", status: "succeeded", alias: "q3", title: "MRR", rows: 1, durationMs: 9 },
          500,
        ),
      ],
      { source: "billing" },
    );
    expect(steps.map((x) => [x.label, x.detail, x.source ?? null])).toEqual([
      ["Read context", "Catalog of billing", null],
      ["Looked at 1 table", "support.tickets · support_db", null],
      ["Read skill churn", undefined, null],
      ["q2 · Tickets", "support_db · 41 ms · 2 rows", "support_db"],
      ["q3 · MRR", "9 ms · 1 row", null],
    ]);
  });
});

describe("latestThought", () => {
  it("shows the last finished sentence of live thinking, not the whole notes", () => {
    expect(latestThought("I'm tallying the call list. Next I'm drafting the queries. Now I'm settl")).toBe(
      "Next I'm drafting the queries.",
    );
    expect(latestThought("One. Two is done.")).toBe("Two is done.");
    expect(latestThought("x".repeat(200))?.length).toBe(90);
  });
});
