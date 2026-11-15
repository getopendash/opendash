import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { bootstrap, isLocalDatabase } from "../src/bootstrap";
import { tenantPolicies } from "../src/schema/policies";

const render = (value: unknown) => new PgDialect().sqlToQuery(value as never).sql;

describe("tenant policy helper", () => {
  it("personal-scope tables check ownership on write, not just the org", () => {
    const [tenant] = tenantPolicies({ personalScope: true });
    const check = render(tenant?.withCheck);
    expect(check).toContain("org_id = (select app.org_id())");
    expect(check).toContain("scope_id = (select app.user_id())");
    expect(check).toBe(render(tenant?.using));
  });

  it("org-scoped tables use the same predicate for reads and writes", () => {
    const [tenant] = tenantPolicies();
    expect(render(tenant?.withCheck)).toBe(render(tenant?.using));
  });
});

describe("bootstrap credentials", () => {
  it("treats only this machine as local", () => {
    expect(isLocalDatabase("postgres://u:p@127.0.0.1:5444/db")).toBe(true);
    expect(isLocalDatabase("postgres://u:p@localhost/db")).toBe(true);
    expect(isLocalDatabase("postgres://u:p@db.example.neon.tech/db")).toBe(false);
  });

  it("refuses to bootstrap a remote database without explicit role passwords, before connecting", async () => {
    await expect(bootstrap("postgres://u:p@db.example.neon.tech:5432/db")).rejects.toThrow(/without passwords for/);
  });
});
