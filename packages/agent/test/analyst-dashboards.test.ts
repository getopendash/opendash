// The analyst builds dashboards in the one conversation, with a scripted model (no spend): asked for
// one, it plans it (the plan ends its turn); told "Build it", it saves the definition (a dataset the source doesn't
// have is refused, nothing saved), fixes it, adds a custom part, and answers. The person publishes, never the analyst:
// what it saves is its owner's draft. A save without its id finds the conversation's dashboard of that title; another
// conversation can't change it; and a conversation about anything else is never given the tools or the skill.
import {
  checkDefinitions,
  dashboards,
  demoPack,
  installDefinitions,
  listDefinitions,
  runEvents,
  submitQuestion,
  verifyDefinitions,
} from "@opendash/core";
import { type LearnedSource, learnedSource } from "@opendash/core/testing";
import { uuidv7 } from "@opendash/db";
import type { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentDeps, runAttempt } from "../src";
import { analyst } from "../src/agents/analyst";
import { call, type Prompt, scripted, step, systemOf } from "./helpers/scripted";

const NOW = new Date("2026-10-10T12:00:00Z");
let s: LearnedSource;
let threadId = "";
let dashboardId = "";

const deps = (model: MockLanguageModelV4): AgentDeps => ({
  withTenant: s.deps.withTenant,
  secrets: s.secrets,
  edition: "community",
  model: async () => ({
    model,
    provider: "opendash",
    route: "anthropic",
    providerOptions: {},
    keySource: "deployment",
  }),
  now: () => NOW,
});

const ask = (text: string, more: { threadId?: string; attachments?: { kind: "dashboard"; id: string }[] } = {}) =>
  submitQuestion(
    { withTenant: s.deps.withTenant, boss: null },
    { orgId: s.orgId, userId: s.userId, connectionId: s.connectionId, text, channel: "web", model: "mock", ...more },
  );
const run = (model: MockLanguageModelV4, runId: string) =>
  runAttempt(deps(model), { orgId: s.orgId, runId }, { workerId: "test" }, analyst);
const outcomeOf = async (runId: string) =>
  (
    await s.t.owner<{ outcome: { kind: string } & Record<string, unknown> }[]>`
    select outcome from app.run where id = ${runId}`
  )[0]?.outcome;

/** The text of the last tool result the model was shown. */
const lastResult = (prompt: Prompt | undefined) => {
  for (const m of [...(prompt ?? [])].reverse()) {
    if (m.role !== "tool") continue;
    const p = m.content.at(-1);
    if (p?.type === "tool-result" && p.output.type === "json") return JSON.stringify(p.output.value);
  }
  return "";
};

/** The base the last dashboard_save or dashboard_open gave, as the model passes it back. */
const baseIn = (prompt: Prompt) => /"base":"([^"]+)"/.exec(lastResult(prompt))?.[1] ?? "";

const answered = (markdown: string) =>
  step(call("answer", { status: "answered", markdown, interpretation: [], caveats: [] }));

const PLAN = {
  plan: {
    title: "Accounts",
    purpose: "How many accounts sign up and where, for the weekly growth review",
    datasets: ["accounts"],
    filters: [{ id: "f_period", kind: "period", label: "Period" }],
    pages: [
      {
        id: "p_overview",
        title: "Overview",
        sections: [
          { id: "s_count", title: "New accounts", detail: "this period against the one before" },
          { id: "s_list", title: "Accounts", detail: "every account, newest first" },
          { id: "s_card", title: "Account", detail: "the account picked in the list" },
        ],
      },
    ],
  },
};

/** An App's manifest (version 2): its queries and filters; its screens are its code. */
const definition = (dataset = "accounts") => ({
  version: 2,
  title: "Accounts",
  description: "How many accounts sign up and where.",
  filters: { f_period: { kind: "period", label: "Period", default: "last_12_months" } },
  queries: {
    q_count: {
      source: { connection: s.connectionId, dataset },
      measures: { accounts: ["count"] },
      filters: { f_period: "created_at" },
      compare: "previous_period",
      drill: "q_list",
    },
    q_list: {
      source: { connection: s.connectionId, dataset: "accounts" },
      select: ["id", "name", "country", "created_at"],
      sort: ["-created_at"],
      filters: { f_period: "created_at" },
      key: "id",
    },
  },
});

/** The App's page: the count, and the list with the account picked. */
const APP = `import { useState } from "react";
import { DataGrid, useQuery, Value } from "@opendash/app";

export default function App() {
  const count = useQuery("q_count");
  const [picked] = useState<string | null>(null);
  return (
    <main className="grid gap-4 p-4">
      <p className="text-sm">New accounts <Value of={count.status === "ok" ? count.cell(0, "accounts") : null} /></p>
      <DataGrid query="q_list" />
      <p className="text-sm text-muted">{picked ?? "Pick an account in the list."}</p>
    </main>
  );
}
`;

beforeAll(async () => {
  s = await learnedSource();
  const ctx = { orgId: s.orgId, userId: s.userId };
  await s.tenant((tx) =>
    installDefinitions(tx, ctx, s.connectionId, demoPack("postgres"), { status: "proposed", source: "pack" }),
  );
  await checkDefinitions(s.deps, { orgId: s.orgId, connectionId: s.connectionId }, { now: NOW });
  const list = await s.tenant((tx) => listDefinitions(tx, s.orgId, { connectionId: s.connectionId }));
  await s.tenant((tx) =>
    verifyDefinitions(
      tx,
      ctx,
      list.map((d) => d.id),
    ),
  );
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("the analyst builds dashboards", () => {
  // Wrapped up before any plan (its failed queries; a person's run is never wrapped up for its calls or time: it pauses).
  it("asked for one and wrapped up before a plan, it's told to show the plan, and does", async () => {
    const q = await ask("Build me a dashboard of new accounts and everything about them.");
    const probe = (n: number) => call("sql_query", { title: `Probe ${n}`, sql: `select ${n} as n` });
    const { model, prompts } = scripted([step(probe(1), probe(2), probe(3)), step(call("dashboard_plan", PLAN))]);
    const result = await runAttempt(
      deps(model),
      { orgId: s.orgId, runId: q.runId },
      { workerId: "test", limits: { maxFailedQueries: 0 } },
      analyst,
    );
    expect(result?.status).toBe("succeeded");
    expect(JSON.stringify(prompts.at(-1))).toContain("no plan shown yet: show one now with dashboard_plan");
    expect(await outcomeOf(q.runId)).toMatchObject({ kind: "dashboard_plan", title: "Accounts" });
  });

  it("plans one when asked: the skill, what a dashboard here can read, and a plan that ends its turn", async () => {
    const q = await ask("Build me a dashboard of new accounts: how many, and the list.");
    threadId = q.threadId;
    const { model, prompts, tools } = scripted([step(call("dashboard_plan", PLAN))]);
    expect((await run(model, q.runId))?.status).toBe("succeeded");
    expect(systemOf(prompts[0])).toContain("build-an-app");
    // The taste and the parts' API are read when needed, not sent with every call.
    expect(systemOf(prompts[0])).toContain("/skills/opendash/app-design/SKILL.md");
    expect(systemOf(prompts[0])).toContain("/skills/opendash/react-app-craft/SKILL.md");
    expect(systemOf(prompts[0])).not.toContain("useNamedQuery");
    expect(systemOf(prompts[0])).toMatch(/- accounts \(key: id\)/);
    expect(tools[0]).toEqual(expect.arrayContaining(["dashboard_plan", "dashboard_save", "dashboard_open", "answer"]));
    expect(tools[0]).not.toContain("dashboard_publish");
    expect(await outcomeOf(q.runId)).toMatchObject({
      kind: "dashboard_plan",
      dashboardId: null,
      title: "Accounts",
      datasets: ["accounts"],
      filters: [{ id: "f_period", kind: "period", label: "Period" }],
      pages: [{ id: "p_overview", title: "Overview", sections: [{ id: "s_count", kind: "custom" }, {}, {}] }],
    });
    // Nothing is made before they say so.
    const [made] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.dashboard where thread_id = ${threadId}`;
    expect(made?.n).toBe(0);
  });

  it("refuses a plan on a dataset the source doesn't have", async () => {
    const q = await ask("Plan a dashboard of payroll", { threadId });
    const { model, prompts } = scripted([
      step(call("dashboard_plan", { plan: { ...PLAN.plan, datasets: ["payroll"] } })),
      answered("This source has no payroll data, so there's no dashboard to plan for it."),
    ]);
    expect((await run(model, q.runId))?.status).toBe("succeeded");
    expect(lastResult(prompts[1])).toMatch(/"accepted":false.*no dataset or table payroll/);
    expect(await outcomeOf(q.runId)).toMatchObject({ kind: "answer" });
  });

  it("builds it on Build it: a refused manifest keeps nothing published, then the manifest, then its page", async () => {
    const q = await ask("Build it", { threadId });
    let firstRevision = "";
    const { model, prompts } = scripted([
      step(call("dashboard_save", { definition: definition("payroll") })),
      step(call("dashboard_save", { definition: definition() })),
      async (prompt) => {
        const [d] = await s.t.owner<{ id: string; revision: string }[]>`
          select d.id, r.revision from app.dashboard d join app.dashboard_draft r on r.dashboard_id = d.id
          where d.thread_id = ${threadId}`;
        dashboardId = d?.id ?? "";
        firstRevision = d?.revision ?? "";
        return step(
          call("dashboard_save", {
            dashboard_id: dashboardId,
            base: baseIn(prompt),
            definition: definition(),
            files: { "/App.tsx": APP },
          }),
        );
      },
      answered(
        "Accounts is ready as a draft: new accounts against the period before, the list, and the account picked.",
      ),
    ]);
    expect((await run(model, q.runId))?.status).toBe("succeeded");
    expect(lastResult(prompts[1])).toMatch(/nothing was published to the page.*payroll/);
    expect(lastResult(prompts[2])).toContain('"saved":"draft"');
    expect(lastResult(prompts[3])).toContain('"saved":"draft"');
    expect(await outcomeOf(q.runId)).toMatchObject({ kind: "answer", status: "answered" });

    // Its owner's draft, with the App's bundle; no version until they publish it.
    const actor = { orgId: s.orgId, userId: s.userId };
    const view = await s.tenant((tx) => dashboards.getDashboard(tx, actor, dashboardId));
    expect(view).toMatchObject({ title: "Accounts", threadId, currentVersion: 0, version: null });
    expect(view?.draft?.bundleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(view?.draft?.revision).not.toBe(firstRevision);
    // Publishing is the person's press.
    const published = await s.tenant((tx) =>
      dashboards.publishDraft(tx, actor, dashboardId, { revision: view?.draft?.revision ?? "" }),
    );
    expect(published.version).toBe(1);
  });

  it("changes it on what it opened: never a second of its title, never over a change made since", async () => {
    const q = await ask("Call the list section All accounts", { threadId });
    const next = definition();
    const renamed = { ...next, description: "All accounts, newest first." };
    let stale = "";
    const { model, prompts, tools } = scripted([
      // Without its id: refused, never a second "Accounts".
      step(call("dashboard_save", { definition: renamed })),
      step(call("dashboard_open", { dashboard_id: dashboardId })),
      async (prompt) => {
        stale = baseIn(prompt);
        // A change saved on it first (a parallel save, a Restore, the person's own), then one on what was opened before.
        return step(
          call("dashboard_save", {
            dashboard_id: dashboardId,
            base: stale,
            definition: { ...next, description: "New accounts, for the growth review." },
          }),
        );
      },
      async () => step(call("dashboard_save", { dashboard_id: dashboardId, base: stale, definition: renamed })),
      step(call("dashboard_open", { dashboard_id: dashboardId })),
      async (prompt) =>
        step(call("dashboard_save", { dashboard_id: dashboardId, base: baseIn(prompt), definition: renamed })),
      answered("The list is called All accounts in the draft now."),
    ]);
    expect((await run(model, q.runId))?.status).toBe("succeeded");
    // No word of a dashboard in the question: the conversation built one, so it keeps the tools.
    expect(tools[0]).toContain("dashboard_save");
    expect(lastResult(prompts[1])).toMatch(new RegExp(`already has .*Accounts.* \\(dashboard_id ${dashboardId}\\)`));
    expect(lastResult(prompts[3])).toContain('"saved":"draft"');
    expect(lastResult(prompts[4])).toMatch(/It changed since this change began|saved again since this change began/);
    expect(lastResult(prompts[6])).toContain('"saved":"draft"');
    const [n] = await s.t.owner<
      { n: number }[]
    >`select count(*)::int as n from app.dashboard where thread_id = ${threadId}`;
    expect(n?.n).toBe(1);
    const copy = await s.tenant((tx) => dashboards.workingCopy(tx, { orgId: s.orgId, userId: s.userId }, dashboardId));
    expect(JSON.stringify(copy?.definition)).toContain("All accounts");
    expect(copy?.baseVersion).toBe(1);
  });

  it("changes a title and a line of a part by path and edit, never sending either whole", async () => {
    const q = await ask("Call the list New this period, and make the card say pick one to see it", { threadId });
    let opened = "";
    const { model, prompts } = scripted([
      step(call("dashboard_open", { dashboard_id: dashboardId })),
      async (prompt) => {
        opened = baseIn(prompt);
        return step(
          call("dashboard_save", {
            dashboard_id: dashboardId,
            base: opened,
            edits: [{ file: "/App.tsx", old: "Pick a customer", new: "x" }],
          }),
        );
      },
      async () =>
        step(
          call("dashboard_save", {
            dashboard_id: dashboardId,
            base: opened,
            set: [{ path: "description", value: "New this period" }],
            edits: [
              {
                file: "/App.tsx",
                old: "Pick an account in the list.",
                new: "Pick an account to see it here.",
              },
            ],
          }),
        ),
      answered("The list is New this period, and the card says to pick one."),
    ]);
    expect((await run(model, q.runId))?.status).toBe("succeeded");
    // An edit whose old text isn't there is refused, saying how to find it.
    expect(lastResult(prompts[2])).toMatch(/doesn't contain that old text exactly/);
    expect(lastResult(prompts[3])).toContain('"saved":"draft"');
    const after = await s.tenant((tx) => dashboards.workingCopy(tx, { orgId: s.orgId, userId: s.userId }, dashboardId));
    expect(JSON.stringify(after?.definition)).toContain("New this period");
    expect((after?.files ?? {})["/App.tsx"]).toContain("Pick an account to see it here.");
  });

  it("neither saves nor keeps work past an App's size, so failed saves never pile up", async () => {
    const q = await ask("Add six long panels", { threadId });
    const big = Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [`/Panel${i}.tsx`, `// ${"x".repeat(55_000)}`]));
    const { model, prompts } = scripted([
      step(call("dashboard_open", { dashboard_id: dashboardId })),
      async (prompt) => step(call("dashboard_save", { dashboard_id: dashboardId, base: baseIn(prompt), files: big })),
      answered("It's too big to save as it is."),
    ]);
    expect((await run(model, q.runId))?.status).toBe("succeeded");
    expect(lastResult(prompts[2])).toMatch(/at most 300,000 characters together.*Nothing was saved or kept/);
    const after = await s.tenant((tx) => dashboards.workingCopy(tx, { orgId: s.orgId, userId: s.userId }, dashboardId));
    expect(after?.work).toBeNull();
    expect(Object.keys(after?.files ?? {})).not.toContain("/Panel1.tsx");
  });

  it("grows this conversation's App by changes: a plan for a second one needs them to have asked for it", async () => {
    const q = await ask("Build that into the dashboard too", { threadId });
    const second = { plan: { ...PLAN.plan, title: "Accounts, again" } };
    const { model, prompts } = scripted([
      step(call("dashboard_plan", second)),
      step(call("dashboard_plan", { ...second, separate: true })),
    ]);
    expect((await run(model, q.runId))?.status).toBe("succeeded");
    expect(lastResult(prompts[1])).toMatch(/already has .*Accounts.*plan with its dashboard_id/);
    expect(await outcomeOf(q.runId)).toMatchObject({ kind: "dashboard_plan", title: "Accounts, again" });
  });

  it("shows another reader of the conversation only the structure of a run that worked on the draft", async () => {
    const [build] = await s.t.owner<{ id: string }[]>`
      select r.id from app.run r join app.message m on m.id = r.input_message_id
      where r.thread_id = ${threadId} and m.text = 'Build it'`;
    await s.t.owner`update app.thread set visibility = 'org' where id = ${threadId}`;
    const other = { id: "01a1b7d0-0000-7000-8000-000000000001" };
    const read = (userId: string) => runEvents(s.deps, { orgId: s.orgId, userId }, build?.id ?? "");
    const started = (events: { type: string; data: Record<string, unknown> }[]) =>
      events.filter((e) => e.type === "tool_started" && e.data.tool === "dashboard_save");
    // Its asker sees what was saved; another reader, which tool ran and no more.
    expect(JSON.stringify(started(await read(s.userId)))).toContain("/App.tsx");
    const theirs = started(await read(other.id));
    expect(theirs.length).toBeGreaterThan(0);
    expect(JSON.stringify(theirs)).not.toContain("/App.tsx");
    // So is a run given the tools that saved nothing (the plan), and one after it in the conversation: decided by what
    // the run was given before its first model call, never by a call recorded later.
    const runs = await s.t.owner<{ id: string }[]>`
      select r.id from app.run r where r.thread_id = ${threadId} order by r.queued_at`;
    for (const r of runs) {
      const events = await runEvents(s.deps, { orgId: s.orgId, userId: other.id }, r.id);
      const inputs = events.filter((e) => e.type === "tool_started").map((e) => e.data.input);
      expect(inputs.every((i) => i === undefined)).toBe(true);
    }
    expect(runs.length).toBeGreaterThan(2);
    await s.t.owner`update app.thread set visibility = 'private' where id = ${threadId}`;
  });

  it("makes one dashboard when two saves of it run at once", async () => {
    const q = await ask("Build me a dashboard of plans");
    const plans = { ...definition(), title: "Plans" };
    const { model, prompts } = scripted([
      step(call("dashboard_save", { definition: plans }), call("dashboard_save", { definition: plans })),
      answered("Plans is ready as a draft."),
    ]);
    expect((await run(model, q.runId))?.status).toBe("succeeded");
    const [n] = await s.t.owner<
      { n: number }[]
    >`select count(*)::int as n from app.dashboard where thread_id = ${q.threadId}`;
    expect(n?.n).toBe(1);
    expect(JSON.stringify(prompts[1])).toMatch(/already has .*Plans/);
  });

  it("doesn't say a dashboard is ready when none of its saves passed", async () => {
    const q = await ask("Build me a dashboard of signups");
    const bad = { ...definition("signups"), title: "Signups" };
    const { model, prompts } = scripted([
      step(call("dashboard_save", { definition: bad })),
      answered("Signups is ready as a draft."),
      step(
        call("answer", {
          status: "cannot_answer",
          markdown: "Signups isn't built: this source has no signups dataset.",
          interpretation: [],
          caveats: [],
        }),
      ),
    ]);
    expect((await run(model, q.runId))?.status).toBe("succeeded");
    expect(lastResult(prompts[2])).toContain("No save of the dashboard passed in this run");
    expect(await outcomeOf(q.runId)).toMatchObject({ status: "cannot_answer" });
  });

  it("can't change a dashboard from another conversation", async () => {
    const q = await ask("Rename my accounts dashboard to Sign-ups");
    const { model, prompts } = scripted([
      step(call("dashboard_save", { dashboard_id: dashboardId, definition: { ...definition(), title: "Sign-ups" } })),
      answered("That dashboard is changed in the conversation it was built in."),
    ]);
    expect((await run(model, q.runId))?.status).toBe("succeeded");
    expect(lastResult(prompts[1])).toContain("isn't a dashboard you can change here");
    const view = await s.tenant((tx) => dashboards.getDashboard(tx, { orgId: s.orgId, userId: s.userId }, dashboardId));
    expect(view?.title).toBe("Accounts");
  });

  it("changes one of theirs from another conversation once they attach it, and is told what it shows", async () => {
    // No word of a dashboard: attaching one (@, or the panel beside it) is enough.
    const q = await ask("Call the count Sign-ups", { attachments: [{ kind: "dashboard", id: dashboardId }] });
    const { model, prompts, tools } = scripted([
      step(call("dashboard_open", {})),
      step(call("dashboard_open", { dashboard_id: dashboardId })),
      async (prompt) => {
        const opened = JSON.parse(lastResult(prompt)) as { definition: ReturnType<typeof definition> };
        const next = { ...opened.definition, description: "Sign-ups, and where they come from." };
        return step(call("dashboard_save", { dashboard_id: dashboardId, base: baseIn(prompt), definition: next }));
      },
      answered("The count is called Sign-ups in the draft."),
    ]);
    expect((await run(model, q.runId))?.status).toBe("succeeded");
    expect(tools[0]).toContain("dashboard_save");
    const told = JSON.stringify(prompts[0]);
    expect(told).toContain("attached dashboard: Accounts");
    expect(told).toContain(`dashboard_id ${dashboardId}`);
    expect(told).toContain("An App: its screens are its own code");
    expect(told).toContain("q_count: accounts");
    // Listed as one of this conversation's, opened, and changed here.
    expect(lastResult(prompts[1])).toContain(dashboardId);
    expect(lastResult(prompts[3])).toContain('"saved":"draft"');
    const copy = await s.tenant((tx) => dashboards.workingCopy(tx, { orgId: s.orgId, userId: s.userId }, dashboardId));
    expect(JSON.stringify(copy?.definition)).toContain("Sign-ups");
    // It stays the dashboard of the conversation it was built in.
    expect(copy?.threadId).toBe(threadId);
    // Given its owner's draft: the run is marked, so another reader of this conversation sees its structure only.
    const [prompt] = await s.t.owner<
      { attached: unknown }[]
    >`select prompt->'attached' as attached from app.run where id = ${q.runId}`;
    expect(prompt?.attached).toEqual(
      expect.arrayContaining([{ kind: "dashboard", id: dashboardId, version: expect.any(Number), draft: true }]),
    );
  });

  it("changes the piece of an App its owner selected, from another conversation, given the lines around it", async () => {
    const [draft] = await s.t.owner<{ revision: string; source: string }[]>`
      select revision, parts->>'/App.tsx' as source from app.dashboard_draft where dashboard_id = ${dashboardId}`;
    const line = (draft?.source ?? "").split("\n").findIndex((l) => l.includes('useQuery("q_count")')) + 1;
    expect(line).toBeGreaterThan(0);
    const selected = {
      kind: "app_element" as const,
      id: crypto.randomUUID(),
      dashboardId,
      revision: draft?.revision ?? "",
      file: "/App.tsx",
      line,
      column: 3,
      tag: "div",
      text: "Sign-ups 1,204",
    };
    // Only the piece: no dashboard attached, no word of one.
    const q = await submitQuestion(
      { withTenant: s.deps.withTenant, boss: null },
      {
        orgId: s.orgId,
        userId: s.userId,
        connectionId: s.connectionId,
        text: "Say what period this counts",
        channel: "web",
        model: "mock",
        attachments: [selected],
      },
    );
    const { model, prompts, tools } = scripted([
      step(call("dashboard_open", { dashboard_id: dashboardId })),
      async (prompt) => {
        const opened = JSON.parse(lastResult(prompt)) as { definition: ReturnType<typeof definition> };
        const next = { ...opened.definition, description: "Sign-ups this period." };
        return step(call("dashboard_save", { dashboard_id: dashboardId, base: baseIn(prompt), definition: next }));
      },
      answered("The count says its period in the draft."),
    ]);
    expect((await run(model, q.runId))?.status).toBe("succeeded");
    expect(tools[0]).toContain("dashboard_save");
    const told = JSON.stringify(prompts[0]);
    expect(told).toContain(`piece of the App they selected: /App.tsx:${line}`);
    expect(told).toContain(`${line} >   const count = useQuery(\\"q_count\\");`);
    expect(told).toContain("The person selected this in their App");
    expect(told).toContain(`dashboard_id ${dashboardId}`);
    // Changeable here because the person selected a piece of it.
    expect(lastResult(prompts[2])).toContain('"saved":"draft"');
    // The run worked on the owner's code: marked, so another reader of the conversation sees its structure only.
    const [recorded] = await s.t.owner<
      { attached: unknown }[]
    >`select prompt->'attached' as attached from app.run where id = ${q.runId}`;
    expect(recorded?.attached).toEqual(expect.arrayContaining([{ kind: "app_element", id: selected.id }]));
    await s.t.owner`update app.thread set visibility = 'org' where id = ${q.threadId}`;
    const events = await runEvents(s.deps, { orgId: s.orgId, userId: "01a1b7d0-0000-7000-8000-000000000002" }, q.runId);
    const inputs = events.filter((e) => e.type === "tool_started").map((e) => e.data.input);
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every((i) => i === undefined)).toBe(true);
    await s.t.owner`update app.thread set visibility = 'private' where id = ${q.threadId}`;
  });

  it("changes one shared with them to edit from their own conversation once they attach it, never one shared to view", async () => {
    const owner = { orgId: s.orgId, userId: s.userId };
    const carol = uuidv7();
    const dave = uuidv7();
    for (const [id, email] of [
      [carol, "carol@acme.example"],
      [dave, "dave@acme.example"],
    ] as const) {
      await s.t.owner`insert into auth.user (id, name, email, email_verified) values (${id}, ${email}, ${email}, true)`;
      await s.t.owner`insert into auth.member (id, organization_id, user_id, role, created_at)
        values (${uuidv7()}, ${s.orgId}, ${id}, 'member', now())`;
    }
    await s.tenant((tx) => dashboards.shareDashboard(tx, owner, dashboardId, { userId: carol, role: "edit" }));
    await s.tenant((tx) => dashboards.shareDashboard(tx, owner, dashboardId, { userId: dave, role: "view" }));
    const askAs = (userId: string, text: string) =>
      submitQuestion(
        { withTenant: s.deps.withTenant, boss: null },
        {
          orgId: s.orgId,
          userId,
          connectionId: s.connectionId,
          text,
          channel: "web",
          model: "mock",
          attachments: [{ kind: "dashboard", id: dashboardId }],
        },
      );

    // Carol, an editor: her conversation lists it, opens it and saves her change to the draft its owner publishes.
    const q = await askAs(carol, "Say what the count is for");
    const { model, prompts } = scripted([
      step(call("dashboard_open", {})),
      step(call("dashboard_open", { dashboard_id: dashboardId })),
      async (prompt) => {
        const opened = JSON.parse(lastResult(prompt)) as { definition: ReturnType<typeof definition> };
        const next = { ...opened.definition, description: "Sign-ups, as the growth review reads them." };
        return step(call("dashboard_save", { dashboard_id: dashboardId, base: baseIn(prompt), definition: next }));
      },
      answered("The draft says what the count is for; its owner publishes it."),
    ]);
    expect((await run(model, q.runId))?.status).toBe("succeeded");
    expect(JSON.stringify(prompts[0])).toContain("It's shared with them to edit (its owner publishes it)");
    expect(lastResult(prompts[1])).toContain(dashboardId);
    expect(lastResult(prompts[3])).toContain('"saved":"draft"');
    const copy = await s.tenant((tx) => dashboards.workingCopy(tx, owner, dashboardId));
    expect(JSON.stringify(copy?.definition)).toContain("as the growth review reads them");

    // Dave, a viewer: told it isn't his to change, and a save of it is refused.
    const v = await askAs(dave, "Rename it to Growth");
    const seen = scripted([
      step(call("dashboard_save", { dashboard_id: dashboardId, definition: { ...definition(), title: "Growth" } })),
      answered("Only its owner and its editors change it."),
    ]);
    expect((await run(seen.model, v.runId))?.status).toBe("succeeded");
    expect(JSON.stringify(seen.prompts[0])).toContain("It isn't theirs");
    expect(lastResult(seen.prompts[1])).toContain("isn't a dashboard you can change here");
    expect(
      JSON.stringify((await s.tenant((tx) => dashboards.workingCopy(tx, owner, dashboardId)))?.definition),
    ).not.toContain("Growth");

    // Her share removed: attaching it again is refused, and the conversation she attached it to can't change it.
    await s.tenant((tx) => dashboards.shareDashboard(tx, owner, dashboardId, { userId: carol, role: null }));
    await expect(askAs(carol, "Say it again")).rejects.toThrow(/isn't shared with you/);
    const again = await submitQuestion(
      { withTenant: s.deps.withTenant, boss: null },
      {
        orgId: s.orgId,
        userId: carol,
        connectionId: s.connectionId,
        text: "Say it again",
        channel: "web",
        model: "mock",
        threadId: q.threadId,
      },
    );
    const gone = scripted([
      step(call("dashboard_open", { dashboard_id: dashboardId })),
      answered("It isn't shared with you any more."),
    ]);
    expect((await run(gone.model, again.runId))?.status).toBe("succeeded");
    expect(lastResult(gone.prompts[1])).toContain("isn't a dashboard you can change here");
  });

  it("saves a dataset of its own from the SQL it wrote: run through the gateway, typed, refused when it's wrong", async () => {
    const thread = (await ask("A dashboard of sign-ups by country from the accounts table")).threadId;
    const q = await ask("Build it", { threadId: thread });
    const own = (columns: { name: string; type: string }[]) => ({
      version: 2,
      title: "Sign-ups by country",
      datasets: {
        t_signups: {
          connection: s.connectionId,
          title: "Sign-ups",
          sql: "select id, country from public.accounts where not is_test",
          columns,
        },
      },
      queries: {
        q_by_country: {
          source: { connection: s.connectionId, dataset: "t_signups" },
          measures: { n: ["count"] },
          by: ["country"],
          filters: {},
        },
      },
    });
    const { model, prompts } = scripted([
      // A column its SQL doesn't return: refused in the gateway's words, nothing saved.
      step(
        call("dashboard_save", {
          definition: own([
            { name: "id", type: "number" },
            { name: "region", type: "string" },
          ]),
        }),
      ),
      // Declared as text, returned as a number: saved, typed as what came back.
      step(
        call("dashboard_save", {
          definition: own([
            { name: "id", type: "string" },
            { name: "country", type: "string" },
          ]),
        }),
      ),
      answered("Sign-ups by country is ready as a draft, from the accounts table."),
    ]);
    expect((await run(model, q.runId))?.status).toBe("succeeded");
    expect(lastResult(prompts[1])).toMatch(/nothing was published to the page.*datasets\.t_signups\.sql/);
    expect(lastResult(prompts[2])).toContain('"saved":"draft"');
    const [d] = await s.t.owner<
      { definition: { datasets: Record<string, { columns: { name: string; type: string }[] }> } }[]
    >`
      select r.definition from app.dashboard d join app.dashboard_draft r on r.dashboard_id = d.id
      where d.thread_id = ${thread}`;
    expect(d?.definition.datasets.t_signups?.columns).toEqual([
      { name: "id", type: "number" },
      { name: "country", type: "string" },
    ]);
    // The gateway ran it, as the run's: in the run's query history.
    const [ran] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.query_run where requester_id = ${q.runId} and title like 'Dashboard dataset%'`;
    expect(ran?.n).toBe(2);
  });

  it("keeps an App's work when its save fails, so the next save sends only the fix", async () => {
    const thread = (await ask("A desk App for accounts")).threadId;
    const planned = await ask("Plan it", { threadId: thread });
    const { model: planner } = scripted([step(call("dashboard_plan", { plan: { ...PLAN.plan, title: "Desk" } }))]);
    expect((await run(planner, planned.runId))?.status).toBe("succeeded");
    const built = await ask("Build it", { threadId: thread });
    const def = definition();
    const { filters: _f, compare: _c, drill: _d, ...count } = def.queries.q_count as Record<string, unknown>;
    const manifest = { version: 2, title: "Desk", queries: { q_count: count } };
    const app = (value: string) =>
      `import { useQuery } from "@opendash/app";\nexport default function App() {\n  const q = useQuery("q_count");\n  const n: number = ${value};\n  return <main className="p-4">{q.status} {n}</main>;\n}\n`;
    let made = "";
    const { model, prompts } = scripted([
      step(call("dashboard_start", {})),
      async (prompt) => {
        made = /"dashboard_id":"([^"]+)"/.exec(lastResult(prompt))?.[1] ?? "";
        return step(
          call("dashboard_save", {
            dashboard_id: made,
            base: baseIn(prompt),
            definition: manifest,
            files: { "/App.tsx": app('"one"') },
          }),
        );
      },
      // Only the fix: no manifest, no file written again.
      async () =>
        step(
          call("dashboard_save", {
            dashboard_id: made,
            base: baseIn(prompts[1] as Prompt),
            edits: [{ file: "/App.tsx", old: 'const n: number = "one";', new: "const n: number = 1;" }],
          }),
        ),
      answered("Desk is ready as a draft."),
    ]);
    expect((await run(model, built.runId))?.status).toBe("succeeded");
    expect(lastResult(prompts[2])).toMatch(/kept as you wrote them/);
    expect(lastResult(prompts[3])).toContain('"saved":"draft"');
    const after = await s.tenant((tx) => dashboards.workingCopy(tx, { orgId: s.orgId, userId: s.userId }, made));
    expect(after?.files["/App.tsx"]).toContain("const n: number = 1;");
    // Built now: nothing kept any more.
    expect(after?.work).toBeNull();

    // A save on the base from before that build (a stale view) is refused before anything is built or kept: its work
    // would otherwise open next as if it were made on the draft there now.
    const stale = await ask("Change it again", { threadId: thread });
    const { model: late, prompts: latePrompts } = scripted([
      step(
        call("dashboard_save", {
          dashboard_id: made,
          base: baseIn(prompts[1] as Prompt),
          files: { "/App.tsx": app('"stale"') },
        }),
      ),
      answered("It changed meanwhile."),
    ]);
    expect((await run(late, stale.runId))?.status).toBe("succeeded");
    expect(lastResult(latePrompts[1])).toMatch(/It changed since this change began/);
    const still = await s.tenant((tx) => dashboards.workingCopy(tx, { orgId: s.orgId, userId: s.userId }, made));
    expect(still?.work).toBeNull();
    expect(still?.files["/App.tsx"]).toContain("const n: number = 1;");
  });

  it("isn't given the tools or the skill in a conversation about anything else", async () => {
    const q = await ask("Which countries do we sell in?");
    const { model, prompts, tools } = scripted([
      step(call("clarify", { questions: [{ question: "Which period?", options: ["This year", "All time"] }] })),
    ]);
    expect((await run(model, q.runId))?.status).toBe("succeeded");
    expect(tools[0]).not.toContain("dashboard_save");
    expect(systemOf(prompts[0])).not.toContain("build-an-app");
  });
});
