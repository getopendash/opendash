// The context graph's first slice: an organization's knowledge projected into nodes and edges, rebuilt
// whole; what's due for a rebuild; walks of 1–3 hops; personal memories never in it.
import { uuidv7 } from "@opendash/db";
import { withSystemOn, withTenantOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveContext, graphsDue, projectGraph, rememberFact, saveGuide, saveTerm, walkGraph } from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

const SETUP = `
  create table public.trial_accounts (trial_id int primary key, trial_name text);
  insert into public.trial_accounts select g, 'Trial ' || g from generate_series(1, 5) g;
  create table public.memberships (id int primary key, account_name text, status text);
  insert into public.memberships select g, 'Account ' || g, case when g % 3 = 0 then 'active' else 'canceled' end
    from generate_series(1, 12) g;`;

let s: LearnedSource;
const ben = uuidv7();
beforeAll(async () => {
  s = await learnedSource({ setup: SETUP });
}, 300_000);
afterAll(async () => {
  await s?.close();
});

const due = () => withSystemOn(s.t.system, (tx) => graphsDue(tx));
const project = () => s.tenant((tx) => projectGraph(tx, s.orgId));
const edges = async () =>
  s.t.owner<
    { rel: string; src: string; dst: string; srcKind: string; dstKind: string; props: Record<string, unknown> }[]
  >`
    select e.rel, a.key as src, b.key as dst, a.kind as "srcKind", b.kind as "dstKind", e.props from app.edge e
    join app.node a on a.org_id = e.org_id and a.id = e.src_id
    join app.node b on b.org_id = e.org_id and b.id = e.dst_id
    where e.org_id = ${s.orgId} order by e.rel, a.key, b.key`;

describe("the context graph", () => {
  let termId = "";
  it("projects terms, the columns and tables they mean and aren't, guides, definitions and learnings", async () => {
    const who = { orgId: s.orgId, userId: s.userId };
    const term = await s.tenant((tx) =>
      saveTerm(tx, who, {
        body: `term: Paying accounts
means: The accounts with an active membership.
synonyms: [paying customers]
maps_to:
  column: public.memberships.status
  values: [active]
not: [public.trial_accounts]
`,
        connectionId: s.connectionId,
      }),
    );
    termId = term.id;
    await s.tenant((tx) => approveContext(tx, who, [{ id: term.id, version: term.version }]));
    await s.tenant((tx) =>
      saveGuide(tx, who, {
        title: "Canceled memberships",
        body: "A canceled membership keeps its row.",
        connectionId: s.connectionId,
        table: "public.memberships",
      }),
    );
    // A dataset on memberships and a metric measuring it, as their versions say.
    const [dataset, metric] = [uuidv7(), uuidv7()];
    for (const [id, kind, slug, spec, derived] of [
      [dataset, "dataset", "memberships", { ref: "memberships" }, { status: "passed", tables: ["public.memberships"] }],
      [metric, "metric", "paying_accounts", { name: "paying_accounts", dataset: "memberships" }, null],
    ] as const) {
      await s.t
        .owner`insert into app.context_item (org_id, id, kind, scope, path, slug, title, connection_id, status, current_version)
        values (${s.orgId}, ${id}, ${kind}, 'org', ${`/sources/x/${slug}`}, ${slug}, ${slug}, ${s.connectionId}, 'draft', 1)`;
      await s.t
        .owner`insert into app.context_item_version (org_id, item_id, version, body, body_hash, spec, derived, source)
        values (${s.orgId}, ${id}, 1, 'x', 'x', ${s.t.owner.json(spec as never)}, ${derived ? s.t.owner.json(derived as never) : null}, 'user')`;
    }
    // A learning about the term, from three corrections by two people.
    const signal = (userId: string) => ({ kind: "feedback", id: uuidv7(), userId, text: "x", runId: null, at: "" });
    await s.t
      .owner`insert into app.proposal (org_id, id, connection_id, kind, source, status, title, evidence, dedupe_key)
      values (${s.orgId}, ${uuidv7()}, ${s.connectionId}, 'update', 'curator', 'approved', 'Learning: Paying accounts',
        ${s.t.owner.json({ termId: term.id, signals: [signal(s.userId), signal(s.userId), signal(ben)] } as never)},
        'term:paying account')`;
    // Someone's memory about it stays theirs: never a node.
    const memory = await withTenantOn(s.t.app, who, (tx) =>
      rememberFact(tx, who, {
        fact: "Paying accounts means active memberships",
        why: "correction",
        about: "paying accounts",
      }),
    );

    const size = await project();
    expect(size.nodes).toBeGreaterThan(5);
    const all = await edges();
    const find = (rel: string, src: string, dst: string) =>
      all.find((e) => e.rel === rel && e.src === src && e.dst === dst);
    expect(find("MEANS", "term:paying account", "public.memberships.status")?.props).toEqual({ values: ["active"] });
    expect(find("PART_OF", "public.memberships.status", "public.memberships")).toBeTruthy();
    expect(find("IS_NOT", "term:paying account", "public.trial_accounts")).toBeTruthy();
    expect(find("ABOUT", "canceled_memberships", "public.memberships")).toBeTruthy();
    expect(find("DEFINED_ON", "memberships", "public.memberships")).toBeTruthy();
    expect(find("MEASURES", "paying_accounts", "memberships")).toBeTruthy();
    // The learning is about its term (both keyed by the topic).
    expect(all.find((e) => e.rel === "ABOUT" && e.srcKind === "learning" && e.dstKind === "term")?.dst).toBe(
      "term:paying account",
    );
    const said = all.filter((e) => e.rel === "SAID_BY").map((e) => e.props.count);
    expect(said.sort()).toEqual([1, 2]);
    const [kept] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.node where org_id = ${s.orgId} and id = ${memory.id}`;
    expect(kept?.n).toBe(0);

    // Rebuilt whole: the same graph again, nothing doubled.
    expect(await project()).toEqual(size);
  });

  it("walks from a term to what it's about, nearest first, within three hops", async () => {
    const reached = await s.tenant((tx) => walkGraph(tx, s.orgId, termId));
    const at = (key: string) => reached.find((r) => r.key === key)?.depth;
    expect(at("public.memberships.status")).toBe(1);
    expect(at("public.trial_accounts")).toBe(1);
    expect(at("public.memberships")).toBe(2);
    expect(at("canceled_memberships")).toBe(3);
    expect(at("memberships")).toBe(3);
    // Only some relations, when asked: what it means and isn't, and their tables.
    const only = await s.tenant((tx) => walkGraph(tx, s.orgId, termId, { rels: ["MEANS", "IS_NOT", "PART_OF"] }));
    expect(only.map((r) => r.kind).sort()).toEqual(["column", "table", "table"]);
  });

  it("is due again once its knowledge changes, and not before", async () => {
    await project();
    expect(await due()).not.toContain(s.orgId);
    await s.tenant((tx) =>
      saveGuide(
        tx,
        { orgId: s.orgId, userId: s.userId },
        { title: "Trials", body: "Trials convert.", connectionId: s.connectionId, table: "public.trial_accounts" },
      ),
    );
    expect(await due()).toContain(s.orgId);
    await project();
    expect(await due()).not.toContain(s.orgId);
    // A learning under way is projected every minute: its status moves without a timestamp.
    await s.t.owner`update app.proposal set status = 'open' where org_id = ${s.orgId} and source = 'curator'`;
    expect(await due()).toContain(s.orgId);
  });

  it("walks three hops on a graph the size of a real warehouse's in well under the budget", async () => {
    // About 2,000 tables in a chain of terms and guides: the walk stays inside its hops.
    const ids = Array.from({ length: 2000 }, () => uuidv7());
    await s.t.owner`insert into app.node (org_id, id, kind, key)
      select ${s.orgId}, x.id, 'table', 'bench.t' || x.n from unnest(${ids}::uuid[]) with ordinality as x(id, n)`;
    await s.t.owner`insert into app.edge (org_id, id, rel, src_id, dst_id)
      select ${s.orgId}, gen_random_uuid(), 'ABOUT', a.id, b.id
      from unnest(${ids}::uuid[]) with ordinality as a(id, n)
      join unnest(${ids}::uuid[]) with ordinality as b(id, n) on b.n in (a.n + 1, a.n + 7, a.n + 31)`;
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      await s.tenant((tx) => walkGraph(tx, s.orgId, ids[1000] as string));
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95) - 1] as number;
    console.log(`3-hop walk over 2,000 tables and ~6,000 edges: p95 ${p95.toFixed(1)} ms`);
    expect(p95).toBeLessThan(250);
  });
});
