// The audit chain: sealing gives each organization one unbroken chain, Verify finds the first link an edit broke, and
// exports carry the head.
import { audit } from "@opendash/core";
import type { RunAudit } from "@opendash/core/enterprise";
import { type SystemTx, sql, uuidv7 } from "@opendash/db";
import { createOrg, freshDatabase, type TestDatabase, withSystemOn, withTenantOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csvCell, exportAudit, seal, sealOrg, verifyChain } from "../src/audit";
import { chainStatus } from "../src/audit/verify";

let t: TestDatabase;
const withSystem = <T>(fn: (tx: SystemTx) => Promise<T>) => withSystemOn(t.system, fn);
const asTenant =
  (orgId: string): RunAudit =>
  (fn) =>
    withTenantOn(t.app, { orgId }, fn);

async function write(orgId: string, n: number) {
  for (let i = 0; i < n; i++) {
    await withTenantOn(t.app, { orgId }, (tx) =>
      audit(tx, {
        action: "member.role_changed",
        actor: { type: "user", name: "Maya Chen" },
        detail: { from: "member", to: "admin" },
      }),
    );
  }
}

/** Edits as the database's owner would, with the guard trigger off: what Verify exists to catch. */
async function asOwner(statement: string) {
  await t.owner.begin(async (q) => {
    await q.unsafe("alter table app.audit_log disable trigger audit_log_guard");
    await q.unsafe(statement);
    await q.unsafe("alter table app.audit_log enable trigger audit_log_guard");
  });
}

beforeAll(async () => {
  t = await freshDatabase();
});

afterAll(async () => {
  await t?.drop();
});

describe("sealing", () => {
  it("seals every row into one chain, and Verify walks it", async () => {
    const org = uuidv7();
    await createOrg(t, org, "Acme");
    await write(org, 5);
    expect(await seal(withSystem)).toEqual({ orgs: 1, rows: 5 });
    await write(org, 3);
    await seal(withSystem);
    const status = await chainStatus(asTenant(org), org);
    expect(status).toMatchObject({ seq: 8, unsealed: 0, total: 8 });
    expect(status.head).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyChain(asTenant(org), org)).toEqual({ ok: true, checked: 8, fromSeq: 1, head: status.head });
    // Nothing left: a second call seals nothing.
    expect(await seal(withSystem)).toEqual({ orgs: 0, rows: 0 });
  });

  it("keeps one unbroken chain while rows are written during sealing, in small batches", async () => {
    const org = uuidv7();
    await createOrg(t, org, "Lumen");
    const writing = write(org, 40);
    for (let i = 0; i < 12; i++) await sealOrg(withSystem, org, 4);
    await writing;
    while ((await chainStatus(asTenant(org), org)).unsealed > 0) await sealOrg(withSystem, org, 7);
    const result = await verifyChain(asTenant(org), org);
    expect(result).toMatchObject({ ok: true, checked: 40, fromSeq: 1 });
  });

  it("two sealers at once never fork the chain", async () => {
    const org = uuidv7();
    await createOrg(t, org, "Check Co");
    await write(org, 30);
    const results = await Promise.allSettled([sealOrg(withSystem, org, 30), sealOrg(withSystem, org, 30)]);
    const sealed = results.map((r) => (r.status === "fulfilled" ? r.value : 0));
    // One sealed all 30; the other found the head held and skipped (or found nothing left).
    expect(sealed.sort()).toEqual([0, 30]);
    expect(await verifyChain(asTenant(org), org)).toMatchObject({ ok: true, checked: 30 });
  });
});

describe("Verify finds what changed", () => {
  let org: string;
  const nth = async (seq: number) => {
    const [row] = await t.owner<{ id: string }[]>`select id from app.audit_log where org_id = ${org} and seq = ${seq}`;
    return row?.id as string;
  };

  beforeAll(async () => {
    org = uuidv7();
    await createOrg(t, org, "Acme");
    await write(org, 6);
    await seal(withSystem);
  });

  it("a row whose content was edited", async () => {
    const id = await nth(3);
    await asOwner(`update app.audit_log set actor_name = 'Someone else' where org_id = '${org}' and id = '${id}'`);
    const result = await verifyChain(asTenant(org), org);
    expect(result).toMatchObject({ ok: false, at: { id, seq: 3 }, reason: "Its content changed after it was sealed." });
    await asOwner(`update app.audit_log set actor_name = 'Maya Chen' where org_id = '${org}' and id = '${id}'`);
    expect((await verifyChain(asTenant(org), org)).ok).toBe(true);
  });

  it("a row removed from the middle", async () => {
    const id = await nth(4);
    await asOwner(`delete from app.audit_log where org_id = '${org}' and id = '${id}'`);
    const result = await verifyChain(asTenant(org), org);
    expect(result).toMatchObject({ ok: false, at: { seq: 5 }, reason: "Event 4 is missing before this one." });
  });

  it("the newest rows removed, behind the head", async () => {
    const other = uuidv7();
    await createOrg(t, other, "Lumen");
    await write(other, 4);
    await seal(withSystem);
    const [last] = await t.owner<{ id: string }[]>`select id from app.audit_log where org_id = ${other} and seq = 4`;
    await asOwner(`delete from app.audit_log where org_id = '${other}' and id = '${last?.id}'`);
    const result = await verifyChain(asTenant(other), other);
    expect(result).toMatchObject({ ok: false, reason: "The chain's head is event 4, but the last event found is 3." });
  });

  it("every row gone: aged out when its month's partition is gone too, tampering when it's still there", async () => {
    const quiet = uuidv7();
    await createOrg(t, quiet, "Check Co");
    await write(quiet, 3);
    await seal(withSystem);
    await asOwner(`delete from app.audit_log where org_id = '${quiet}'`);
    // Sealed this month, whose partition is still there: someone deleted the rows.
    expect(await verifyChain(asTenant(quiet), quiet)).toMatchObject({
      ok: false,
      reason: "The chain's head is event 3, but the last event found is none.",
    });
    // Sealed long ago, in a month retention has dropped: the chain is intact, nothing left to walk.
    await t.owner`update app.audit_chain set sealed_at = '2024-01-15T12:00:00Z' where org_id = ${quiet}`;
    expect(await verifyChain(asTenant(quiet), quiet)).toMatchObject({ ok: true, checked: 0, agedOut: true });
  });
});

describe("exports", () => {
  it("start with the chain head, and carry each row's place and hash", async () => {
    const org = uuidv7();
    await createOrg(t, org, "Acme");
    await write(org, 2);
    await seal(withSystem);
    const since = new Date(Date.now() - 3600_000);
    const collect = async (format: "csv" | "jsonl") => {
      const gen = exportAudit(asTenant(org), org, { format, since });
      let text = "";
      let next = await gen.next();
      while (!next.done) {
        text += next.value;
        next = await gen.next();
      }
      return { text, rows: next.value.rows };
    };
    const head = (await chainStatus(asTenant(org), org)).head;
    const jsonl = await collect("jsonl");
    const lines = jsonl.text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(jsonl.rows).toBe(2);
    expect(lines[0]).toMatchObject({ chain: { org, seq: 2, head } });
    expect(lines[2]).toMatchObject({ action: "member.role_changed", seq: 2, hash: head, actor: "Maya Chen" });
    const csv = await collect("csv");
    const csvLines = csv.text.trim().split("\n");
    expect(csvLines[0]?.startsWith("id,at,actor_type")).toBe(true);
    expect(csvLines[1]).toContain(head);
    expect(csvLines).toHaveLength(4);
  });

  it("defuses cells a spreadsheet would run", () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("-1+1")).toBe("'-1+1");
    expect(csvCell("Maya, Chen")).toBe('"Maya, Chen"');
    expect(csvCell(null)).toBe("");
  });
});

describe("the chain survives a purge", () => {
  it("starts again after an organization's history is purged", async () => {
    const org = uuidv7();
    await createOrg(t, org, "Acme");
    await write(org, 3);
    await seal(withSystem);
    await withTenantOn(t.app, { orgId: org }, async (tx) => {
      await tx.execute(sql`select app.purge_audit_log()`);
      await audit(tx, { action: "audit.purged", actor: { type: "user", name: "Maya Chen" }, detail: { rows: 3 } });
    });
    await seal(withSystem);
    const status = await chainStatus(asTenant(org), org);
    expect(status).toMatchObject({ seq: 1, total: 1 });
    expect(status.purgedAt).not.toBeNull();
    expect(await verifyChain(asTenant(org), org)).toMatchObject({ ok: true, checked: 1, fromSeq: 1 });
  });
});
