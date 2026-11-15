// The knowledge folder, offline: the analyst finds a table, a metric and a guide with ls, read and grep, each
// item it reads recorded with its version, and a path outside the tree, a draft and a source it can't read all answer
// "nothing at". The prompt keeps only an index of the tables, within its budget however big the source.
import {
  approveContext,
  callDetail,
  checkDefinitions,
  demoPack,
  installDefinitions,
  listDefinitions,
  saveGuide,
  saveTerm,
  submitQuestion,
  verifyDefinitions,
} from "@opendash/core";
import { type LearnedSource, learnedSource } from "@opendash/core/testing";
import type { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentDeps, runAttempt } from "../src";
import {
  type CatalogTable,
  folderOf,
  TABLES_INDEX_CHARS,
  tablesFolder,
  tablesForPrompt,
} from "../src/instructions/catalog";
import { ls, read } from "../src/tools/files";
import type { RunSource, ToolContext } from "../src/tools/types";
import { call, type Prompt, scripted, step } from "./helpers/scripted";

let s: LearnedSource;
let folder: string;
let metricPath: string;
let guidePath: string;
let draftPath: string;

beforeAll(async () => {
  s = await learnedSource();
  const ctx = { orgId: s.orgId, userId: s.userId };
  await s.tenant((tx) =>
    installDefinitions(tx, ctx, s.connectionId, demoPack("postgres"), { status: "proposed", source: "pack" }),
  );
  await checkDefinitions(s.deps, { orgId: s.orgId, connectionId: s.connectionId });
  const list = await s.tenant((tx) => listDefinitions(tx, s.orgId, { connectionId: s.connectionId }));
  await s.tenant((tx) =>
    verifyDefinitions(
      tx,
      ctx,
      list.map((d) => d.id),
    ),
  );
  const guide = await s.tenant((tx) =>
    saveGuide(tx, ctx, { title: "Refund policy", body: "Refunds within 30 days are full refunds." }),
  );
  await s.tenant((tx) => approveContext(tx, ctx, [{ id: guide.id, version: 1 }]));
  const draft = await s.tenant((tx) =>
    saveGuide(tx, ctx, { title: "Draft rule", body: "Not approved: refunds never count, never read this." }),
  );
  const [source] = await s.t.owner<{ name: string }[]>`select name from app.connection where id = ${s.connectionId}`;
  folder = `/sources/${source?.name}`;
  const [metric] = await s.t.owner<{ slug: string }[]>`
    select slug from app.context_item where connection_id = ${s.connectionId} and kind = 'metric' order by slug limit 1`;
  metricPath = `${folder}/metrics/${metric?.slug}.yaml`;
  const paths = await s.t.owner<{ id: string; path: string }[]>`
    select id, path from app.context_item where id in (${guide.id}, ${draft.id})`;
  guidePath = paths.find((p) => p.id === guide.id)?.path as string;
  draftPath = paths.find((p) => p.id === draft.id)?.path as string;
}, 300_000);

afterAll(async () => {
  await s?.close();
});

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
});

const ask = (text: string, threadId?: string) =>
  submitQuestion(
    { withTenant: s.deps.withTenant, boss: null },
    {
      orgId: s.orgId,
      userId: s.userId,
      connectionId: s.connectionId,
      text,
      channel: "eval",
      model: "mock",
      ...(threadId ? { threadId } : {}),
    },
  );

const table = (i: number, extra: Partial<CatalogTable> = {}): CatalogTable => ({
  schema: "warehouse",
  name: `events_${String(i).padStart(4, "0")}`,
  kind: "table",
  comment: "Product events, one row per event, as the tracking pipeline writes them each night",
  rows: 1_000 * i,
  freshness: null,
  primaryKey: [],
  queries: 0,
  profiled: true,
  build: null,
  models: [],
  columns: [],
  ...extra,
});

/** Each tool result the model was shown, in order: its tool and its value. */
const results = (prompt: Prompt) =>
  prompt.flatMap((m) =>
    m.role === "tool"
      ? m.content.flatMap((p) =>
          p.type === "tool-result" && p.output.type === "json"
            ? [{ tool: p.toolName, value: p.output.value as Record<string, unknown> }]
            : [],
        )
      : [],
  );
const clarifies = () =>
  step(call("clarify", { questions: [{ question: "Which month?", options: ["September", "October"] }] }));

describe("the knowledge folder", () => {
  it("reaches a table, a metric and a guide through ls, read and grep, recording each item it reads", async () => {
    const q = await ask("How do refunds count toward MRR?");
    const { model, prompts } = scripted([
      step(
        call("ls", { path: "/" }),
        call("ls", { path: `${folder}/tables` }),
        call("ls", { path: `${folder}/metrics` }),
      ),
      step(
        call("read", { path: `${folder}/tables/public.accounts.md` }),
        call("read", { path: metricPath }),
        call("read", { path: guidePath }),
        call("grep", { pattern: "refund" }),
      ),
      clarifies(),
    ]);
    await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "t" });
    const [top, tables, metrics, table, metric, guide, found] = results(prompts.at(-1) ?? []).map((r) => r.value);
    expect(top?.entries).toContain("sources/ (1)");
    expect(top?.entries).toContain("guides/ (1)");
    expect(tables?.entries).toContain("public.accounts.md (about");
    expect(String(metrics?.entries)).toContain(metricPath.split("/").pop());
    // A table's file: its columns, with its category columns' common values read from the source now.
    const columns =
      (table?.table as { columns: { name: string; commonValues?: string[] }[] } | undefined)?.columns ?? [];
    expect(columns.find((c) => c.name === "country")?.commonValues).toContain("DE");
    expect(metric?.content).toContain('<context source="verified metric" trust="admin">');
    expect(guide).toMatchObject({ title: "Refund policy", version: 1 });
    expect(guide?.content).toContain("Refunds within 30 days are full refunds.");
    // grep finds the word in the team's definitions and the tables, never the draft.
    expect(found?.matches).toContain(`${guidePath}: Refunds within 30 days are full refunds.`);
    expect(String(found?.matches)).toContain(`${folder}/tables/billing.refunds.md`);
    expect(String(found?.matches)).not.toContain("never read this");
    expect(String(found?.matches)).not.toContain(draftPath);
    // What it read is recorded with its version, as context it found.
    const events = await s.t.owner<{ data: { tool: string; items?: { kind: string; version: number }[] } }[]>`
      select data from app.run_event where run_id = ${q.runId} and type = 'tool_result' and data->>'tool' = 'read'`;
    expect(events.flatMap((e) => e.data.items ?? []).map((i) => i.kind)).toEqual(
      expect.arrayContaining(["metric", "guide"]),
    );
  });

  it("answers alike for a path outside the tree, a draft and a source it can't read", async () => {
    // A source of the organization's this run can't read: disabled, so not one of its sources.
    const archive = await s.addSource("archive_db");
    await s.t.owner`update app.connection set status = 'disabled' where id = ${archive}`;
    const q = await ask("What's in there?");
    const { model, prompts } = scripted([
      step(
        call("read", { path: "/etc/passwd" }),
        call("read", { path: "/sources/../../etc/passwd" }),
        call("read", { path: draftPath }),
        call("ls", { path: "/sources/archive_db" }),
        call("grep", { pattern: "accounts", path: "/sources/archive_db/tables" }),
      ),
      clarifies(),
    ]);
    await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "t" });
    const answered = results(prompts.at(-1) ?? []).map((r) => String(r.value.error ?? ""));
    expect(answered).toHaveLength(5);
    for (const a of answered) expect(a).toMatch(/^Nothing at .*ls \/ shows what's here\.$/);
  });
});

describe("OpenDash's own skills", () => {
  it("serves them in the folder beside the team's, listed in the prompt, fenced as OpenDash's", async () => {
    const q = await ask("Why did MRR drop in September?");
    const { model, prompts } = scripted([
      step(
        call("ls", { path: "/skills" }),
        call("ls", { path: "/skills/opendash" }),
        call("read", { path: "/skills/opendash/investigate-a-change/SKILL.md" }),
        call("grep", { pattern: "accounts" }),
        call("grep", { pattern: "metric_query", path: "/skills/opendash" }),
      ),
      step(
        call("answer", {
          status: "cannot_answer",
          markdown: "Stopping here for this test.",
          interpretation: ["Followed the Investigate a change skill"],
          caveats: [],
        }),
      ),
    ]);
    await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "t" });
    expect(JSON.stringify(prompts[0])).toContain(
      "- Investigate a change (/skills/opendash/investigate-a-change/SKILL.md): Asked why a number changed",
    );
    const [skills, ours, steps, everywhere, inSkills] = results(prompts.at(-1) ?? []).map((r) => r.value);
    expect(skills?.entries).toContain("opendash/");
    expect(ours?.entries).toContain("investigate-a-change/");
    expect(steps?.content).toContain('<skill name="Investigate a change" version="2" source="opendash">');
    expect(steps?.content).toContain("name: investigate-a-change");
    expect(steps?.content).toContain("1. Check the change is real.");
    // grep keeps their examples out of what the organization's data holds, unless it searches the skills.
    expect(String(everywhere?.matches)).not.toContain("/skills/opendash/");
    expect(String(inSkills?.matches)).toContain("/skills/opendash/investigate-a-change/SKILL.md:");
    // A built-in read has no page to link to: the answer's sources don't list it.
    const [run] = await s.t.owner<{ outcome: { context?: { id: string }[] } }[]>`
      select outcome from app.run where id = ${q.runId}`;
    expect(JSON.stringify(run?.outcome.context ?? [])).not.toContain("opendash/");
  });

  it("serves the App references to read, without listing them in every question's skills", async () => {
    const q = await ask("Why did MRR drop in September?");
    const { model, prompts } = scripted([
      step(
        call("ls", { path: "/skills/opendash" }),
        call("read", { path: "/skills/opendash/app-design/SKILL.md" }),
        call("read", { path: "/skills/opendash/react-app-craft/SKILL.md" }),
        call("ls", { path: "/skills/opendash/app-design" }),
        call("read", { path: "/skills/opendash/app-design/anti-slop.md" }),
        call("read", { path: "/skills/opendash/build-an-app/services.md" }),
      ),
      step(
        call("answer", {
          status: "cannot_answer",
          markdown: "Stopping here for this test.",
          interpretation: ["x"],
          caveats: [],
        }),
      ),
    ]);
    await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "t" });
    // The list every question gets is as it was: only the skills an analyst may follow on its own.
    expect(JSON.stringify(prompts[0])).not.toContain("app-design");
    expect(JSON.stringify(prompts[0])).not.toContain("react-app-craft");
    const [ours, design, parts, folder, slop, services] = results(prompts.at(-1) ?? []).map((r) => r.value);
    expect(ours?.entries).toContain("app-design/");
    expect(ours?.entries).toContain("react-app-craft/");
    expect(design?.content).toContain('source="opendash"');
    expect(design?.content).toContain("Whose word wins");
    // Its references beside it, read when the work needs them.
    for (const f of ["layout.md", "data.md", "states.md", "interaction.md", "anti-slop.md", "review.md"]) {
      expect(folder?.entries).toContain(f);
    }
    expect(slop?.content).toContain("What makes an App look generated");
    expect(parts?.content).toContain('declare module "@opendash/app"');
    // build-an-app's own reference, at the path the skill names (it read nothing there before).
    expect(services?.error).toBeUndefined();
    expect(String(services?.content ?? "").length).toBeGreaterThan(200);
  });
});

describe("what a run read, in its outcome", () => {
  it("lists a guide it read as found, and leaves a verified definition to its queries", async () => {
    const q = await ask("Do refunds count toward MRR?");
    const { model } = scripted([
      step(call("read", { path: guidePath }), call("read", { path: metricPath })),
      step(
        call("answer", {
          status: "cannot_answer",
          markdown: "Stopping here for this test.",
          interpretation: [],
          caveats: [],
        }),
      ),
    ]);
    await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "t" });
    const [run] = await s.t.owner<{ outcome: { context?: { kind: string; how: string; title: string }[] } }[]>`
      select outcome from app.run where id = ${q.runId}`;
    expect(run?.outcome.context).toEqual([
      expect.objectContaining({ kind: "guide", title: "Refund policy", how: "search" }),
    ]);
  });
});

describe("a folder past one page", () => {
  /** The tools on a source of `n` tables, as a run would have it (only what ls and read of a source touch). */
  const many = (n: number) => {
    const source = {
      connectionId: "00000000-0000-7000-8000-000000000001",
      name: "big/warehouse",
      dialect: { id: "postgres", name: "PostgreSQL" },
      tables: Array.from({ length: n }, (_, i) => table(i)),
      semantic: null,
    } as never as RunSource;
    return {
      sources: { main: source, others: [], pick: async () => source },
      deps: { withTenant: async () => [] },
      run: { orgId: "00000000-0000-7000-8000-000000000002" },
    } as never as ToolContext;
  };
  const call = { rowId: "r", signal: new AbortController().signal };

  it("lists every table, page by page, and fences every page of a long file", async () => {
    const ctx = many(1_000);
    const folder = `/sources/${folderOf("big/warehouse")}`;
    expect(folder).toBe("/sources/big%2Fwarehouse");
    const first = (await ls.execute({ path: `${folder}/tables` }, ctx, call)).value as Record<string, string>;
    expect(first.more).toBe("600 more: ls it again with offset 400");
    const last = (await ls.execute({ path: `${folder}/tables`, offset: 800 }, ctx, call)).value as Record<
      string,
      string
    >;
    expect(last.more).toBeUndefined();
    expect(last.entries?.split("\n").filter((l) => l.startsWith("warehouse."))).toHaveLength(200);
    // The source's page runs past one read: each page is fenced as data, the second as much as the first.
    const page1 = (await read.execute({ path: `${folder}/README.md` }, ctx, call)).value as Record<string, string>;
    const next = Number(/offset (\d+)/.exec(page1.more ?? "")?.[1]);
    const page2 = (await read.execute({ path: `${folder}/README.md`, offset: next }, ctx, call)).value as Record<
      string,
      string
    >;
    for (const p of [page1, page2]) {
      expect(p.content?.startsWith('<context source="what OpenDash knows" trust="data">')).toBe(true);
      expect(p.content?.endsWith("</context>")).toBe(true);
    }
    // A folder that isn't one answers as nothing at it does.
    expect((await ls.execute({ path: `${folder}/constructor` }, ctx, call)).value).toMatchObject({
      error: expect.stringMatching(/^Nothing at/),
    });
  });
});

describe("the tables in the prompt", () => {
  it("stays within its budget however many tables, the most read first, counting the rest", () => {
    const tables = Array.from({ length: 2_000 }, (_, i) => table(i));
    tables[1_500] = table(1_500, { queries: 42, rows: 5 });
    const index = tablesForPrompt(tables, tablesFolder("warehouse"));
    expect(index.length).toBeLessThanOrEqual(TABLES_INDEX_CHARS + 200);
    const lines = index.split("\n");
    expect(lines[1]).toContain("warehouse.events_1500 (about 5 rows, read by 42 of the team's query runs)");
    expect(lines[2]).toContain("warehouse.events_1999");
    expect(index).toMatch(/…and 1,9\d\d more: ls \/sources\/warehouse\/tables lists them all\./);
  });

  it("fits a source of 99 tables whole, as the warehouses measured do (about 7k characters, no comments)", () => {
    const index = tablesForPrompt(
      Array.from({ length: 99 }, (_, i) =>
        table(i, { comment: null, build: { engine: "ReplacingMergeTree" } as never }),
      ),
      tablesFolder("warehouse"),
    );
    expect(index).not.toContain("more: ls");
    expect(index.split("\n").filter((l) => l.startsWith("warehouse."))).toHaveLength(99);
  });
});

describe("a table's own file", () => {
  it("says which of the team's terms it is, and which it isn't", async () => {
    const who = { orgId: s.orgId, userId: s.userId };
    const term = await s.tenant((tx) =>
      saveTerm(tx, who, {
        body: "term: Paying accounts\nmeans: The accounts with an active subscription.\nmaps_to:\n  column: public.subscriptions.status\n  values: [active]\nnot: [public.accounts]\n",
        connectionId: s.connectionId,
      }),
    );
    await s.tenant((tx) => approveContext(tx, who, [{ id: term.id, version: term.version }]));
    const q = await ask("How many paying accounts do we have?");
    const { model, prompts } = scripted([
      step(
        call("read", { path: `${folder}/tables/public.subscriptions.md` }),
        call("read", { path: `${folder}/tables/public.accounts.md` }),
        call("read", { path: `${folder}/tables/public.plans.md` }),
      ),
      clarifies(),
    ]);
    await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "t" });
    const [right, wrong, other] = results(prompts.at(-1) ?? []).map((r) => r.value);
    expect(String(right?.team_terms)).toContain(
      "Paying accounts (Glossary) means this table where status in ('active').",
    );
    expect(String(wrong?.team_terms)).toContain(
      "Not Paying accounts: Paying accounts means public.subscriptions where status in ('active') (Glossary). Never read it from this table.",
    );
    expect(String(wrong?.team_terms)).toContain('<context source="glossary: public.accounts" trust="admin">');
    // A table no term is about says nothing more.
    expect(other).not.toHaveProperty("team_terms");
  });
});

describe("an earlier result, read back", () => {
  it("gives a conversation's kept rows again, numbered as they were, without running anything", async () => {
    const first = await ask("List the numbers up to 119.");
    const { model: m1 } = scripted([
      step(call("sql_query", { title: "Numbers", sql: "select n, n * 2 as twice from generate_series(0, 119) as n" })),
      step(call("answer", { status: "cannot_answer", markdown: "Stopping here.", interpretation: ["x"], caveats: [] })),
    ]);
    await runAttempt(deps(m1), { orgId: s.orgId, runId: first.runId }, { workerId: "t" });
    const [{ alias } = { alias: "" }] = await s.t.owner<{ alias: string }[]>`
      select q.alias from app.query_run q where q.requester_id = ${first.runId} and q.alias is not null`;
    expect(alias).toMatch(/^q\d+$/);

    const later = await ask("And the ones after 50?", first.threadId);
    const { model: m2, prompts } = scripted([
      step(
        call("read", { path: `/results/${alias}`, offset: 30 }),
        call("read", { path: `/results/${alias}`, offset: 45 }),
        call("read", { path: "/results/q999" }),
      ),
      step(call("answer", { status: "cannot_answer", markdown: "Stopping here.", interpretation: ["x"], caveats: [] })),
    ]);
    await runAttempt(deps(m2), { orgId: s.orgId, runId: later.runId }, { workerId: "t" });
    // The conversation's earlier results come first; this run's three reads are the last.
    const [page, last, missing] = results(prompts.at(-1) ?? [])
      .slice(-3)
      .map((r) => r.value);
    expect(page?.alias).toBe(alias);
    expect(page?.rowCount).toBe(120);
    // The rows its query showed (the citable ones), numbered as they were.
    expect(((page?.rows ?? []) as { "#": number; n: number }[])[0]).toMatchObject({ "#": 30, n: 30 });
    expect(page?.more).toBeUndefined();
    expect(page?.past).toContain("first 50 rows");
    expect(((last?.rows ?? []) as unknown[]).length).toBe(5);
    expect(last?.past).toContain("first 50 rows");
    expect(String(missing?.error ?? JSON.stringify(missing))).toMatch(/Nothing at/);
    // Read back, never run again.
    const [{ n } = { n: -1 }] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.query_run where requester_id = ${later.runId}`;
    expect(n).toBe(0);

    // Another conversation can't read it.
    const other = await ask("Something else.");
    const { model: m3, prompts: p3 } = scripted([
      step(call("read", { path: `/results/${alias}` })),
      step(call("answer", { status: "cannot_answer", markdown: "Stopping here.", interpretation: ["x"], caveats: [] })),
    ]);
    await runAttempt(deps(m3), { orgId: s.orgId, runId: other.runId }, { workerId: "t" });
    const elsewhere = results(p3.at(-1) ?? []).at(-1)?.value;
    expect(JSON.stringify(elsewhere)).toMatch(/Nothing at/);
  });

  it("opens a call in full for the person who asked, and to no one else", async () => {
    const q = await ask("Count to five.");
    const { model } = scripted([
      step(call("sql_query", { title: "Five", sql: "select n from generate_series(1, 5) as n" })),
      step(call("answer", { status: "cannot_answer", markdown: "Stopping here.", interpretation: ["x"], caveats: [] })),
    ]);
    await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "t" });
    const [c] = await s.t.owner<{ call_id: string }[]>`
      select call_id from app.tool_call where run_id = ${q.runId} and tool = 'sql_query'`;
    const mine = await callDetail(
      s.deps,
      { orgId: s.orgId, userId: s.userId, manages: false },
      q.runId,
      c?.call_id ?? "",
    );
    expect(mine?.query?.sql).toContain("generate_series");
    expect(mine?.query?.rows.length).toBe(5);
    expect(mine?.input).toMatchObject({ title: "Five" });
    const other = await callDetail(
      s.deps,
      { orgId: s.orgId, userId: "00000000-0000-4000-8000-0000000000aa", manages: true },
      q.runId,
      c?.call_id ?? "",
    );
    expect(other).toBeNull();
    // An API key has no person: it never sees a call.
    expect(
      await callDetail(s.deps, { orgId: s.orgId, userId: null, manages: true }, q.runId, c?.call_id ?? ""),
    ).toBeNull();
  });
});
