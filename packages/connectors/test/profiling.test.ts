// The shared profiling rules that decide how fresh a table is: which time columns count, and which values.
import { describe, expect, it } from "vitest";
import type { ColumnInfo, RelationInfo } from "../src/catalog-types";
import {
  buildColumnProfile,
  type ColumnProfile,
  findJoins,
  freshnessColumns,
  isFreshnessValue,
  joinCandidates,
  newJoinChecks,
  parseDataTime,
  sensitivityOf,
} from "../src/profiling";

describe("data timestamps", () => {
  it("reads each dialect's text form as an instant", () => {
    expect(parseDataTime("2026-10-07 23:00:00+00")).toBe("2026-10-07T23:00:00.000Z");
    expect(parseDataTime("2026-10-07 23:00:00.123456+02")).toBe("2026-10-07T21:00:00.123Z");
    expect(parseDataTime("2026-10-07 23:00:00+0530")).toBe("2026-10-07T17:30:00.000Z");
    expect(parseDataTime("2026-10-07 23:00:00.000")).toBe("2026-10-07T23:00:00.000Z");
    expect(parseDataTime("2026-10-07T23:00:00Z")).toBe("2026-10-07T23:00:00.000Z");
    expect(parseDataTime("2026-10-07")).toBe("2026-10-07T00:00:00.000Z");
  });

  it("ignores anything that isn't a time", () => {
    for (const v of [null, "", "42", "Oct 7", "2026-13-45", "2026-10-07 25:99:00"]) expect(parseDataTime(v)).toBeNull();
  });

  it("counts a latest value as freshness only if it isn't in the future", () => {
    const now = Date.parse("2026-10-10T09:00:00Z");
    expect(isFreshnessValue("2026-10-07 23:00:00+00", now)).toBe(true);
    // A few hours ahead: likely a timestamp stored without its zone, still data so far.
    expect(isFreshnessValue("2026-10-10 13:00:00", now)).toBe(true);
    expect(isFreshnessValue("2026-10-24 08:18:35.679+00", now)).toBe(false);
    expect(isFreshnessValue("not a time", now)).toBe(false);
  });
});

describe("freshness columns", () => {
  const col = (name: string, extra: Partial<ColumnInfo> = {}): ColumnInfo =>
    ({ name, temporal: true, textual: false, numeric: false, ...extra }) as ColumnInfo;
  const relation = (columns: ColumnInfo[]) => ({ schema: "public", name: "t", columns }) as unknown as RelationInfo;
  const profiles = (columns: ColumnInfo[], pii: string[] = []) =>
    Object.fromEntries(
      columns.map((c) => [c.name, { sensitivity: pii.includes(c.name) ? "pii" : "none" } as ColumnProfile]),
    );

  it("prefers updated, then created, and skips planned times and personal data", () => {
    const columns = [
      col("trial_ends_at"),
      col("period_end"),
      col("expires_at"),
      col("next_billing_at"),
      col("birth_date"),
      col("created_at"),
      col("updated_at"),
      col("ended_at"),
      col("plan", { temporal: false }),
    ];
    const picked = freshnessColumns(relation(columns), profiles(columns, ["birth_date"])).map((c) => c.name);
    expect(picked).toEqual(["updated_at", "created_at"]);
    const onlyEnded = [col("ended_at"), col("trial_ends_at")];
    expect(freshnessColumns(relation(onlyEnded), profiles(onlyEnded)).map((c) => c.name)).toEqual(["ended_at"]);
  });
});

describe("an admin's personal-data choice", () => {
  const text = (name: string) => ({ name, textual: true, temporal: false, numeric: false }) as ColumnInfo;
  const profileOf = (name: string, raw: string[], choice?: "none" | "pii") =>
    buildColumnProfile({
      column: text(name),
      raw,
      sampled: raw.length,
      rows: raw.length,
      unique: false,
      options: { sampleRows: 100, categoryMaxNdv: 50, ...(choice ? { sensitivity: { [name]: choice } } : {}) },
    });
  const plans = Array.from({ length: 20 }, (_, i) => ["starter", "growth", "scale"][i % 3] as string);
  const tokens = Array.from({ length: 20 }, (_, i) => `sk_live_${"a1B2c3D4e5F6g7H8i9J0".slice(i % 5)}${i}xYz9QwErTy`);

  it("replaces detection: marked personal keeps no values, cleared is profiled", () => {
    expect(profileOf("plan", plans, "pii")).toMatchObject({
      sensitivity: "pii",
      sensitivityReason: "marked by an admin",
    });
    expect(profileOf("plan", plans, "pii").top).toBeUndefined();
    const cleared = profileOf("full_name", plans, "none");
    expect(cleared.sensitivity).toBe("none");
    expect(cleared.top).toBeDefined();
  });

  it("never clears a column whose values look like secrets", () => {
    expect(profileOf("note", tokens).sensitivity).toBe("secret");
    const overridden = profileOf("note", tokens, "none");
    expect(overridden.sensitivity).toBe("secret");
    expect(overridden.top).toBeUndefined();
  });
});

describe("an identifier", () => {
  const column = (name: string) => ({ name, textual: true, temporal: false, numeric: false }) as ColumnInfo;
  // Numeric ids stored as text used to read as phone numbers, so nobody could group by them.
  const numeric = ["10012345", "10023456", "10034567", "10045678", "10056789"];
  const objectIds = [
    "652f1c9e8b3e4a0012ab34cd",
    "652f1c9e8b3e4a0012ab34ce",
    "652f1c9e8b3e4a0012ab34cf",
    "652f1c9e8b3e4a0012ab34d0",
    "652f1c9e8b3e4a0012ab34d1",
  ];

  it("isn't a phone number or a key because of its values", () => {
    for (const name of ["org_id", "id", "account_uuid", "orgId", "customer_ids"]) {
      expect(sensitivityOf(column(name), numeric).sensitivity).toBe("none");
      expect(sensitivityOf(column(name), objectIds).sensitivity).toBe("none");
    }
    // Not an id by its name: the same values still read as a phone number and a key.
    expect(sensitivityOf(column("reference"), numeric).sensitivity).toBe("pii");
    expect(sensitivityOf(column("reference"), objectIds).sensitivity).toBe("secret");
  });

  it("is still personal or secret when its name says so, or its values are emails", () => {
    expect(sensitivityOf(column("caller_id"), numeric).sensitivity).toBe("pii");
    expect(sensitivityOf(column("msisdn"), numeric).sensitivity).toBe("pii");
    // WhatsApp's ids are phone numbers without a "+": digits alone can't tell them from an org's id, so names do.
    for (const name of ["wa_id", "whatsapp_id", "telephone"]) {
      expect(sensitivityOf(column(name), numeric).sensitivity).toBe("pii");
    }
    for (const name of ["session_id", "reset_token_id", "apiKeyId", "invitation_id"]) {
      expect(sensitivityOf(column(name), objectIds).sensitivity).toBe("secret");
    }
    // An author's id is an id, not an auth token.
    expect(sensitivityOf(column("author_id"), objectIds).sensitivity).toBe("none");
    const emails = ["ana@acme.io", "ben@acme.io", "cy@acme.io", "dee@acme.io", "eve@acme.io"];
    expect(sensitivityOf(column("user_id"), emails).sensitivity).toBe("pii");
  });

  it("is judged by its values when they aren't in a shape ids come in (fail closed)", () => {
    // Formatted phone numbers, a hex digest, API keys: named like ids, still personal or secret.
    const phones = ["+49 170 1234567", "+49 171 2345678", "+49 172 3456789", "+49 173 4567890", "+49 174 5678901"];
    expect(sensitivityOf(column("contact_id"), phones).sensitivity).toBe("pii");
    const digests = Array.from({ length: 5 }, (_, i) => `9f86d081884c7d659a2feaa0c55ad01${i}`);
    expect(sensitivityOf(column("org_id"), digests).sensitivity).toBe("secret");
    const stripe = Array.from({ length: 5 }, (_, i) => `sk_live_51HcXy${i}abcdefghijklmnopqrstuv`);
    expect(sensitivityOf(column("stripe_id"), stripe).sensitivity).toBe("secret");
    // A well-known key is a secret in any column, whatever its name or length.
    const github = Array.from({ length: 5 }, (_, i) => `ghp_${i}AbCdEfGhIjKlMnOpQrStUvWxYz0123456789`);
    expect(sensitivityOf(column("note"), github).sensitivity).toBe("secret");
    // One value that isn't an id is enough to judge the column by its values.
    const mixed = [...objectIds.slice(0, 4), "sk_test_1234567890abcdefghijkl"];
    expect(sensitivityOf(column("org_id"), mixed).sensitivity).toBe("secret");
  });
});

describe("a person's name", () => {
  const column = (name: string, textual = true) =>
    ({ name, textual, temporal: false, numeric: !textual }) as ColumnInfo;
  const names = ["Anna Schmidt", "Lars Berg", "Mia Wolf", "Jonas Klein", "Lea Vogel"];

  it("is personal data: who someone is in the row, or the name on a table of people", () => {
    for (const name of ["contact", "contact_name", "owner", "owner_name", "assignee", "author", "employee_name"]) {
      expect(sensitivityOf(column(name), names)).toEqual({ sensitivity: "pii", reason: "a person's name" });
    }
    expect(sensitivityOf(column("name"), names, "users").sensitivity).toBe("pii");
    expect(sensitivityOf(column("display_name"), names, "crm_contacts").sensitivity).toBe("pii");
  });

  it("isn't a company's name, an id, or a name on any other table", () => {
    for (const name of ["customer_name", "account_name", "company_name", "plan_name", "project_name"]) {
      expect(sensitivityOf(column(name), ["Acme GmbH", "badenova", "Globex"]).sensitivity).toBe("none");
    }
    expect(sensitivityOf(column("owner_id"), ["u1", "u2"]).sensitivity).toBe("none");
    expect(sensitivityOf(column("owner", false), []).sensitivity).toBe("none");
    expect(sensitivityOf(column("name"), ["Pro", "Basic"], "plans").sensitivity).toBe("none");
    expect(sensitivityOf(column("name"), ["Acme GmbH"], "customers").sensitivity).toBe("none");
  });
});

describe("joins nobody declared", () => {
  const col = (name: string, type = "String") =>
    ({
      name,
      ordinal: 1,
      type,
      textual: true,
      temporal: false,
      numeric: false,
      nullable: true,
      comment: null,
    }) as ColumnInfo;
  const rel = (name: string, columns: string[], extra: Partial<RelationInfo> = {}): RelationInfo => ({
    schema: "app",
    name,
    kind: "table",
    comment: null,
    rowsEstimate: null,
    analyzed: false,
    columns: columns.map((c) => col(c)),
    primaryKey: [],
    uniques: [],
    foreignKeys: [],
    ...extra,
  });
  // A common warehouse shape: usage metrics by org, and organizations as a view with no declared key.
  const usage = rel("feature_usage", ["org_id", "metric", "value"]);
  const catalog = {
    schemas: [{ name: "app", comment: null }],
    truncated: false,
    relations: [
      usage,
      rel("organizations", ["org_id", "name"], { kind: "view" }),
      rel("active_organizations", ["org_id", "name"], { kind: "view" }),
      rel("events", ["org_id", "kind"]),
      rel("plans", ["plan_code", "name"], { primaryKey: ["plan_code"] }),
      rel("accounts", ["id", "name"], { primaryKey: ["id"] }),
    ],
  };

  it("names the tables a column may join to, best first: its own name, then a subset, never just a shared column", () => {
    const found = joinCandidates(col("org_id"), usage, catalog).map((c) => `${c.target.name}.${c.key}`);
    expect(found).toEqual(["organizations.org_id", "active_organizations.org_id"]);
    // A shared column alone (events.org_id) isn't a join target: it isn't named for orgs, nor its declared key.
    expect(found).not.toContain("events.org_id");
    // Short and long names both ways, camelCase, and a declared key with the very name.
    expect(joinCandidates(col("acct_id"), usage, catalog).map((c) => c.target.name)).toEqual(["accounts"]);
    expect(joinCandidates(col("orgId"), usage, catalog)[0]?.target.name).toBe("organizations");
    expect(joinCandidates(col("plan_code"), usage, catalog).map((c) => `${c.target.name}.${c.key}`)).toEqual([
      "plans.plan_code",
    ]);
    // A table's own id names nothing else.
    expect(joinCandidates(col("id"), usage, catalog)).toEqual([]);
  });

  it("keeps the first full match as the join, a smaller one as partial, and checks a key once per sync", async () => {
    const columns = { org_id: { roles: [], sensitivity: "none" } } as unknown as Record<string, ColumnProfile>;
    const checks = newJoinChecks();
    const uniques: string[] = [];
    const run = (into: Record<string, ColumnProfile>) =>
      findJoins({
        relation: usage,
        catalog,
        columns: into,
        checks,
        declaredKeysUnique: false,
        unique: async (target) => {
          uniques.push(target.name);
          return true;
        },
        // organizations holds every org; active_organizations only the active ones.
        overlap: async (_c, target) => ({ n: 100, matched: target.name === "organizations" ? 100 : 11 }),
      });
    await run(columns);
    expect(columns.org_id?.references).toMatchObject({ table: "organizations", column: "org_id", overlap: 1 });
    expect(columns.org_id?.roles).toContain("foreign_key");
    // Organizations ranks first and matches fully, so the subset isn't checked for this column.
    expect(columns.org_id?.partialJoins).toBeUndefined();
    // Another table pointing at organizations reuses the check.
    await run({ org_id: { roles: [], sensitivity: "none" } } as unknown as Record<string, ColumnProfile>);
    expect(uniques).toEqual(["organizations"]);
  });

  it("keeps a subset as a partial join when nothing matches fully, and stops at the sync's budget", async () => {
    const columns = { org_id: { roles: [], sensitivity: "none" } } as unknown as Record<string, ColumnProfile>;
    await findJoins({
      relation: usage,
      catalog,
      columns,
      checks: newJoinChecks(),
      declaredKeysUnique: false,
      unique: async () => true,
      overlap: async (_c, target) => ({ n: 100, matched: target.name === "organizations" ? 60 : 11 }),
    });
    expect(columns.org_id?.references).toBeUndefined();
    expect(columns.org_id?.partialJoins).toEqual([
      { schema: "app", table: "organizations", column: "org_id", overlap: 0.6 },
      { schema: "app", table: "active_organizations", column: "org_id", overlap: 0.11 },
    ]);
    const none = { org_id: { roles: [], sensitivity: "none" } } as unknown as Record<string, ColumnProfile>;
    let asked = 0;
    await findJoins({
      relation: usage,
      catalog,
      columns: none,
      checks: newJoinChecks(0),
      declaredKeysUnique: false,
      unique: async () => {
        asked += 1;
        return true;
      },
      overlap: async () => ({ n: 1, matched: 1 }),
    });
    expect(asked).toBe(0);
    expect(none.org_id?.references).toBeUndefined();
  });
});
