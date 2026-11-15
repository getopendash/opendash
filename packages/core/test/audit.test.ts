// The audit log's core: a row exactly when the action commits, who did it, names never values, rows that can't be
// changed, the page's filters, and how long rows are kept.
import { sql, uuidv7 } from "@opendash/db";
import { createOrg, freshDatabase, pgError, type TestDatabase, withSystemOn, withTenantOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUDIT_ACTIONS,
  type AuditDetail,
  AuditDetailError,
  actionsIn,
  audit,
  auditActors,
  auditLine,
  auditRetentionDays,
  auditSystem,
  checkedDetail,
  countAudit,
  listAudit,
} from "../src/audit";
import type { Enterprise, LicenseStatus } from "../src/enterprise";
import { removeSource } from "../src/sources/remove";
import { setSpendLimits } from "../src/usage/limits";

let t: TestDatabase;
const orgId = uuidv7();
const otherOrg = uuidv7();
const maya = uuidv7();
const since = new Date(Date.now() - 24 * 3600 * 1000);

beforeAll(async () => {
  t = await freshDatabase();
  await createOrg(t, orgId, "Acme");
  await createOrg(t, otherOrg, "Lumen");
  await t.auth.client`insert into auth.user (id, name, email, email_verified)
    values (${maya}, 'Maya Chen', 'maya@acme.test', true)`;
  await t.auth.client`insert into auth.member (id, organization_id, user_id, role, created_at)
    values (${uuidv7()}, ${orgId}, ${maya}, 'owner', now())`;
});

afterAll(async () => {
  await t?.drop();
});

const rowsOf = (org: string) =>
  withSystemOn(t.system, (tx) =>
    tx.execute<{
      action: string;
      actor_type: string;
      actor_id: string | null;
      actor_name: string | null;
      fields: string[];
    }>(
      sql`select action, actor_type, actor_id, actor_name, fields from app.audit_log where org_id = ${org} order by id`,
    ),
  );

describe("writing", () => {
  it("writes a row in the action's transaction, and none when it rolls back", async () => {
    await withTenantOn(t.app, { orgId, userId: maya }, (tx) =>
      audit(tx, {
        action: "source.updated",
        target: { type: "connection", name: "Warehouse" },
        fields: ["password"],
        detail: { dialect: "postgres" },
      }),
    );
    const before = (await rowsOf(orgId)).length;
    await expect(
      withTenantOn(t.app, { orgId, userId: maya }, async (tx) => {
        await audit(tx, { action: "source.deleted", detail: { dialect: "postgres" } });
        throw new Error("the action failed");
      }),
    ).rejects.toThrow("the action failed");
    const rows = await rowsOf(orgId);
    expect(rows).toHaveLength(before);
    expect(rows.at(-1)).toMatchObject({ action: "source.updated", fields: ["password"] });
  });

  it("takes the transaction's user as the actor, with their name as a member", async () => {
    await withTenantOn(t.app, { orgId, userId: maya }, (tx) =>
      audit(tx, { action: "sharing.updated", detail: { enabled: true } }),
    );
    expect((await rowsOf(orgId)).at(-1)).toMatchObject({ actor_type: "user", actor_id: maya, actor_name: "Maya Chen" });
  });

  it("is the system when the transaction has no user, and keeps an actor it's given", async () => {
    await withTenantOn(t.app, { orgId }, (tx) => audit(tx, { action: "slack.removed" }));
    expect((await rowsOf(orgId)).at(-1)).toMatchObject({ actor_type: "system", actor_id: null, actor_name: null });
    const keyId = uuidv7();
    await withTenantOn(t.app, { orgId, userId: maya }, (tx) =>
      audit(tx, {
        action: "ai_connection.created",
        actor: { type: "api_key", id: keyId, name: "Deploy key" },
        detail: { kind: "anthropic" },
      }),
    );
    expect((await rowsOf(orgId)).at(-1)).toMatchObject({
      actor_type: "api_key",
      actor_id: keyId,
      actor_name: "Deploy key",
    });
  });

  it("writes for a named organization as the system role", async () => {
    await withSystemOn(t.system, (tx) =>
      auditSystem(tx, otherOrg, {
        action: "signin.succeeded",
        actor: { type: "user", id: maya, name: "Maya Chen" },
        detail: { method: "password" },
        ip: "198.51.100.24",
        userAgent: "Firefox",
      }),
    );
    const [row] = await withSystemOn(t.system, (tx) =>
      tx.execute<{ ip: string; user_agent: string }>(
        sql`select host(ip) as ip, user_agent from app.audit_log where org_id = ${otherOrg}`,
      ),
    );
    expect(row).toEqual({ ip: "198.51.100.24", user_agent: "Firefox" });
  });

  it("refuses details that look like secrets or values, and fields that aren't names", () => {
    expect(() => checkedDetail({ password: "x" })).toThrow(AuditDetailError);
    expect(() => checkedDetail({ apiKey: "odo_123" })).toThrow(AuditDetailError);
    expect(() => checkedDetail({ query: "x".repeat(65) })).toThrow(AuditDetailError);
    expect(() => checkedDetail({ nested: { a: 1 } })).toThrow(AuditDetailError);
    expect(checkedDetail({ role: "admin", count: 3, on: true })).toEqual({ role: "admin", count: 3, on: true });
    return expect(
      withTenantOn(t.app, { orgId, userId: maya }, (tx) =>
        audit(tx, { action: "source.updated", fields: ["password = 'hunter2'"] }),
      ),
    ).rejects.toThrow(AuditDetailError);
  });

  it("every action's detail type carries no secret-looking key", () => {
    // The type is the contract; this keeps its keys honest. One sample detail per action, as the call sites write them.
    const samples: { [A in keyof AuditDetail]: AuditDetail[A] } = {
      "signin.succeeded": { method: "password" },
      "signin.failed": { method: "password", reason: "bad_credentials" },
      "signin.refused": { method: "password", reason: "sso_required" },
      "two_factor.enabled": {},
      "two_factor.disabled": {},
      "password.reset": {},
      "sessions.revoked": { count: 2 },
      "member.invited": { role: "viewer" },
      "invitation.cancelled": { role: "viewer" },
      "member.joined": { role: "member" },
      "member.role_changed": { from: "member", to: "admin" },
      "member.removed": { role: "member" },
      "member.left": { role: "member" },
      "api_key.created": { owner: "organization", expiresInDays: 90 },
      "api_key.revoked": { owner: "user", count: 1 },
      "source.created": { dialect: "postgres" },
      "source.updated": { dialect: "postgres" },
      "source.deleted": { dialect: "postgres" },
      "ai_connection.created": { kind: "anthropic" },
      "ai_connection.updated": { kind: "anthropic" },
      "ai_connection.deleted": { kind: "anthropic" },
      "spend_limit.updated": {},
      "sharing.updated": { enabled: false },
      "share_link.created": { kind: "report" },
      "share_link.revoked": { kind: "report" },
      "knowledge.approved": { kind: "learning" },
      "knowledge.published": { kind: "definition", version: 4 },
      "routine.created": { destinations: ["email", "slack"] },
      "routine.updated": { destinations: ["slack"] },
      "slack.installed": {},
      "slack.removed": {},
      "mcp_server.approved": { access: "personal", auth: "oauth" },
      "mcp_server.updated": { access: "shared", status: "active", dashboards: true },
      "mcp_server.removed": {},
      "mcp_tool.updated": { tool: "search_issues", tier: "ask", dashboards: false, reviewed: true },
      "mcp_tool.called": { tool: "transitionJiraIssue", via: "dashboard", outcome: "done" },
      "mcp_connection.connected": { scope: "personal", again: false },
      "mcp_connection.disconnected": { scope: "org" },
      "sso.provider_added": { protocol: "oidc", domain: "acme.com" },
      "sso.provider_updated": { protocol: "saml", domain: "acme.com" },
      "sso.secret_rotated": { protocol: "oidc" },
      "sso.domain_verified": { domain: "acme.com" },
      "sso.activated": { domain: "acme.com" },
      "sso.enforced": { domain: "acme.com", sessionsEnded: 14, keysRevoked: 3 },
      "sso.unenforced": { domain: "acme.com" },
      "sso.disabled": { domain: "acme.com", sessionsEnded: 23, by: "operator" },
      "sso.enabled": { domain: "acme.com" },
      "sso.provider_removed": { domain: "acme.com", sessionsEnded: 0 },
      "scim.connected": { expiresInDays: 365 },
      "scim.token_rotated": { expiresInDays: 365, ended: 1 },
      "scim.disconnected": { ended: 1 },
      "scim.mapping_updated": { role: "member" },
      "scim.refused": { reason: "domain_not_verified" },
      "scim.owner_kept": {},
      "audit.exported": { format: "csv", rows: 10, days: 90 },
      "audit.purged": { rows: 10 },
    };
    expect(Object.keys(samples).sort()).toEqual(Object.keys(AUDIT_ACTIONS).sort());
    for (const detail of Object.values(samples))
      expect(() => checkedDetail(detail as Record<string, unknown>)).not.toThrow();
  });
});

describe("rows can't be changed", () => {
  it("the app role can't update or delete a row, even its own organization's", async () => {
    const update = withTenantOn(t.app, { orgId }, (tx) =>
      tx.execute(sql`update app.audit_log set actor_name = 'Nobody'`),
    );
    expect((await pgError(update)).code).toBe("42501");
    const remove = withTenantOn(t.app, { orgId }, (tx) => tx.execute(sql`delete from app.audit_log`));
    expect((await pgError(remove)).code).toBe("42501");
  });

  it("the system role may set the chain columns once, and nothing else", async () => {
    const [row] = await withSystemOn(t.system, (tx) =>
      tx.execute<{ id: string }>(sql`select id from app.audit_log where org_id = ${orgId} order by id limit 1`),
    );
    const id = row?.id as string;
    const change = withSystemOn(t.system, (tx) =>
      tx.execute(
        sql`update app.audit_log set actor_name = 'Nobody', seq = 1, hash = '\\x01' where org_id = ${orgId} and id = ${id}`,
      ),
    );
    expect((await pgError(change)).message).toMatch(/only seq, prev_hash and hash/);
    await withSystemOn(t.system, (tx) =>
      tx.execute(sql`update app.audit_log set seq = 1, hash = '\\x01' where org_id = ${orgId} and id = ${id}`),
    );
    const again = withSystemOn(t.system, (tx) =>
      tx.execute(sql`update app.audit_log set seq = 2, hash = '\\x02' where org_id = ${orgId} and id = ${id}`),
    );
    expect((await pgError(again)).message).toMatch(/already sealed/);
    const remove = withSystemOn(t.system, (tx) => tx.execute(sql`delete from app.audit_log where org_id = ${orgId}`));
    expect((await pgError(remove)).code).toBe("42501");
  });

  it("an organization's purge removes its own rows only", async () => {
    const otherBefore = (await rowsOf(otherOrg)).length;
    const purged = await withTenantOn(t.app, { orgId }, (tx) =>
      tx.execute<{ n: string }>(sql`select app.purge_audit_log() as n`),
    );
    expect(Number(purged[0]?.n)).toBeGreaterThan(0);
    expect(await rowsOf(orgId)).toEqual([]);
    expect((await rowsOf(otherOrg)).length).toBe(otherBefore);
    // With no tenant context there's no organization to purge.
    await expect(t.app.client`select app.purge_audit_log()`).rejects.toMatchObject({ code: "42501" });
  });
});

describe("reading", () => {
  it("lists newest first, filters by person and group, and pages", async () => {
    const otherUser = uuidv7();
    await withTenantOn(t.app, { orgId, userId: maya }, async (tx) => {
      for (let i = 0; i < 3; i++)
        await audit(tx, { action: "member.role_changed", detail: { from: "member", to: "admin" } });
      await audit(tx, { action: "signin.succeeded", detail: { method: "password" } });
      await audit(tx, {
        action: "source.created",
        actor: { type: "user", id: otherUser, name: "Theo Lind" },
        detail: { dialect: "mysql" },
      });
    });
    const all = await withTenantOn(t.app, { orgId }, (tx) => listAudit(tx, { since }));
    expect(all.rows.map((r) => r.action)).toEqual([
      "source.created",
      "signin.succeeded",
      "member.role_changed",
      "member.role_changed",
      "member.role_changed",
    ]);
    const mine = await withTenantOn(t.app, { orgId }, (tx) =>
      listAudit(tx, { since, actorId: maya, category: "members" }),
    );
    expect(mine.rows).toHaveLength(3);
    const first = await withTenantOn(t.app, { orgId }, (tx) => listAudit(tx, { since, limit: 2 }));
    expect(first.rows).toHaveLength(2);
    const next = await withTenantOn(t.app, { orgId }, (tx) => listAudit(tx, { since, limit: 2, before: first.older }));
    expect(next.rows[0]?.id).not.toBe(first.rows[1]?.id);
    expect(await withTenantOn(t.app, { orgId }, (tx) => auditActors(tx, since))).toEqual([
      { id: maya, name: "Maya Chen" },
      { id: otherUser, name: "Theo Lind" },
    ]);
    expect(await withTenantOn(t.app, { orgId }, (tx) => countAudit(tx, since))).toBe(5);
    // The footer's count follows the page's filters.
    expect(
      await withTenantOn(t.app, { orgId }, (tx) => countAudit(tx, since, { actorId: maya, category: "members" })),
    ).toBe(3);
    // Another organization's reader sees none of it.
    const theirs = await withTenantOn(t.app, { orgId: otherOrg }, (tx) => listAudit(tx, { since }));
    expect(theirs.rows.every((r) => r.action === "signin.succeeded")).toBe(true);
  });

  it("says each action in words", () => {
    expect(actionsIn("signin")).toContain("two_factor.enabled");
    expect(auditLine("member.role_changed", { from: "member", to: "admin" })).toEqual({
      label: "Changed a role",
      note: "member → admin",
    });
    expect(auditLine("something.new", {})).toEqual({ label: "something.new", note: null });
  });
});

describe("retention", () => {
  const gate = (canChange: boolean, state: LicenseStatus["state"]): Enterprise => ({
    production: true,
    status: () => ({ state }) as LicenseStatus,
    canChange: () => canChange,
  });

  it("keeps 90 days unless the license allows longer", () => {
    expect(auditRetentionDays(gate(false, "none"), undefined)).toBe(90);
    expect(auditRetentionDays(gate(false, "none"), "3650")).toBe(90);
    expect(auditRetentionDays(gate(true, "valid"), "2000")).toBe(2000);
    expect(auditRetentionDays(gate(true, "valid"), "99999")).toBe(7 * 366);
    expect(auditRetentionDays(gate(true, "valid"), "30")).toBe(90);
  });

  it("drops nothing when the key that allowed longer lapsed", () => {
    expect(auditRetentionDays(gate(false, "expired"), "3650")).toBeNull();
    expect(auditRetentionDays(gate(false, "invalid"), "3650")).toBeNull();
    expect(auditRetentionDays(gate(false, "expired"), undefined)).toBe(90);
  });
});

describe("call sites", () => {
  const latest = async (action: string) =>
    (
      await withSystemOn(t.system, (tx) =>
        tx.execute<{
          actor_type: string;
          actor_id: string | null;
          target_name: string | null;
          fields: string[];
          detail: Record<string, unknown>;
        }>(
          sql`select actor_type, actor_id, target_name, fields, detail from app.audit_log
              where org_id = ${orgId} and action = ${action} order by id desc limit 1`,
        ),
      )
    )[0];

  it("removing a source is recorded with its name, in the same transaction", async () => {
    const id = uuidv7();
    await withSystemOn(t.system, (tx) =>
      tx.execute(
        sql`insert into app.connection (org_id, id, name, dialect) values (${orgId}, ${id}, 'Warehouse', 'postgres')`,
      ),
    );
    await withTenantOn(t.app, { orgId, userId: maya }, (tx) => removeSource(tx, { orgId }, id, "Warehouse"));
    expect(await latest("source.deleted")).toMatchObject({
      actor_id: maya,
      target_name: "Warehouse",
      detail: { dialect: "postgres" },
    });
  });

  it("spend limits set with an API key name the key", async () => {
    const keyId = uuidv7();
    await withTenantOn(t.app, { orgId }, (tx) =>
      setSpendLimits(
        tx,
        { orgId, userId: null, actor: { type: "api_key", id: keyId } },
        { monthlyUsd: 200, dailyUsd: 20 },
      ),
    );
    expect(await latest("spend_limit.updated")).toMatchObject({
      actor_type: "api_key",
      actor_id: keyId,
      fields: ["monthlyUsd", "dailyUsd"],
    });
  });
});
