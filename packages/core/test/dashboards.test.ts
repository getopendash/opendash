// Dashboards' storage and data path: a draft saved only when it checks, published against the
// version it began from, versions never changed; a page's queries answered under the revision it draws, for whoever
// reads it, from the warehouse through the worker (numbers as hand-written SQL counts them, the period before
// beside), refused when they ask for anything the definition doesn't declare; the cache keyed again when a column is
// marked personal; a number's rows; a page past the last; and a dead letter that always ends the page's wait.
import type { Definition } from "@opendash/apps/dashboard";
import { sql, uuidv7 } from "@opendash/db";
import { createOrg } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DashboardQueryJob, dashboards, memberLeft, setColumnSensitivity } from "../src";

import { member, verifiedSource } from "./helpers/checks";
import type { LearnedSource } from "./helpers/learned-source";

const { createDashboard, dashboardQueryFailed, executeDashboardQuery, getDashboard, publishDraft, saveDraft } =
  dashboards;

let s: LearnedSource;
const NOW = new Date("2026-10-11T09:00:00Z");
const bob = uuidv7();
let dashboardId = "";
let revision = "";

const definition = (connection: string): Definition => ({
  version: 2,
  title: "Sign-ups",
  filters: {
    f_period: { kind: "period", label: "Period", default: "last_12_months" },
    f_country: { kind: "select", label: "Country", options: ["US", "DE", "GB", "FR"], default: [] },
  },
  queries: {
    q_count: {
      source: { connection, dataset: "accounts" },
      measures: { accounts: ["measure", "accounts"] },
      filters: { f_period: "created_at", f_country: "country" },
      compare: "previous_period",
      drill: "q_list",
    },
    q_list: {
      source: { connection, dataset: "accounts" },
      select: ["id", "name", "country", "created_at"],
      sort: ["-created_at"],
      page: 20,
      filters: { f_period: "created_at", f_country: "country" },
      key: "id",
    },
    q_by_month: {
      source: { connection, dataset: "accounts" },
      measures: { accounts: ["count"] },
      by: ["created_at:month"],
      filters: { f_country: "country" },
    },
  },
});

/** An App's page as the worker builds it (the store keeps the build it's given): what a version must have. */
const built = {
  files: { "/App.tsx": "export default function App() { return null; }" },
  bundle: "/* the App */",
  bundleHash: "c".repeat(64),
};

const maya = () => ({ orgId: s.orgId, userId: s.userId });
const asBob = () => ({ orgId: s.orgId, userId: bob });
const ask = (
  viewer: { orgId: string; userId: string | null },
  requests: dashboards.DashboardRequest[],
  rev = revision,
) =>
  s.tenant((tx) =>
    dashboards.requestDashboardQueries({ boss: s.boss }, tx, viewer, {
      dashboardId,
      revision: rev,
      requests,
      now: NOW,
    }),
  );
/** Runs every queued dashboard query as the worker would, and clears the queue. */
const drain = async () => {
  const jobs = await s.t.owner<{ id: string; data: DashboardQueryJob }[]>`
    select id, data from pgboss.job where name = 'dashboard.query' and state = 'created'`;
  const done = [];
  for (const j of jobs) done.push(await executeDashboardQuery(s.deps, j.data));
  await s.t.owner`delete from pgboss.job where name = 'dashboard.query'`;
  return done;
};
/** Accounts that signed up in [from, to), test accounts left out (the dataset's default segment). */
const accountsBetween = async (from: string, to: string, country?: string) => {
  const [r] = await s.source.query(
    `select count(*)::int as n from public.accounts where not is_test and created_at >= $1 and created_at < $2
       ${country ? "and country::text = $3" : ""}`,
    country ? [from, to, country] : [from, to],
  );
  return Number(r?.n);
};

beforeAll(async () => {
  ({ s } = await verifiedSource(NOW));
  await member(s, s.userId, "maya@acme.example", "owner");
  await member(s, bob, "bob@acme.example");
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("a dashboard's versions", () => {
  it("are saved only checked, published against the version they began from, and never changed", async () => {
    dashboardId = await s.tenant((tx) => createDashboard(tx, maya(), { title: "Sign-ups" }));
    const broken = {
      ...definition(s.connectionId),
      queries: {
        q_count: {
          ...definition(s.connectionId).queries.q_count,
          source: { connection: s.connectionId, dataset: "deals" },
        },
      },
    };
    const save = (definition: unknown, baseVersion: number, who = maya(), parts: typeof built | null = built) =>
      s.tenant((tx) => saveDraft(tx, who, dashboardId, { definition, baseVersion, parts }));
    const publish = (rev: string) => s.tenant((tx) => publishDraft(tx, maya(), dashboardId, { revision: rev }));
    // Its manifest saved before its page (a step of a build): kept as a draft, never published.
    const manifest = await save(definition(s.connectionId), 0, maya(), null);
    expect(manifest).toMatchObject({ ok: true });
    await expect(publish(manifest.ok ? manifest.revision : "")).rejects.toThrow(/It has no page yet/);
    const refused = await save(broken, 0);
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok ? [] : refused.problems).toContainEqual({
      path: "queries.q_count.source.dataset",
      message: expect.stringMatching(/There's no dataset "deals" on that source/),
    });
    // Only its owner changes it: to anyone who can't read it, it isn't there.
    await expect(save(definition(s.connectionId), 0, asBob())).rejects.toMatchObject({ code: "not_found" });
    const saved = await save(definition(s.connectionId), 0);
    expect(saved).toMatchObject({ ok: true, revision: expect.stringMatching(/^[0-9a-f]{64}$/) });
    revision = saved.ok ? saved.revision : "";
    const draft = await s.tenant((tx) => getDashboard(tx, maya(), dashboardId));
    expect(draft).toMatchObject({ currentVersion: 0, version: null, draft: { revision, baseVersion: 0 } });
    expect(await publish(revision)).toEqual({ version: 1, revision });
    const published = await s.tenant((tx) => getDashboard(tx, maya(), dashboardId));
    expect(published).toMatchObject({
      title: "Sign-ups",
      currentVersion: 1,
      version: { version: 1, revision },
      draft: null,
    });
    await expect(publish(revision)).rejects.toMatchObject({ code: "invalid" });
    // The same content as the current version changes nothing.
    await save(definition(s.connectionId), 1);
    await expect(publish(revision)).rejects.toThrow(/version 1 as it is: nothing changed/);
    // Two tabs: the draft saved in one, then the other; publishing what the first saw is refused, not the second's.
    const a = await save({ ...definition(s.connectionId), title: "Sign-ups A" }, 1);
    const b = await save({ ...definition(s.connectionId), title: "Sign-ups B" }, 1);
    await expect(publish(a.ok ? a.revision : "")).rejects.toMatchObject({ code: "conflict" });
    expect(await publish(b.ok ? b.revision : "")).toMatchObject({ version: 2 });
    // A change begun on version 1, saved after version 2: refused, never written over it.
    await expect(save({ ...definition(s.connectionId), title: "Late" }, 1)).rejects.toMatchObject({ code: "conflict" });
    // Another dashboard may hold the same content: its own version 1.
    const twin = await s.tenant((tx) => createDashboard(tx, maya(), { title: "Twin" }));
    const same = await s.tenant((tx) =>
      saveDraft(tx, maya(), twin, {
        definition: { ...definition(s.connectionId), title: "Sign-ups B" },
        parts: built,
        baseVersion: 0,
      }),
    );
    expect(same.ok ? same.revision : "").toBe(b.ok ? b.revision : "x");
    expect(
      await s.tenant((tx) => publishDraft(tx, maya(), twin, { revision: same.ok ? same.revision : "" })),
    ).toMatchObject({ version: 1 });
    // The page reads version 2 from here on.
    revision = b.ok ? b.revision : "";
    // A version, once written, isn't changed.
    await expect(
      s.t.owner`update app.dashboard_version set change_note = 'x' where dashboard_id = ${dashboardId}`,
    ).rejects.toThrow(/never changed/);
  });
});

describe("a page's queries", () => {
  it("are answered from the warehouse through the worker, as hand-written SQL counts, the period before beside", async () => {
    const page = [
      { id: "a", query: "q_count" },
      { id: "b", query: "q_list" },
      { id: "c", query: "q_by_month", filters: { f_country: ["DE"] } },
    ];
    expect((await ask(maya(), page))?.map((x) => x.status)).toEqual(["queued", "queued", "queued"]);
    // Asked again before it ran, nothing new is queued.
    await ask(maya(), page);
    expect(await drain()).toEqual(["answered", "answered", "answered", "answered"]);
    const answers = await ask(maya(), page);
    expect(answers?.map((x) => x.status)).toEqual(["ok", "ok", "ok"]);
    const [count, list, months] = answers as Extract<dashboards.DashboardAnswer, { status: "ok" }>[];
    // The last 12 whole months before October 2026, and the 12 before them.
    const lastYear = await accountsBetween("2025-10-01", "2026-10-01");
    expect(lastYear).toBeGreaterThan(20);
    expect(await accountsBetween("2024-10-01", "2025-10-01")).toBeGreaterThan(0);
    expect(count?.result.columns[0]?.values).toEqual([lastYear]);
    expect(count?.previous?.columns[0]?.values).toEqual([await accountsBetween("2024-10-01", "2025-10-01")]);
    // Each answer carries the warehouse's own time for it: what the render check tells the analyst when one is slow.
    for (const a of [count, list, months]) expect(a?.result.ms).toEqual(expect.any(Number));
    // Its days, and the days it's compared with: what a chart lines its dates up by.
    expect(count?.periods).toEqual({
      now: { from: "2025-10-01", to: "2026-10-01" },
      before: { from: "2024-10-01", to: "2025-10-01" },
    });
    expect(list?.result).toMatchObject({ rowCount: 20, key: "id" });
    expect(list?.result.total).toBe(await accountsBetween("2025-10-01", "2026-10-01"));
    const germany = (months?.result.columns[1]?.values ?? []).reduce<number>((a, b) => a + Number(b), 0);
    expect(germany).toBeGreaterThan(0);
    expect(germany).toBe(await accountsBetween("1900-01-01", "2100-01-01", "DE"));
  });

  it("say where a query's time went: waiting for one of its source's places, inside the query's own time", async () => {
    await ask(maya(), [{ id: "a", query: "q_by_month", filters: { f_country: ["FR"] } }]);
    const [job] = await s.t.owner<{ data: DashboardQueryJob }[]>`
      select data from pgboss.job where name = 'dashboard.query' and state = 'created' limit 1`;
    if (!job) throw new Error("nothing was queued");
    const stages: Record<string, number> = {};
    expect(await executeDashboardQuery({ ...s.deps, stages }, job.data)).toBe("answered");
    expect(stages.slot).toEqual(expect.any(Number));
    expect(stages.slot).toBeLessThanOrEqual(stages.query ?? 0);
    await s.t.owner`delete from pgboss.job where name = 'dashboard.query'`;
  });

  it("answer only whoever reads the revision: a private dashboard its owner, a draft its owner alone", async () => {
    expect(await ask(asBob(), [{ id: "a", query: "q_count" }])).toBeNull();
    await s.t.owner`update app.dashboard set visibility = 'org' where id = ${dashboardId}`;
    expect((await ask(asBob(), [{ id: "a", query: "q_count" }]))?.[0]?.status).toBe("ok");
    const draft = await s.tenant((tx) =>
      saveDraft(tx, maya(), dashboardId, {
        definition: { ...definition(s.connectionId), title: "Draft" },
        baseVersion: 2,
      }),
    );
    const draftRevision = draft.ok ? draft.revision : "";
    expect(await ask(asBob(), [{ id: "a", query: "q_count" }], draftRevision)).toBeNull();
    expect((await ask(maya(), [{ id: "a", query: "q_count" }], draftRevision))?.[0]?.status).toBe("ok");
    expect(await ask(maya(), [{ id: "a", query: "q_count" }], "0".repeat(64))).toBeNull();
    await s.t.owner`delete from app.dashboard_draft where dashboard_id = ${dashboardId}`;
  });

  it("refuse what the definition doesn't declare, and queue nothing for it", async () => {
    const answers = await ask(maya(), [
      { id: "a", query: "q_gone" },
      { id: "b", query: "q_list", filters: { f_country: ["Atlantis"] } },
      { id: "c", query: "q_list", sort: "-industry" },
      { id: "d", query: "q_count", filters: { f_period: "forever" } },
    ]);
    expect(answers).toEqual([
      { id: "a", status: "failed", error: "There's no query q_gone." },
      { id: "b", status: "failed", error: `"Atlantis" isn't one of f_country's options.` },
      { id: "c", status: "failed", error: "q_list can't sort by -industry." },
      { id: "d", status: "failed", error: "f_period takes a period." },
    ]);
    expect(await drain()).toEqual([]);
  });

  it("open a number's rows: the same filters, as many as the number counts", async () => {
    const drill = { id: "a", drill: "q_count", filters: { f_country: ["US"] } };
    expect((await ask(maya(), [drill]))?.[0]?.status).toBe("queued");
    await drain();
    const [rows] = (await ask(maya(), [drill])) as Extract<dashboards.DashboardAnswer, { status: "ok" }>[];
    expect(rows?.result.total).toBeGreaterThan(0);
    expect(rows?.result.total).toBe(await accountsBetween("2025-10-01", "2026-10-01", "US"));
    expect(rows?.result.columns.map((c) => c.name)).toEqual(["id", "name", "country", "created_at"]);
    expect(new Set(rows?.result.columns[2]?.values)).toEqual(new Set(["US"]));
    // A bar with no drill of its own opens its rows too: the columns the dashboard already shows of accounts, narrowed
    // to the bar's month (the group is said, or it's refused).
    expect(await ask(maya(), [{ id: "b", drill: "q_by_month", group: {} }])).toEqual([
      { id: "b", status: "failed", error: "Say which created_at_month the number is for." },
    ]);
    const bar = {
      id: "c",
      drill: "q_by_month",
      filters: { f_country: ["US"] },
      group: { created_at_month: "2026-03-01" },
    };
    expect((await ask(maya(), [bar]))?.[0]?.status).toBe("queued");
    await drain();
    const [month] = (await ask(maya(), [bar])) as Extract<dashboards.DashboardAnswer, { status: "ok" }>[];
    expect(month?.result.columns.map((c) => c.name)).toEqual(expect.arrayContaining(["id", "name", "country"]));
    expect(month?.result.total).toBe(await accountsBetween("2026-03-01", "2026-04-01", "US"));
  });

  it("say a page past the last is past it, never that nothing matched", async () => {
    const far = { id: "a", query: "q_list", page: 4_000 };
    await ask(maya(), [far]);
    await drain();
    const [past] = (await ask(maya(), [far])) as Extract<dashboards.DashboardAnswer, { status: "ok" }>[];
    expect(past?.result).toMatchObject({ rowCount: 0, pastEnd: true });
  });

  it("are keyed again when a column is marked personal, and the warehouse query is refused", async () => {
    const [column] = await s.t.owner<{ id: string }[]>`
      select c.id from app.catalog_object c join app.catalog_object t on t.org_id = c.org_id and t.id = c.parent_id
      where c.connection_id = ${s.connectionId} and c.kind = 'column' and c.name = 'name' and t.name = 'accounts'`;
    const list = [{ id: "a", query: "q_list" }];
    expect((await ask(maya(), list))?.[0]?.status).toBe("ok");
    await s.tenant((tx) =>
      setColumnSensitivity(tx, { orgId: s.orgId, userId: s.userId }, s.connectionId, column?.id as string, true),
    );
    // The answer cached a moment ago isn't served: its key is new, and running it again is refused.
    expect((await ask(maya(), list))?.[0]?.status).toBe("queued");
    await drain();
    const [refused] = (await ask(maya(), list)) ?? [];
    expect(refused).toMatchObject({ status: "failed", error: expect.stringMatching(/personal data/) });
    // Dropped from the source since, its mark still counts: the answer from before it was marked stays unserved.
    await s.t.owner`update app.catalog_object set removed_at = now() where id = ${column?.id as string}`;
    expect((await ask(maya(), list))?.[0]?.status).not.toBe("ok");
    await s.t.owner`update app.catalog_object set removed_at = null where id = ${column?.id as string}`;
    await s.tenant((tx) =>
      setColumnSensitivity(tx, { orgId: s.orgId, userId: s.userId }, s.connectionId, column?.id as string, false),
    );
  });

  it("keep a queued request's bucket while it's asked for again, and a retry waits for its new answer", async () => {
    const months = { id: "a", query: "q_by_month" };
    const [first] = (await ask(maya(), [months])) as Extract<dashboards.DashboardAnswer, { status: "queued" }>[];
    expect(first).toMatchObject({ status: "queued", at: "2026-10-11T09:00:00.000Z" });
    // Asked again after the bucket turned, with the bucket it was given: the same request, not a second query.
    const later = new Date(NOW.getTime() + 6 * 60_000);
    const askAt = (requests: dashboards.DashboardRequest[], retry = false) =>
      s.tenant((tx) =>
        dashboards.requestDashboardQueries({ boss: s.boss }, tx, maya(), {
          dashboardId,
          revision,
          requests,
          now: later,
          retry,
        }),
      );
    expect((await askAt([{ ...months, at: first?.at as string }]))?.[0]).toMatchObject({
      status: "queued",
      at: first?.at,
    });
    expect(await drain()).toEqual(["answered"]);
    expect((await askAt([{ ...months, at: first?.at as string }]))?.[0]?.status).toBe("ok");
    // Its answer failed; a retry clears the failure, so the asks after it wait for the new answer.
    await s.t.owner`
      update app.dashboard_result set status = 'failed', result = null, error = 'The warehouse timed out.'
      where cache_key = (select cache_key from app.dashboard_result order by created_at desc limit 1)`;
    const pinned = { ...months, at: first?.at as string };
    expect((await askAt([pinned]))?.[0]).toMatchObject({ status: "failed", error: "The warehouse timed out." });
    expect((await askAt([pinned], true))?.[0]?.status).toBe("queued");
    expect((await askAt([pinned]))?.[0]?.status).toBe("queued");
    await drain();
    expect((await askAt([pinned]))?.[0]?.status).toBe("ok");
  });

  it("refuse a source that's off before anything is read from the cache", async () => {
    await s.t.owner`update app.connection set status = 'disabled' where id = ${s.connectionId}`;
    expect(await ask(maya(), [{ id: "a", query: "q_count" }])).toEqual([
      { id: "a", status: "failed", error: "The dashboard's source is off or gone." },
    ]);
    await s.t.owner`update app.connection set status = 'ok' where id = ${s.connectionId}`;
    expect((await ask(maya(), [{ id: "a", query: "q_count" }]))?.[0]?.status).toBe("ok");
  });

  it("end a page's wait when the worker gives up, and never write over a good answer", async () => {
    const job = (cacheKey: string): DashboardQueryJob => ({
      orgId: s.orgId,
      dashboardId,
      revision,
      ask: JSON.stringify({ id: "a", query: "q_count" }),
      cacheKey,
      now: NOW.toISOString(),
      askedBy: s.userId,
    });
    await dashboardQueryFailed(s.deps, job("gone"));
    const [failed] = await s.t.owner<{ status: string; error: string }[]>`
      select status, error from app.dashboard_result where cache_key = 'gone'`;
    expect(failed).toMatchObject({ status: "failed", error: expect.stringMatching(/stopped the worker twice/) });
    const [good] = await s.t.owner<{ cache_key: string }[]>`
      select cache_key from app.dashboard_result where status = 'ok' and expires_at > now() limit 1`;
    await dashboardQueryFailed(s.deps, job(good?.cache_key as string));
    const [kept] = await s.t.owner<{ status: string }[]>`
      select status from app.dashboard_result where cache_key = ${good?.cache_key as string}`;
    expect(kept?.status).toBe("ok");
    // A job whose key no longer matches (another time, another revision) runs nothing.
    expect(await executeDashboardQuery(s.deps, job("not-its-key"))).toBe("skipped");
    expect(await executeDashboardQuery(s.deps, { ...job("x"), revision: "0".repeat(64) })).toBe("skipped");
  });
});

describe("a dashboard's people", () => {
  it("see it once it's shared; its owner restores a version, its code as it was; an admin deletes it", async () => {
    const { deleteDashboard, listDashboards, listVersions, restoreVersion, setDashboardVisibility } = dashboards;
    const id = await s.tenant((tx) => createDashboard(tx, maya(), { title: "Shared" }));
    // The App's code; the store keeps the build it's given (the worker builds and checks it).
    const titled = (title: string): Definition => ({ ...definition(s.connectionId), title });
    const code = (hash: string) => ({
      files: { "/App.tsx": `export default function App() { return null; } // ${hash}` },
      bundle: `/* ${hash} */`,
      bundleHash: hash.repeat(64),
    });
    const ship = async (title: string, hash: string, base: number) => {
      const saved = await s.tenant((tx) =>
        saveDraft(tx, maya(), id, { definition: titled(title), parts: code(hash), baseVersion: base }),
      );
      if (!saved.ok) throw new Error(JSON.stringify(saved.problems));
      return s.tenant((tx) => publishDraft(tx, maya(), id, { revision: saved.revision, note: title }));
    };
    // Its owner sees it while it's only a draft; nobody else does, even once it's out, until it's shared.
    expect((await s.tenant((tx) => listDashboards(tx, maya()))).map((d) => d.id)).toContain(id);
    await ship("Shared v1", "a", 0);
    await ship("Shared v2", "b", 1);
    const bobSees = async () => (await s.tenant((tx) => listDashboards(tx, asBob()))).find((d) => d.id === id);
    expect(await bobSees()).toBeUndefined();
    // Nobody else shares it: while it's private, it isn't there for them.
    await expect(s.tenant((tx) => setDashboardVisibility(tx, asBob(), id, "org"))).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(s.tenant((tx) => setDashboardVisibility(tx, maya(), id, "project"))).rejects.toMatchObject({
      code: "invalid",
    });
    await s.tenant((tx) => setDashboardVisibility(tx, maya(), id, "org"));
    expect(await bobSees()).toMatchObject({ title: "Shared v2", mine: false, currentVersion: 2 });
    expect((await s.tenant((tx) => listVersions(tx, asBob(), id)))?.map((v) => [v.version, v.changeNote])).toEqual([
      [2, "Shared v2"],
      [1, "Shared v1"],
    ]);

    // Restore: its owner's, against the version they saw; the definition and its code's build come back as they were.
    await expect(
      s.tenant((tx) => restoreVersion(tx, asBob(), id, { version: 1, expectedVersion: 2 })),
    ).rejects.toMatchObject({ code: "not_yours" });
    await expect(
      s.tenant((tx) => restoreVersion(tx, maya(), id, { version: 1, expectedVersion: 1 })),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await s.tenant((tx) => restoreVersion(tx, maya(), id, { version: 1, expectedVersion: 2 }))).toEqual({
      ok: true,
      version: 3,
    });
    const restored = await s.tenant((tx) => getDashboard(tx, asBob(), id));
    expect(restored).toMatchObject({
      title: "Shared v1",
      version: { version: 3, changeNote: "Restored version 1", bundleHash: "a".repeat(64) },
    });
    const [v1, v3] = await s.t.owner<{ revision: string }[]>`
      select revision from app.dashboard_version where dashboard_id = ${id} and version in (1, 3) order by version`;
    expect(v3?.revision).toBe(v1?.revision);
    // The current version restored changes nothing.
    await expect(s.tenant((tx) => restoreVersion(tx, maya(), id, { version: 3, expectedVersion: 3 }))).rejects.toThrow(
      /nothing changed/,
    );

    // Delete: not a member's; an owner or admin's, gone for everyone. One they can't read isn't there for them.
    const hidden = await s.tenant((tx) => createDashboard(tx, maya(), { title: "Hidden" }));
    await expect(s.tenant((tx) => deleteDashboard(tx, { ...asBob(), canManage: true }, hidden))).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(s.tenant((tx) => deleteDashboard(tx, { ...asBob(), canManage: false }, id))).rejects.toMatchObject({
      code: "not_yours",
    });
    await s.tenant((tx) => deleteDashboard(tx, { ...asBob(), canManage: true }, id));
    expect(await s.tenant((tx) => getDashboard(tx, maya(), id))).toBeNull();
    expect(await bobSees()).toBeUndefined();
    await expect(
      s.tenant((tx) => restoreVersion(tx, maya(), id, { version: 1, expectedVersion: 3 })),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("sharing with people (View / Can edit)", () => {
  const carol = uuidv7();
  const dave = uuidv7();
  const vic = uuidv7();
  const asCarol = () => ({ orgId: s.orgId, userId: carol });
  const asDave = () => ({ orgId: s.orgId, userId: dave });
  const titled = (title: string): Definition => ({ ...definition(s.connectionId), title });
  /** A private App with a published version, as Maya builds one. */
  const shipped = async (title: string) => {
    const id = await s.tenant((tx) => createDashboard(tx, maya(), { title }));
    const saved = await s.tenant((tx) =>
      saveDraft(tx, maya(), id, { parts: built, definition: titled(title), baseVersion: 0 }),
    );
    if (!saved.ok) throw new Error(JSON.stringify(saved.problems));
    await s.tenant((tx) => publishDraft(tx, maya(), id, { revision: saved.revision }));
    return { id, revision: saved.revision };
  };
  const share = (id: string, userId: string, role: dashboards.ShareRole | null, who = maya()) =>
    s.tenant((tx) => dashboards.shareDashboard(tx, who, id, { userId, role }));
  const askOn = (
    viewer: { orgId: string; userId: string },
    id: string,
    rev: string,
    requests: dashboards.DashboardRequest[],
  ) =>
    s.tenant((tx) =>
      dashboards.requestDashboardQueries({ boss: s.boss }, tx, viewer, {
        dashboardId: id,
        revision: rev,
        requests,
        now: NOW,
      }),
    );

  beforeAll(async () => {
    await member(s, carol, "carol@acme.example");
    await member(s, dave, "dave@acme.example");
    await member(s, vic, "vic@acme.example", "viewer");
  });

  it("lets a viewer read it but not change it, and an editor change its draft but nothing that stays its owner's", async () => {
    const { canEditDashboard, deleteDashboard, listDashboards, listShares, restoreVersion, setDashboardVisibility } =
      dashboards;
    const { id } = await shipped("Pipeline");
    // Private: nobody else reads it, and only its owner shares it.
    expect((await s.tenant((tx) => listDashboards(tx, asDave()))).map((d) => d.id)).not.toContain(id);
    await expect(share(id, dave, "view", asCarol())).rejects.toMatchObject({ code: "not_found" });
    await share(id, dave, "view");
    await share(id, carol, "view");
    await share(id, carol, "edit");
    // Not themselves, not someone outside the workspace, never a workspace viewer to edit (viewers don't build).
    await expect(share(id, s.userId, "view")).rejects.toMatchObject({ code: "invalid" });
    await expect(share(id, uuidv7(), "view")).rejects.toMatchObject({ code: "invalid" });
    await expect(share(id, vic, "edit")).rejects.toMatchObject({ code: "invalid" });
    expect((await s.tenant((tx) => listShares(tx, maya(), id))).map((p) => [p.userId, p.role])).toEqual([
      [dave, "view"],
      [carol, "edit"],
    ]);
    // Who it's shared with is its owner's to see.
    await expect(s.tenant((tx) => listShares(tx, asCarol(), id))).rejects.toMatchObject({ code: "not_yours" });

    // A viewer: listed and opened as shared with them, the version only; never saved by them.
    expect((await s.tenant((tx) => listDashboards(tx, asDave()))).find((d) => d.id === id)).toMatchObject({
      mine: false,
      canEdit: false,
      sharedRole: "view",
      draft: false,
    });
    expect(await s.tenant((tx) => getDashboard(tx, asDave(), id))).toMatchObject({
      canEdit: false,
      sharedRole: "view",
      people: 0,
      draft: null,
    });
    await expect(
      s.tenant((tx) =>
        saveDraft(tx, asDave(), id, { parts: built, definition: titled("Pipeline by Dave"), baseVersion: 1 }),
      ),
    ).rejects.toMatchObject({ code: "not_yours" });
    expect(await s.tenant((tx) => dashboards.workingCopy(tx, asDave(), id))).toBeNull();
    expect(await s.tenant((tx) => canEditDashboard(tx, asDave(), id))).toBe(false);

    // An editor saves the draft, and the save is the draft its owner and they see; a viewer still sees the version.
    expect(await s.tenant((tx) => canEditDashboard(tx, asCarol(), id))).toBe(true);
    const saved = await s.tenant((tx) =>
      saveDraft(tx, asCarol(), id, { parts: built, definition: titled("Pipeline by Carol"), baseVersion: 1 }),
    );
    const draftRevision = saved.ok ? saved.revision : "";
    expect(draftRevision).toMatch(/^[0-9a-f]{64}$/);
    for (const who of [asCarol(), maya()]) {
      expect(await s.tenant((tx) => getDashboard(tx, who, id))).toMatchObject({
        canEdit: true,
        draft: { revision: draftRevision, definition: { title: "Pipeline by Carol" } },
      });
    }
    expect(await s.tenant((tx) => getDashboard(tx, maya(), id))).toMatchObject({ people: 2, sharedRole: null });
    expect((await s.tenant((tx) => getDashboard(tx, asDave(), id)))?.draft).toBeNull();
    expect((await s.tenant((tx) => dashboards.workingCopy(tx, asCarol(), id)))?.definition?.title).toBe(
      "Pipeline by Carol",
    );
    expect((await s.tenant((tx) => listDashboards(tx, asCarol()))).find((d) => d.id === id)).toMatchObject({
      canEdit: true,
      sharedRole: "edit",
      draft: true,
    });
    // The draft's frame answers its editor, never its viewer.
    expect(await s.tenant((tx) => dashboards.definitionAt(tx, asCarol(), id, draftRevision))).toMatchObject({
      kind: "draft",
    });
    expect(await s.tenant((tx) => dashboards.definitionAt(tx, asDave(), id, draftRevision))).toBeNull();
    expect(await askOn(asDave(), id, draftRevision, [{ id: "a", query: "q_count" }])).toBeNull();

    // What stays its owner's refuses an editor: publish, restore, who sees it, who it's shared with, delete.
    await expect(s.tenant((tx) => publishDraft(tx, asCarol(), id, { revision: draftRevision }))).rejects.toMatchObject({
      code: "not_yours",
    });
    await expect(
      s.tenant((tx) => restoreVersion(tx, asCarol(), id, { version: 1, expectedVersion: 1 })),
    ).rejects.toMatchObject({ code: "not_yours" });
    await expect(s.tenant((tx) => setDashboardVisibility(tx, asCarol(), id, "org"))).rejects.toMatchObject({
      code: "not_yours",
    });
    await expect(share(id, dave, "edit", asCarol())).rejects.toMatchObject({ code: "not_yours" });
    await expect(s.tenant((tx) => deleteDashboard(tx, { ...asCarol(), canManage: false }, id))).rejects.toMatchObject({
      code: "not_yours",
    });
    // Its owner publishes what the editor saved.
    expect(await s.tenant((tx) => publishDraft(tx, maya(), id, { revision: draftRevision }))).toMatchObject({
      version: 2,
    });
    expect(await s.tenant((tx) => getDashboard(tx, asDave(), id))).toMatchObject({ title: "Pipeline by Carol" });
  });

  it("takes it away from someone removed: their list, its page, the draft, and their requests already queued", async () => {
    const { listDashboards } = dashboards;
    const { id, revision: versionRevision } = await shipped("Renewals");
    const saved = await s.tenant((tx) =>
      saveDraft(tx, maya(), id, { parts: built, definition: titled("Renewals next"), baseVersion: 1 }),
    );
    const draftRevision = saved.ok ? saved.revision : "";
    await share(id, carol, "edit");
    await share(id, dave, "view");
    // Asked while they could: queued for the worker (filters no other test asks, so nothing is cached yet).
    const carolAsks: dashboards.DashboardRequest[] = [{ id: "a", query: "q_count", filters: { f_country: ["GB"] } }];
    const daveAsks: dashboards.DashboardRequest[] = [{ id: "a", query: "q_count", filters: { f_country: ["FR"] } }];
    expect((await askOn(asCarol(), id, draftRevision, carolAsks))?.[0]?.status).toBe("queued");
    expect((await askOn(asDave(), id, versionRevision, daveAsks))?.[0]?.status).toBe("queued");

    await share(id, carol, null);
    await share(id, dave, null);
    expect(await s.tenant((tx) => dashboards.listShares(tx, maya(), id))).toEqual([]);
    for (const who of [asCarol(), asDave()]) {
      expect((await s.tenant((tx) => listDashboards(tx, who))).map((d) => d.id)).not.toContain(id);
      expect(await s.tenant((tx) => getDashboard(tx, who, id))).toBeNull();
    }
    expect(await s.tenant((tx) => dashboards.workingCopy(tx, asCarol(), id))).toBeNull();
    await expect(
      s.tenant((tx) =>
        saveDraft(tx, asCarol(), id, { parts: built, definition: titled("Renewals mine"), baseVersion: 1 }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await askOn(asCarol(), id, draftRevision, carolAsks)).toBeNull();
    // The worker runs nothing they asked for before: no answer is written, so the owner's ask is queued anew.
    const ran = await drain();
    expect(ran.length).toBeGreaterThan(0);
    expect(ran.every((r) => r === "skipped")).toBe(true);
    expect((await askOn(maya(), id, draftRevision, carolAsks))?.[0]?.status).toBe("queued");
    await s.t.owner`delete from pgboss.job where name = 'dashboard.query'`;
  });

  it("never reaches another organization: its shares aren't there, and a share can't point across", async () => {
    const { id } = await shipped("Quota");
    await share(id, carol, "edit");
    const other = uuidv7();
    await createOrg(s.t, other, "Lumen");
    const outsider = { orgId: other, userId: carol };
    expect(
      await s.deps.withTenant(other, (tx) =>
        tx.execute<{ n: number }>(sql`select count(*)::int as n from app.dashboard_share`),
      ),
    ).toEqual([{ n: 0 }]);
    expect(await s.deps.withTenant(other, (tx) => getDashboard(tx, outsider, id))).toBeNull();
    expect(await s.deps.withTenant(other, (tx) => dashboards.canEditDashboard(tx, outsider, id))).toBe(false);
    // The tenant's own writes can't name another organization, and a share's dashboard is its organization's.
    await expect(
      s.tenant((tx) =>
        tx.execute(sql`insert into app.dashboard_share (org_id, id, dashboard_id, user_id, role, added_by)
          values (${other}, ${uuidv7()}, ${id}, ${dave}, 'view', ${s.userId})`),
      ),
    ).rejects.toThrow();
    await expect(
      s.t.owner`insert into app.dashboard_share (org_id, id, dashboard_id, user_id, role, added_by)
        values (${other}, ${uuidv7()}, ${id}, ${dave}, 'view', ${s.userId})`,
    ).rejects.toThrow(/foreign key/);
  });

  it("drops what was shared with someone who leaves the workspace", async () => {
    const { id } = await shipped("Leavers");
    await share(id, dave, "view");
    await s.tenant((tx) => memberLeft(tx, s.orgId, dave));
    expect(await s.tenant((tx) => dashboards.listShares(tx, maya(), id))).toEqual([]);
  });

  it("treats an edit share as View once its person is made a workspace viewer, and as Can edit again after", async () => {
    const erin = uuidv7();
    await member(s, erin, "erin@acme.example");
    const asErin = () => ({ orgId: s.orgId, userId: erin });
    const { id } = await shipped("Forecast");
    await share(id, erin, "edit");
    const save = (title: string) =>
      s.tenant((tx) => saveDraft(tx, asErin(), id, { parts: built, definition: titled(title), baseVersion: 1 }));
    expect(await save("Forecast by Erin")).toMatchObject({ ok: true });
    // Made a viewer since: still reads it, its draft no longer hers to see or change.
    await s.t.owner`update auth.member set role = 'viewer' where organization_id = ${s.orgId} and user_id = ${erin}`;
    await expect(save("Forecast again")).rejects.toMatchObject({ code: "not_yours" });
    expect(await s.tenant((tx) => getDashboard(tx, asErin(), id))).toMatchObject({
      canEdit: false,
      sharedRole: "view",
      draft: null,
      title: "Forecast",
    });
    expect(await s.tenant((tx) => dashboards.workingCopy(tx, asErin(), id))).toBeNull();
    expect((await s.tenant((tx) => dashboards.listDashboards(tx, asErin()))).find((d) => d.id === id)).toMatchObject({
      canEdit: false,
      sharedRole: "view",
    });
    // A member again: the share she was given acts as given.
    await s.t.owner`update auth.member set role = 'member' where organization_id = ${s.orgId} and user_id = ${erin}`;
    expect(await s.tenant((tx) => dashboards.canEditDashboard(tx, asErin(), id))).toBe(true);
  });

  it("knows who saved a draft last, as Undo leaves it, and reads it for others only while its saver is a member", async () => {
    const frank = uuidv7();
    await member(s, frank, "frank@acme.example");
    const asFrank = () => ({ orgId: s.orgId, userId: frank });
    const { id } = await shipped("Churn");
    await share(id, frank, "edit");
    const savedBy = async () => (await s.tenant((tx) => getDashboard(tx, maya(), id)))?.draft?.savedBy;
    // Maya's draft, then a run of Frank's saves over it: his. Undone (by him), it's Maya's again, as it was.
    const mine = await s.tenant((tx) =>
      saveDraft(tx, maya(), id, { parts: built, definition: titled("Churn A"), baseVersion: 1 }),
    );
    expect(await savedBy()).toBe(s.userId);
    const run = uuidv7();
    const his = await s.tenant((tx) =>
      saveDraft(tx, asFrank(), id, { parts: built, definition: titled("Churn B"), baseVersion: 1, runId: run }),
    );
    const hisRevision = his.ok ? his.revision : "";
    expect(await savedBy()).toBe(frank);
    expect(await s.tenant((tx) => dashboards.definitionAt(tx, maya(), id, hisRevision))).toMatchObject({
      kind: "draft",
      savedBy: frank,
    });
    await s.tenant((tx) => dashboards.undoRun(tx, asFrank(), id, run));
    expect(await savedBy()).toBe(s.userId);
    expect((await s.tenant((tx) => getDashboard(tx, maya(), id)))?.draft?.revision).toBe(mine.ok ? mine.revision : "");
    // His again; then he leaves the workspace: what he saved reads nothing for anyone else until it's saved again.
    const again = await s.tenant((tx) =>
      saveDraft(tx, asFrank(), id, { parts: built, definition: titled("Churn C"), baseVersion: 1 }),
    );
    const leftRevision = again.ok ? again.revision : "";
    await s.t.owner`delete from auth.member where organization_id = ${s.orgId} and user_id = ${frank}`;
    const asks: dashboards.DashboardRequest[] = [{ id: "a", query: "q_count", filters: { f_country: ["US"] } }];
    expect(await askOn(maya(), id, leftRevision, asks)).toEqual([
      { id: "a", status: "failed", error: expect.stringMatching(/last saved by someone who has left/) },
    ]);
    // Published, it's its owner's: it reads again.
    await s.tenant((tx) => publishDraft(tx, maya(), id, { revision: leftRevision }));
    expect((await askOn(maya(), id, leftRevision, asks))?.[0]?.status).not.toBe("failed");
    await s.t.owner`delete from pgboss.job where name = 'dashboard.query'`;
  });

  it("turns a draft's writes off for anyone but its last saver: a summary isn't written from it", async () => {
    const { id } = await shipped("Notes");
    await share(id, carol, "edit");
    const saved = await s.tenant((tx) =>
      saveDraft(tx, asCarol(), id, { parts: built, definition: titled("Notes by Carol"), baseVersion: 1 }),
    );
    const rev = saved.ok ? saved.revision : "";
    const write = (who: { orgId: string; userId: string }) =>
      s.tenant((tx) =>
        dashboards.summaryAnswer({ boss: s.boss }, tx, who, {
          dashboardId: id,
          revision: rev,
          section: "s_none",
          filters: {},
          write: true,
        }),
      );
    expect(await write(maya())).toEqual({ status: "failed", error: dashboards.ACTIONS_OFF });
    // Carol saved it: hers runs as it would (here, a summary it hasn't).
    expect(await write(asCarol())).toEqual({ status: "failed", error: "There's no summary here." });
  });

  it("keeps a draft's layout check only from whoever saved it: measured elsewhere, it'd carry their data back", async () => {
    const { id } = await shipped("Measured");
    await share(id, carol, "edit");
    const saved = await s.tenant((tx) =>
      saveDraft(tx, asCarol(), id, { parts: built, definition: titled("Measured by Carol"), baseVersion: 1 }),
    );
    const revision = saved.ok ? saved.revision : "";
    const findings = [{ kind: "overflow", message: "A label runs past its box." }];
    const check = (who: { orgId: string; userId: string }) =>
      s.tenant((tx) => dashboards.saveRenderCheck(tx, who, id, { revision, width: 1280, findings }));
    // Maya's browser ran Carol's code: what it measured isn't kept.
    expect(await check(maya())).toBe(false);
    expect(await check(asCarol())).toBe(true);
  });
});

describe("where a query reads", () => {
  it("names each query's source and what it reads there, for the line under its piece", async () => {
    const d = definition(s.connectionId);
    const reads = await s.tenant(async (tx) =>
      dashboards.queryReads(tx, s.orgId, d, await dashboards.catalogsFor(tx, s.orgId, d)),
    );
    const [conn] = await s.t.owner<
      { name: string; dialect: string }[]
    >`select name, dialect from app.connection where id = ${s.connectionId}`;
    expect(Object.keys(reads).sort()).toEqual(["q_by_month", "q_count", "q_list"]);
    // The connection's own name, and the dataset's title as the source's catalog has it.
    expect(reads.q_count).toMatchObject({ source: conn?.name, dataset: expect.any(String) });
    expect(reads.q_count?.dataset.length).toBeGreaterThan(0);
    expect(reads.q_count?.provenance).toBeDefined();
    // Its database's mark, drawn before the name: the path itself, as the frame loads nothing.
    expect(reads.q_count?.mark).toMatchObject({ title: expect.any(String), path: expect.stringMatching(/^M/) });
    expect(conn?.dialect).toBe("postgres");
    // A source that isn't this workspace's is never named: it reads as "a source".
    const elsewhere = {
      ...d,
      queries: { q_x: { ...d.queries.q_count, source: { connection: uuidv7(), dataset: "accounts" } } },
    };
    const none = await s.tenant(async (tx) => dashboards.queryReads(tx, s.orgId, elsewhere, {}));
    expect(none.q_x?.source).toBe("a source");
  });
});

describe("a change from a working copy", () => {
  it("is saved only on the draft it began from, and a conversation lists what it built", async () => {
    const { listDashboards, workingCopy } = dashboards;
    const threadId = uuidv7();
    await s.t.owner`
      insert into app.thread (org_id, id, connection_id, created_by, title, channel, visibility)
      values (${s.orgId}, ${threadId}, ${s.connectionId}, ${s.userId}, 'Built', 'web', 'private')`;
    const id = await s.tenant((tx) => createDashboard(tx, maya(), { title: "Built", threadId }));
    const fresh = await s.tenant((tx) => workingCopy(tx, maya(), id));
    expect(fresh).toMatchObject({ id, threadId, baseVersion: 0, draftAt: null, definition: null, files: {} });
    // Bob's isn't there: a working copy is its owner's.
    expect(await s.tenant((tx) => workingCopy(tx, asBob(), id))).toBeNull();
    const save = (title: string, baseDraftAt: string | null) =>
      s.tenant((tx) =>
        saveDraft(tx, maya(), id, {
          definition: { ...definition(s.connectionId), title },
          baseVersion: 0,
          baseDraftAt,
        }),
      );
    expect(await save("Built A", null)).toMatchObject({ ok: true });
    const savedAt = (await s.tenant((tx) => workingCopy(tx, maya(), id)))?.draftAt ?? null;
    expect(savedAt).not.toBeNull();
    // Two saves that began from no draft: the second is refused, never written over the first; the same content saved
    // again on the first is refused too (it renders the same, but it began before the first was saved).
    await expect(save("Built B", null)).rejects.toMatchObject({ code: "conflict" });
    await expect(save("Built A", null)).rejects.toMatchObject({ code: "conflict" });
    expect(await save("Built B", savedAt)).toMatchObject({ ok: true });
    const copy = await s.tenant((tx) => workingCopy(tx, maya(), id));
    expect(copy?.definition?.title).toBe("Built B");
    // The conversation lists it, with its draft (its owner's to know).
    expect(await s.tenant((tx) => listDashboards(tx, maya(), { threadId }))).toMatchObject([
      { id, mine: true, draft: true, currentVersion: 0 },
    ]);
    expect(await s.tenant((tx) => listDashboards(tx, maya(), { threadId: uuidv7() }))).toEqual([]);
  });
});

describe("an analyst's change, undone", () => {
  it("puts the draft back as it was before the run's first save, and only while nothing was saved over it", async () => {
    const { undoRun, undoable, workingCopy } = dashboards;
    const offered = (runId: string) => s.tenant((tx) => undoable(tx, maya(), [id], runId));
    const id = await s.tenant((tx) => createDashboard(tx, maya(), { title: "Undo" }));
    const titleNow = async () => (await s.tenant((tx) => workingCopy(tx, maya(), id)))?.definition?.title;
    const save = async (title: string, runId?: string) => {
      const at = (await s.tenant((tx) => workingCopy(tx, maya(), id)))?.draftAt ?? null;
      return s.tenant((tx) =>
        saveDraft(tx, maya(), id, {
          definition: { ...definition(s.connectionId), title },
          baseVersion: 0,
          baseDraftAt: at,
          ...(runId ? { runId } : {}),
        }),
      );
    };
    const run = uuidv7();
    expect(await save("Mine")).toMatchObject({ ok: true });
    // The run saves twice: undone, it's the person's draft again, not the run's first save.
    expect(await save("Run 1", run)).toMatchObject({ ok: true });
    expect(await save("Run 2", run)).toMatchObject({ ok: true });
    expect(await offered(run)).toEqual([id]);
    expect(await s.tenant((tx) => undoable(tx, asBob(), [id], run))).toEqual([]);
    await expect(s.tenant((tx) => undoRun(tx, asBob(), id, run))).rejects.toMatchObject({ code: "not_found" });
    expect(await s.tenant((tx) => undoRun(tx, maya(), id, run))).toMatchObject({ revision: expect.any(String) });
    expect(await titleNow()).toBe("Mine");
    // Once only: there's nothing left of it, and it isn't offered.
    expect(await offered(run)).toEqual([]);
    await expect(s.tenant((tx) => undoRun(tx, maya(), id, run))).rejects.toMatchObject({ code: "conflict" });
    // A run's change the person saved over: refused, never written over theirs.
    const later = uuidv7();
    expect(await save("Run 3", later)).toMatchObject({ ok: true });
    expect(await save("Mine again")).toMatchObject({ ok: true });
    expect(await offered(later)).toEqual([]);
    await expect(s.tenant((tx) => undoRun(tx, maya(), id, later))).rejects.toMatchObject({ code: "conflict" });
    expect(await titleNow()).toBe("Mine again");
    // A run that made the first draft: undone, there's no draft.
    const fresh = await s.tenant((tx) => createDashboard(tx, maya(), { title: "Fresh" }));
    const first = uuidv7();
    expect(
      await s.tenant((tx) =>
        saveDraft(tx, maya(), fresh, { definition: definition(s.connectionId), baseVersion: 0, runId: first }),
      ),
    ).toMatchObject({ ok: true });
    expect(await s.tenant((tx) => undoRun(tx, maya(), fresh, first))).toEqual({ revision: null });
    expect((await s.tenant((tx) => workingCopy(tx, maya(), fresh)))?.definition).toBeNull();
  });

  it("puts back a draft kept from before migration 0106 without the kit's pages and nav, which an App refuses", async () => {
    const { undoRun, workingCopy } = dashboards;
    const id = await s.tenant((tx) => createDashboard(tx, maya(), { title: "Old undo" }));
    const run = uuidv7();
    expect(
      await s.tenant((tx) =>
        saveDraft(tx, maya(), id, {
          definition: { ...definition(s.connectionId), title: "Mine" },
          parts: built,
          baseVersion: 0,
        }),
      ),
    ).toMatchObject({ ok: true });
    const at = (await s.tenant((tx) => workingCopy(tx, maya(), id)))?.draftAt ?? null;
    expect(
      await s.tenant((tx) =>
        saveDraft(tx, maya(), id, {
          definition: { ...definition(s.connectionId), title: "Run" },
          baseVersion: 0,
          baseDraftAt: at,
          runId: run,
        }),
      ),
    ).toMatchObject({ ok: true });
    // What the run's undo kept, as a draft from before 0106 had it.
    await s.t.owner`
      update app.dashboard_draft
      set undo = jsonb_set(undo, '{before,definition}', undo->'before'->'definition' || '{"pages": [], "nav": []}')
      where dashboard_id = ${id}`;
    const undone = await s.tenant((tx) => undoRun(tx, maya(), id, run));
    const [draft] = await s.t.owner<{ definition: Record<string, unknown>; revision: string }[]>`
      select definition, revision from app.dashboard_draft where dashboard_id = ${id}`;
    expect(draft?.definition.title).toBe("Mine");
    expect(draft?.definition).not.toHaveProperty("pages");
    expect(draft?.definition).not.toHaveProperty("nav");
    expect(undone.revision).toBe(draft?.revision);
    // It publishes as it is: the App's schema has nothing to refuse in it.
    expect(
      await s.tenant((tx) => publishDraft(tx, maya(), id, { revision: draft?.revision ?? "", note: null })),
    ).toMatchObject({ version: 1 });
  });
});

describe("work that doesn't build yet (apps as code)", () => {
  it("is kept only on the base it began from: a save since wins, and its kit keys are left out when it's opened", async () => {
    const { baseOf, keepWork, workingCopy } = dashboards;
    const id = await s.tenant((tx) => createDashboard(tx, maya(), { title: "Work" }));
    const work = (base: string, title: string) => ({
      base,
      definition: { ...definition(s.connectionId), title, pages: [], nav: [] },
      files: { "/App.tsx": "export default () => null" },
    });
    // Nothing saved yet: kept on "no draft".
    expect(await s.tenant((tx) => keepWork(tx, maya(), id, work("0@none", "First")))).toBe(true);
    const kept = (await s.tenant((tx) => workingCopy(tx, maya(), id)))?.work;
    expect(kept?.definition).toMatchObject({ title: "First" });
    expect(kept?.definition).not.toHaveProperty("pages");
    expect(kept?.definition).not.toHaveProperty("nav");
    // Not someone else's.
    expect(await s.tenant((tx) => keepWork(tx, asBob(), id, work("0@none", "Bob's")))).toBe(false);
    // A save lands: work begun on "no draft" is stale and isn't kept over it.
    expect(
      await s.tenant((tx) =>
        saveDraft(tx, maya(), id, { definition: { ...definition(s.connectionId), title: "Saved" }, baseVersion: 0 }),
      ),
    ).toMatchObject({ ok: true });
    expect(await s.tenant((tx) => keepWork(tx, maya(), id, work("0@none", "Stale")))).toBe(false);
    const after = await s.tenant((tx) => workingCopy(tx, maya(), id));
    expect(after?.work).toBeNull();
    expect(after?.definition?.title).toBe("Saved");
    // Work begun on the saved draft is kept.
    expect(await s.tenant((tx) => keepWork(tx, maya(), id, work(baseOf(after as never), "On the draft")))).toBe(true);
    expect((await s.tenant((tx) => workingCopy(tx, maya(), id)))?.work?.definition).toMatchObject({
      title: "On the draft",
    });
    // Never past an App's own sizes (40 files, 300,000 characters together), as a build isn't: what's kept stays.
    const onDraft = baseOf(after as never);
    const many = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`/Part${i}.tsx`, "export {};"]));
    const long = {
      "/App.tsx": "x".repeat(50_000),
      ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [`/P${i}.tsx`, "y".repeat(50_000)])),
    };
    for (const files of [many, long]) {
      expect(await s.tenant((tx) => keepWork(tx, maya(), id, { ...work(onDraft, "Too big"), files }))).toBe(false);
    }
    expect((await s.tenant((tx) => workingCopy(tx, maya(), id)))?.work?.definition).toMatchObject({
      title: "On the draft",
    });
  });
});

describe("the render check (apps as code)", () => {
  it("keeps what the browser measured for the draft's own revision, three widths at most, until the next save", async () => {
    const { renderCheckOf, saveRenderCheck } = dashboards;
    const id = await s.tenant((tx) => createDashboard(tx, maya(), { title: "Measured" }));
    const save = (title: string, at: string | null) =>
      s.tenant((tx) =>
        saveDraft(tx, maya(), id, {
          definition: { ...definition(s.connectionId), title },
          baseVersion: 0,
          baseDraftAt: at,
        }),
      );
    const first = await save("One", null);
    if (!first.ok) throw new Error("didn't save");
    const keep = (revision: string, width: number, findings: unknown[] = []) =>
      s.tenant((tx) => saveRenderCheck(tx, maya(), id, { revision, width, findings }));
    expect(
      await keep(first.revision, 390, [
        { kind: "overlap", message: "A and B overlap at 390px." },
        { kind: "nope", message: "x" },
      ]),
    ).toBe(true);
    expect(await keep(first.revision, 760)).toBe(true);
    expect(await keep(first.revision, 1280)).toBe(true);
    // A fourth width, and an older revision, are dropped.
    expect(await keep(first.revision, 1440)).toBe(false);
    expect(await keep("not-its-revision", 390)).toBe(false);
    const check = await s.tenant((tx) => renderCheckOf(tx, maya(), id));
    expect(Object.keys(check?.widths ?? {}).sort()).toEqual(["1280", "390", "760"]);
    expect(check?.widths["390"]?.findings).toEqual([{ kind: "overlap", message: "A and B overlap at 390px." }]);
    // Only its owner reads or writes it.
    await expect(s.tenant((tx) => renderCheckOf(tx, asBob(), id))).rejects.toMatchObject({ code: "not_found" });
    // The next save is a new revision: measured again from nothing.
    const at = (await s.tenant((tx) => dashboards.workingCopy(tx, maya(), id)))?.draftAt ?? null;
    expect(await save("Two", at)).toMatchObject({ ok: true });
    expect(await s.tenant((tx) => renderCheckOf(tx, maya(), id))).toBeNull();
  });
});

describe("a plan not built yet", () => {
  it("waits in its asker's list until Build it makes the dashboard, and never in anyone else's", async () => {
    const { plannedDashboards, startDashboard } = dashboards;
    const thread = uuidv7();
    const message = uuidv7();
    const run = uuidv7();
    await s.t.owner`insert into app.thread (org_id, id, connection_id, created_by, title, channel, visibility)
      values (${s.orgId}, ${thread}, ${s.connectionId}, ${s.userId}, 'Plan', 'web', 'private')`;
    await s.t.owner`insert into app.message (org_id, id, thread_id, seq, role, author_id, content, text)
      values (${s.orgId}, ${message}, ${thread}, 1, 'user', ${s.userId}, ${s.t.owner.json({ role: "user", content: "Plan it" })},
        'Plan it')`;
    const plan = {
      kind: "dashboard_plan",
      dashboardId: null,
      title: "Support queue",
      purpose: "Open tickets",
      pages: [],
    };
    await s.t
      .owner`insert into app.run (org_id, id, thread_id, connection_id, trigger, input_message_id, model, status, outcome)
      values (${s.orgId}, ${run}, ${thread}, ${s.connectionId}, 'user', ${message}, 'claude-haiku-5-5', 'succeeded',
        ${s.t.owner.json(plan)})`;
    const mine = await s.tenant((tx) => plannedDashboards(tx, maya()));
    expect(mine).toEqual([expect.objectContaining({ threadId: thread, runId: run, title: "Support queue" })]);
    expect(await s.tenant((tx) => plannedDashboards(tx, asBob()))).toEqual([]);
    await s.tenant((tx) => startDashboard(tx, maya(), { threadId: thread, planRunId: run, plan }));
    expect(await s.tenant((tx) => plannedDashboards(tx, maya()))).toEqual([]);
    // Built by a whole save instead (no link to the plan): made in its conversation after it, so not planned either.
    const other = uuidv7();
    const asked = uuidv7();
    const planned = uuidv7();
    await s.t.owner`insert into app.thread (org_id, id, connection_id, created_by, title, channel, visibility)
      values (${s.orgId}, ${other}, ${s.connectionId}, ${s.userId}, 'Plan 2', 'web', 'private')`;
    await s.t.owner`insert into app.message (org_id, id, thread_id, seq, role, author_id, content, text)
      values (${s.orgId}, ${asked}, ${other}, 1, 'user', ${s.userId}, ${s.t.owner.json({ role: "user", content: "Plan" })}, 'Plan')`;
    await s.t
      .owner`insert into app.run (org_id, id, thread_id, connection_id, trigger, input_message_id, model, status, outcome)
      values (${s.orgId}, ${planned}, ${other}, ${s.connectionId}, 'user', ${asked}, 'claude-haiku-5-5', 'succeeded',
        ${s.t.owner.json({ ...plan, title: "Second" })})`;
    expect(await s.tenant((tx) => plannedDashboards(tx, maya()))).toEqual([
      expect.objectContaining({ runId: planned }),
    ]);
    await s.tenant((tx) => createDashboard(tx, maya(), { title: "Second", threadId: other }));
    expect(await s.tenant((tx) => plannedDashboards(tx, maya()))).toEqual([]);
  });
});

describe("a filtered workflow's requests", () => {
  it("lists a filter's values, a column's counts and a query's totals from the warehouse, and pages it as asked", async () => {
    const d = definition(s.connectionId);
    d.filters.f_country = { kind: "select", label: "Country", options: [], values: { from: "q_list" }, default: [] };
    Object.assign(d.queries.q_list as object, {
      rows: { conditions: true, pageSizes: [10, 20], totals: { id: "count" } },
    });
    (d.queries.q_list as { select: string[] }).select.push("is_test");
    const id = await s.tenant((tx) => createDashboard(tx, maya(), { title: "Workflow" }));
    const saved = await s.tenant((tx) => saveDraft(tx, maya(), id, { definition: d, parts: built, baseVersion: 0 }));
    if (!saved.ok) throw new Error(JSON.stringify(saved.problems));
    await s.tenant((tx) => publishDraft(tx, maya(), id, { revision: saved.revision }));
    const asking = (requests: dashboards.DashboardRequest[]) =>
      s.tenant((tx) =>
        dashboards.requestDashboardQueries({ boss: s.boss }, tx, maya(), {
          dashboardId: id,
          revision: saved.revision,
          requests,
          now: NOW,
        }),
      );
    const requests: dashboards.DashboardRequest[] = [
      { id: "lookup", lookup: "f_country", search: "U" },
      { id: "facet", facet: { query: "q_list", column: "country" }, where: [["country", "in", ["DE"]]] },
      { id: "totals", totals: "q_list", filters: { f_country: ["US"] } },
      { id: "rows", query: "q_list", pageSize: 10, filters: { f_country: ["US"] }, where: [["country", "in", ["US"]]] },
      // A yes-or-no column's values, and a choice of them: one predicate, never a list of booleans.
      { id: "bool", facet: { query: "q_list", column: "is_test" } },
      { id: "boolRows", query: "q_list", where: [["is_test", "in", ["false"]]] },
    ];
    expect((await asking(requests))?.every((a) => a.status === "queued")).toBe(true);
    await drain();
    const answers = await asking(requests);
    const byId = Object.fromEntries((answers ?? []).map((a) => [a.id, a]));
    const values = (a: (typeof answers & {})[number] | undefined, col: string) =>
      a?.status === "ok" ? (a.result.columns.find((c) => c.name === col)?.values ?? []) : [];
    // The twelve whole months the default period covers: US accounts, as SQL counts them.
    const from = "2025-10-01";
    const to = "2026-10-01";
    const us = await accountsBetween(from, to, "US");
    expect(values(byId.lookup, "country")).toContain("US");
    expect(values(byId.lookup, "country").every((c) => String(c).toUpperCase().includes("U"))).toBe(true);
    // A column's counts leave out its own condition: every country, not only DE.
    expect(values(byId.facet, "country").length).toBeGreaterThan(1);
    expect(values(byId.totals, "id")).toEqual([us]);
    expect(byId.rows?.status === "ok" ? byId.rows.result.rowCount : -1).toBe(Math.min(10, us));
    expect(byId.rows?.status === "ok" ? byId.rows.result.total : -1).toBe(us);
    expect(byId.bool?.status).toBe("ok");
    expect(byId.boolRows?.status).toBe("ok");
    // A page size the query doesn't declare, or a column it doesn't list, is refused, and nothing is queued for it.
    const refused = await asking([
      { id: "a", query: "q_list", pageSize: 30 },
      { id: "b", query: "q_list", where: [["email", "in", ["x"]]] },
    ]);
    expect(refused?.map((a) => a.status)).toEqual(["failed", "failed"]);
  });
});

describe("the records an App shows", () => {
  it("lists rows searched in their own columns, and draws a record's numbers only for its key", async () => {
    const d = definition(s.connectionId);
    Object.assign(d.queries.q_list as object, { search: true });
    d.queries.q_one = {
      source: { connection: s.connectionId, dataset: "accounts" },
      measures: { accounts: ["count"] },
      record: "id",
      filters: {},
    };
    const id = await s.tenant((tx) => createDashboard(tx, maya(), { title: "Accounts desk" }));
    const saved = await s.tenant((tx) => saveDraft(tx, maya(), id, { definition: d, parts: built, baseVersion: 0 }));
    if (!saved.ok) throw new Error(JSON.stringify(saved.problems));
    await s.tenant((tx) => publishDraft(tx, maya(), id, { revision: saved.revision }));
    const asking = (requests: dashboards.DashboardRequest[]) =>
      s.tenant((tx) =>
        dashboards.requestDashboardQueries({ boss: s.boss }, tx, maya(), {
          dashboardId: id,
          revision: saved.revision,
          requests,
          now: NOW,
        }),
      );
    const [first] = await s.source.query(
      `select id, name from public.accounts where not is_test and created_at >= '2025-10-01' and created_at < '2026-10-01'
       order by created_at desc limit 1`,
    );
    const key = Number(first?.id);
    const word = String(first?.name).slice(0, 4);
    const requests: dashboards.DashboardRequest[] = [
      { id: "searched", query: "q_list", search: word },
      // The record's own row (the list asked for one key, its key as the address has it: text) and its numbers.
      { id: "head", query: "q_list", record: String(key) },
      { id: "one", query: "q_one", record: key },
    ];
    expect((await asking(requests))?.every((a) => a.status === "queued")).toBe(true);
    await drain();
    const byId = Object.fromEntries(((await asking(requests)) ?? []).map((a) => [a.id, a]));
    const values = (a: dashboards.DashboardAnswer | undefined, col: string) =>
      a?.status === "ok" ? (a.result.columns.find((c) => c.name === col)?.values ?? []) : [];
    const names = values(byId.searched, "name").map(String);
    const countries = values(byId.searched, "country").map(String);
    expect(names.length).toBeGreaterThan(0);
    // Every row has the text in a column the list shows.
    names.forEach((n, i) => {
      expect(`${n} ${countries[i]}`.toLowerCase()).toContain(word.toLowerCase());
    });
    expect(values(byId.head, "id")).toEqual([key]);
    expect(values(byId.one, "accounts")).toEqual([1]);
    // Without a key a record's query isn't run; a query not drawn for a record takes none; nothing is queued.
    expect(await asking([{ id: "a", query: "q_one" }])).toEqual([
      { id: "a", status: "failed", error: "q_one is drawn for a record: say which." },
    ]);
    expect(await asking([{ id: "b", query: "q_count", record: key }])).toEqual([
      { id: "b", status: "failed", error: "q_count isn't drawn for a record." },
    ]);
    expect(await asking([{ id: "c", query: "q_count", search: "x" } as dashboards.DashboardRequest])).toEqual([
      { id: "c", status: "failed", error: "q_count isn't searched." },
    ]);
    // A key past what a number holds exactly would be another record: refused, never rounded.
    expect(await asking([{ id: "d", query: "q_one", record: "9007199254740993" }])).toEqual([
      { id: "d", status: "failed", error: "id is too large to match exactly." },
    ]);
  });
});

describe("a dashboard's own datasets (reading anything)", () => {
  it("reads the analyst's SQL like a dataset: through the worker and the gateway, personal data never returned", async () => {
    const connection = s.connectionId;
    const own = {
      version: 2 as const,
      title: "Own",
      filters: {},
      datasets: {
        t_signups: {
          connection,
          title: "Sign-ups",
          sql: "select id, country, created_at from public.accounts where not is_test",
          columns: [
            { name: "id", type: "number" as const },
            { name: "country", type: "string" as const },
            { name: "created_at", type: "time" as const },
          ],
          key: "id",
        },
        t_names: {
          connection,
          title: "Names",
          sql: "select id, name from public.accounts",
          columns: [
            { name: "id", type: "number" as const },
            { name: "name", type: "string" as const },
          ],
        },
      },
      queries: {
        q_by_country: {
          source: { connection, dataset: "t_signups" },
          measures: { n: ["count"] as ["count"] },
          by: ["country"],
          filters: {},
        },
        q_names: { source: { connection, dataset: "t_names" }, select: ["id", "name"], filters: {} },
      },
    };
    const id = await s.tenant((tx) => createDashboard(tx, maya(), { title: "Own" }));
    const saved = await s.tenant((tx) => saveDraft(tx, maya(), id, { definition: own, baseVersion: 0 }));
    expect(saved).toMatchObject({ ok: true });
    const rev = saved.ok ? saved.revision : "";
    const askOwn = (requests: dashboards.DashboardRequest[]) =>
      s.tenant((tx) =>
        dashboards.requestDashboardQueries({ boss: s.boss }, tx, maya(), {
          dashboardId: id,
          revision: rev,
          requests,
          now: NOW,
        }),
      );
    const answered = async (requests: dashboards.DashboardRequest[]) => {
      await askOwn(requests);
      await drain();
      return (await askOwn(requests)) ?? [];
    };

    // Counted by country, the way the analyst's SQL reads the table: every sign-up once.
    const [byCountry] = await answered([{ id: "a", query: "q_by_country" }]);
    expect(byCountry?.status).toBe("ok");
    const counts = byCountry?.status === "ok" ? (byCountry.result.columns[1]?.values as number[]) : [];
    expect(counts.reduce((a, b) => a + b, 0)).toBe(await accountsBetween("1900-01-01", "2100-01-01"));

    // A bar opens its rows: its group first, then every column the own dataset declares; the bar's country only.
    const [rows] = await answered([{ id: "b", drill: "q_by_country", group: { country: "DE" } }]);
    expect(rows?.status === "ok" ? rows.result.columns.map((c) => c.name) : []).toEqual([
      "country",
      "id",
      "created_at",
    ]);
    expect(rows?.status === "ok" ? new Set(rows.result.columns[0]?.values) : null).toEqual(new Set(["DE"]));

    // Names are personal data (marked so above): the gateway refuses to return them, from an own dataset as anywhere.
    const [column] = await s.t.owner<{ id: string }[]>`
      select c.id from app.catalog_object c join app.catalog_object t on t.org_id = c.org_id and t.id = c.parent_id
      where c.connection_id = ${connection} and c.kind = 'column' and c.name = 'name' and t.name = 'accounts'`;
    await s.tenant((tx) =>
      setColumnSensitivity(tx, { orgId: s.orgId, userId: s.userId }, connection, column?.id as string, true),
    );
    try {
      const [names] = await answered([{ id: "c", query: "q_names" }]);
      expect(names).toMatchObject({ status: "failed", error: expect.stringMatching(/personal data/) });
    } finally {
      // The released accounts dataset reads names too: unmarked again for the tests after this one.
      await s.tenant((tx) =>
        setColumnSensitivity(tx, { orgId: s.orgId, userId: s.userId }, connection, column?.id as string, false),
      );
    }
  });
});

describe("a dashboard's metrics", () => {
  it("reads a metric with its meaning: its time column, never a number about now under a period", async () => {
    const connection = s.connectionId;
    const withMetric = (filters: Record<string, string>, metric = "new_accounts") => ({
      version: 2 as const,
      title: "Metrics",
      filters: { f_period: { kind: "period" as const, label: "Period", default: "last_12_months" } },
      queries: {
        q_new: {
          source: { connection, dataset: "accounts" },
          measures: { n: ["metric", metric] as ["metric", string] },
          filters,
        },
      },
    });
    const id = await s.tenant((tx) => createDashboard(tx, maya(), { title: "Metrics" }));
    // A number about now (customer accounts) under a period: refused, and why.
    const now = await s.tenant((tx) =>
      saveDraft(tx, maya(), id, {
        definition: withMetric({ f_period: "created_at" }, "customer_accounts"),
        baseVersion: 0,
      }),
    );
    expect(now.ok ? [] : now.problems.map((p) => p.message).join(" ")).toMatch(/a number about now/);
    // New accounts by its own time column: the same count as the table's.
    const saved = await s.tenant((tx) =>
      saveDraft(tx, maya(), id, { definition: withMetric({ f_period: "created_at" }), baseVersion: 0 }),
    );
    expect(saved).toMatchObject({ ok: true });
    const rev = saved.ok ? saved.revision : "";
    const askIt = () =>
      s.tenant((tx) =>
        dashboards.requestDashboardQueries({ boss: s.boss }, tx, maya(), {
          dashboardId: id,
          revision: rev,
          requests: [{ id: "a", query: "q_new" }],
          now: NOW,
        }),
      );
    await askIt();
    await drain();
    const [a] = (await askIt()) ?? [];
    expect(a).toMatchObject({ status: "ok" });
    expect(a?.status === "ok" ? a.result.columns[0]?.values : null).toEqual([
      await accountsBetween("2025-10-01", "2026-10-01"),
    ]);
  });
});

describe("a published dashboard reading what isn't released", () => {
  it("reads it at the version it was published with: a later edit to the draft changes the draft only", async () => {
    const connection = s.connectionId;
    // An unreleased copy of accounts, its checks passed: readable, as unverified.
    const [acc] = await s.t.owner<{ id: string; released_version: number }[]>`
      select id, released_version from app.context_item
      where org_id = ${s.orgId} and connection_id = ${connection} and kind = 'dataset' and slug = 'accounts'`;
    const copyId = uuidv7();
    await s.t.owner`
      insert into app.context_item
      select (jsonb_populate_record(null::app.context_item, to_jsonb(i) || jsonb_build_object(
        'id', ${copyId}::uuid, 'slug', 'accounts_draft', 'path', i.path || '-draft', 'title', 'Accounts (draft)',
        'status', 'proposed', 'current_version', 1, 'released_version', null, 'verified_by', null, 'verified_at', null))).*
      from app.context_item i where i.id = ${acc?.id ?? ""}::uuid`;
    const version = (n: number, where: string) => s.t.owner`
      insert into app.context_item_version
      select (jsonb_populate_record(null::app.context_item_version, to_jsonb(v) || jsonb_build_object(
        'item_id', ${copyId}::uuid, 'version', ${n}::int,
        'spec', jsonb_set(jsonb_set(v.spec, '{ref}', '"accounts_draft"'), '{sql}',
          to_jsonb((v.spec->>'sql') || ${where}::text)),
        'derived', jsonb_build_object('status', 'passed')))).*
      from app.context_item_version v where v.item_id = ${acc?.id ?? ""}::uuid and v.version = ${acc?.released_version ?? 0}`;
    await version(1, "");
    const def = {
      version: 2 as const,
      title: "Pinned",
      filters: {},
      queries: {
        q_n: {
          source: { connection, dataset: "accounts_draft" },
          measures: { n: ["count"] as ["count"] },
          filters: {},
        },
      },
    };
    const id = await s.tenant((tx) => createDashboard(tx, maya(), { title: "Pinned" }));
    const saved = await s.tenant((tx) => saveDraft(tx, maya(), id, { definition: def, parts: built, baseVersion: 0 }));
    const rev = saved.ok ? saved.revision : "";
    await s.tenant((tx) => publishDraft(tx, maya(), id, { revision: rev }));
    const [pinned] = await s.t.owner<{ pins: Record<string, number> }[]>`
      select pins from app.dashboard_version where dashboard_id = ${id} and version = 1`;
    expect(pinned?.pins).toEqual({ [copyId]: 1 });
    const count = async (now: Date) => {
      const askIt = () =>
        s.tenant((tx) =>
          dashboards.requestDashboardQueries({ boss: s.boss }, tx, maya(), {
            dashboardId: id,
            revision: rev,
            requests: [{ id: "a", query: "q_n" }],
            now,
          }),
        );
      await askIt();
      await drain();
      const [a] = (await askIt()) ?? [];
      return a?.status === "ok" ? a.result.columns[0]?.values[0] : a;
    };
    const before = await count(NOW);
    expect(before).toBeGreaterThan(0);
    // Someone edits the draft dataset (its checks pass): it now reads nothing. The published version doesn't move.
    await version(2, " and false");
    await s.t.owner`update app.context_item set current_version = 2 where id = ${copyId}::uuid`;
    // A fresh answer (the next freshness bucket), read as the published version reads it.
    expect(await count(new Date(NOW.getTime() + 3_600_000))).toBe(before);
    const live = await s.tenant((tx) => dashboards.dashboardCatalog(tx, s.orgId, connection));
    expect(live?.datasets.get("accounts_draft")?.version).toBe(2);

    // Edited again, its checks not done: the draft can't be read, and a publish waits rather than pin nothing.
    await version(3, "");
    await s.t.owner`update app.context_item_version set derived = null where item_id = ${copyId}::uuid and version = 3`;
    await s.t.owner`update app.context_item set current_version = 3 where id = ${copyId}::uuid`;
    const again = await s.tenant((tx) =>
      saveDraft(tx, maya(), id, { definition: { ...def, title: "Pinned again" }, baseVersion: 1 }),
    );
    expect(again).toMatchObject({ ok: false });
    await s.t
      .owner`update app.context_item_version set derived = '{"status": "passed"}' where item_id = ${copyId}::uuid and version = 3`;
    const saved3 = await s.tenant((tx) =>
      saveDraft(tx, maya(), id, { definition: { ...def, title: "Pinned again" }, parts: built, baseVersion: 1 }),
    );
    const rev3 = saved3.ok ? saved3.revision : "";
    await s.t.owner`update app.context_item_version set derived = null where item_id = ${copyId}::uuid and version = 3`;
    await expect(s.tenant((tx) => publishDraft(tx, maya(), id, { revision: rev3 }))).rejects.toThrow(
      /accounts_draft isn't checked right now/,
    );
  });
});
