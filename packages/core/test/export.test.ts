// A data export: every app table is exported or left out on purpose; a workspace's export has what its asker can
// read and never another person's private work, a secret, or another workspace's rows; a person's own has what is
// theirs. Read back from the zip it streams.
import { type SystemTx, sql, type TenantCtx, type TenantTx, uuidv7 } from "@opendash/db";
import { createOrg, freshDatabase, type TestDatabase, withSystemOn, withTenantOn } from "@opendash/db/testing";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EXPORT_PAGE,
  EXPORTED,
  type ExportManifest,
  type ExportPart,
  exportArchive,
  exportFolder,
  NOT_EXPORTED,
} from "../src";

let t: TestDatabase;
const withSystem = <T>(fn: (tx: SystemTx) => Promise<T>) => withSystemOn(t.system, fn);
const deps = { withTenant: <T>(ctx: TenantCtx, fn: (tx: TenantTx) => Promise<T>) => withTenantOn(t.app, ctx, fn) };

const [acme, lumen] = [uuidv7(), uuidv7()];
const [maya, dave] = [uuidv7(), uuidv7()];
const ids = {
  connection: uuidv7(),
  mayaPrivate: uuidv7(),
  mayaShared: uuidv7(),
  davePrivate: uuidv7(),
  daveShared: uuidv7(),
  lumenThread: uuidv7(),
};
const runs: Record<string, string> = {};

async function conversation(
  orgId: string,
  connection: string,
  id: string,
  by: string,
  visibility: string,
  title: string,
) {
  const runId = uuidv7();
  runs[id] = runId;
  await withSystem(async (tx) => {
    await tx.execute(sql`
      insert into app.thread (org_id, id, connection_id, title, created_by, visibility)
      values (${orgId}, ${id}, ${connection}, ${title}, ${by}, ${visibility})`);
    await tx.execute(sql`
      insert into app.run (org_id, id, thread_id, model, status, prompt)
      values (${orgId}, ${runId}, ${id}, 'm', 'succeeded', '{"layers": ["internal"]}'::jsonb)`);
    await tx.execute(sql`
      insert into app.query_run (id, org_id, connection_id, requester_type, requester_id, mode, compiled_sql, sql_hash, status)
      values (${uuidv7()}, ${orgId}, ${connection}, 'run', ${runId}, 'execute', ${`select '${title}'`}, 'h', 'succeeded')`);
  });
}

async function unzip(parts: ExportPart[], extra: { name: string; json: unknown }[] = []) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of exportArchive(deps, parts, extra, new Date("2026-10-11T12:00:00Z"))) chunks.push(chunk);
  const files = unzipSync(Buffer.concat(chunks));
  const text = (name: string) => new TextDecoder().decode(files[name]);
  const rows = (name: string) =>
    text(name)
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { names: Object.keys(files), text, rows, all: () => Object.keys(files).map(text).join("\n") };
}

beforeAll(async () => {
  t = await freshDatabase();
  await createOrg(t, acme, "Acme");
  await createOrg(t, lumen, "Lumen");
  const lumenConnection = uuidv7();
  const secretId = uuidv7();
  await withSystem(async (tx) => {
    await tx.execute(sql`
      insert into app.secret (org_id, id, kind, key_version, nonce, ciphertext)
      values (${acme}, ${secretId}, 'connection', 1, 'bm9uY2U=', 'c2VjcmV0LWNpcGhlcnRleHQ=')`);
    await tx.execute(sql`
      insert into app.connection (org_id, id, name, dialect, secret_id)
      values (${acme}, ${ids.connection}, 'warehouse', 'postgres', ${secretId}),
             (${lumen}, ${lumenConnection}, 'lumen-warehouse', 'postgres', null)`);
  });
  await conversation(acme, ids.connection, ids.mayaPrivate, maya, "private", "Maya private");
  await conversation(acme, ids.connection, ids.mayaShared, maya, "org", "Maya shared");
  await conversation(acme, ids.connection, ids.davePrivate, dave, "private", "Dave private");
  await conversation(acme, ids.connection, ids.daveShared, dave, "org", "Dave shared");
  await conversation(lumen, lumenConnection, ids.lumenThread, maya, "org", "Lumen shared");
  await withSystem(async (tx) => {
    await tx.execute(sql`
      insert into app.dashboard (org_id, id, title, owner_id, visibility) values
        (${acme}, ${uuidv7()}, 'Dave private board', ${dave}, 'private'),
        (${acme}, ${uuidv7()}, 'Revenue board', ${dave}, 'org')`);
    await tx.execute(sql`
      insert into app.insight (org_id, id, connection_id, kind, period, title, summary, severity, dedupe_key, owner_id) values
        (${acme}, ${uuidv7()}, ${ids.connection}, 'anomaly', '2026-09-01', 'Dave own finding', 's', 1, ${`k-${uuidv7()}`}, ${dave}),
        (${acme}, ${uuidv7()}, ${ids.connection}, 'anomaly', '2026-09-01', 'Workspace finding', 's', 1, ${`k-${uuidv7()}`}, null)`);
    await tx.execute(sql`insert into app.member_pref (org_id, user_id, tz) values (${acme}, ${maya}, 'Europe/Berlin')`);
  });
}, 120_000);

afterAll(async () => {
  await t?.drop();
});

describe("what an export carries", () => {
  it("decides for every app table: exported, or left out with a reason", async () => {
    const tables = (
      await t.owner<{ relname: string }[]>`
        select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relkind in ('r', 'p') and not c.relispartition order by 1`
    ).map((r) => r.relname);
    const exported = EXPORTED.map((s) => s.table);
    expect(tables.filter((name) => !exported.includes(name) && !(name in NOT_EXPORTED))).toEqual([]);
    // Nothing listed twice, and nothing that isn't a table.
    expect(exported.filter((name) => name in NOT_EXPORTED)).toEqual([]);
    expect([...exported, ...Object.keys(NOT_EXPORTED)].filter((name) => !tables.includes(name))).toEqual([]);
    expect(new Set(exported).size).toBe(exported.length);
  });

  it("never exports a stored secret, and names no column that doesn't exist", async () => {
    expect(NOT_EXPORTED).toHaveProperty("secret");
    expect(NOT_EXPORTED).toHaveProperty("org_key");
    for (const spec of EXPORTED) {
      const columns = (
        await t.owner<{ attname: string }[]>`
          select a.attname from pg_attribute a
          where a.attrelid = ${`app.${spec.table}`}::regclass and a.attnum > 0 and not a.attisdropped`
      ).map((c) => c.attname);
      expect(
        (spec.omit ?? []).filter((c) => !columns.includes(c)),
        `${spec.table}: omitted columns exist`,
      ).toEqual([]);
      // A reference to a stored secret, or a token's hash, is always left out.
      const sensitive = columns.filter((c) => /secret_id$|_hash$|^hash$|ciphertext|wrapped_dek|nonce/.test(c));
      expect(
        sensitive.filter((c) => !(spec.omit ?? []).includes(c) && c !== "question_hash"),
        `${spec.table}: sensitive columns omitted`,
      ).toEqual([]);
    }
  });
});

describe("a workspace's export", () => {
  it("has what the asker can read: their own and what's shared, never another person's private work", async () => {
    const zip = await unzip(
      [{ kind: "workspace", orgId: acme, userId: maya, folder: "" }],
      [{ name: "members.json", json: [{ name: "Maya", role: "owner" }] }],
    );
    const titles = zip.rows("thread.ndjson").map((r) => r.title);
    expect(titles.sort()).toEqual(["Dave shared", "Maya private", "Maya shared"]);
    // The runs and queries follow their conversations.
    expect(
      zip
        .rows("run.ndjson")
        .map((r) => r.id)
        .sort(),
    ).toEqual([runs[ids.mayaPrivate], runs[ids.mayaShared], runs[ids.daveShared]].sort());
    const queries = zip.rows("query_run.ndjson").map((r) => r.compiled_sql);
    expect(queries).toHaveLength(3);
    expect(queries.join(" ")).not.toContain("Dave private");
    expect(zip.rows("dashboard.ndjson").map((r) => r.title)).toEqual(["Revenue board"]);
    expect(zip.rows("insight.ndjson").map((r) => r.title)).toEqual(["Workspace finding"]);
    // Nowhere in the zip: Dave's private work, another workspace, a secret, a run's prompt.
    const everything = zip.all();
    for (const absent of ["Dave private", "Dave own finding", "Lumen", "lumen-warehouse", "c2VjcmV0", "internal"]) {
      expect(everything, absent).not.toContain(absent);
    }
    expect(zip.rows("connection.ndjson")[0]).not.toHaveProperty("secret_id");
    expect(zip.rows("run.ndjson")[0]).not.toHaveProperty("prompt");
    // The files given beside the tables, and the manifest that closes it.
    expect(JSON.parse(zip.text("members.json"))).toEqual([{ name: "Maya", role: "owner" }]);
    const manifest = JSON.parse(zip.text("manifest.json")) as ExportManifest;
    expect(manifest.format).toBe("opendash-export/1");
    expect(manifest.files["thread.ndjson"]).toEqual({ rows: 3 });
    expect(manifest.notExported.secret).toMatch(/secrets/);
    expect(zip.names).not.toContain("member_pref.ndjson");
  });

  it("is what Dave can read when Dave asks", async () => {
    const zip = await unzip([{ kind: "workspace", orgId: acme, userId: dave, folder: "" }]);
    expect(
      zip
        .rows("thread.ndjson")
        .map((r) => r.title)
        .sort(),
    ).toEqual(["Dave private", "Dave shared", "Maya shared"]);
    expect(zip.rows("dashboard.ndjson")).toHaveLength(2);
    expect(zip.all()).not.toContain("Maya private");
  });

  it("reads a table larger than a page whole, in order, each row once", async () => {
    const n = EXPORT_PAGE + 37;
    await withSystem((tx) =>
      tx.execute(sql`
        insert into app.todo (org_id, id, title)
        select ${acme}::uuid, gen_random_uuid(), 'Task ' || g from generate_series(1, ${n}) g`),
    );
    const zip = await unzip([{ kind: "workspace", orgId: acme, userId: maya, folder: "" }]);
    const tasks = zip.rows("todo.ndjson").map((r) => String(r.id));
    expect(tasks).toHaveLength(n);
    expect(new Set(tasks).size).toBe(n);
    await t.owner`delete from app.todo where org_id = ${acme}`;
  });
});

describe("a person's own export", () => {
  it("has what they made and what is about them, in each of their workspaces, each in its folder", async () => {
    const zip = await unzip(
      [
        { kind: "person", orgId: acme, userId: maya, folder: "workspaces/Acme" },
        { kind: "person", orgId: lumen, userId: maya, folder: "workspaces/Lumen" },
      ],
      [{ name: "account.json", json: { name: "Maya" } }],
    );
    expect(
      zip
        .rows("workspaces/Acme/thread.ndjson")
        .map((r) => r.title)
        .sort(),
    ).toEqual(["Maya private", "Maya shared"]);
    expect(zip.rows("workspaces/Lumen/thread.ndjson").map((r) => r.title)).toEqual(["Lumen shared"]);
    expect(zip.rows("workspaces/Acme/member_pref.ndjson")).toEqual([expect.objectContaining({ tz: "Europe/Berlin" })]);
    expect(zip.rows("workspaces/Acme/query_run.ndjson")).toHaveLength(2);
    // Not the workspace's own: its sources, its settings.
    expect(zip.names).not.toContain("workspaces/Acme/connection.ndjson");
    expect(zip.all()).not.toMatch(/Dave (private|shared)/);
  });

  it("refuses anything that isn't a workspace and a person", async () => {
    const bad = exportArchive(deps, [{ kind: "person", orgId: "acme", userId: maya, folder: "" }]);
    await expect(bad.next()).rejects.toThrow(/workspace/);
  });

  it("names a workspace's folder safely", () => {
    expect(exportFolder("Acme & Sons, Inc.", "x")).toBe("Acme-Sons-Inc");
    expect(exportFolder("../../etc/passwd", "x")).toBe("etc-passwd");
    expect(exportFolder("∆∆∆", "workspace-1")).toBe("workspace-1");
  });
});
