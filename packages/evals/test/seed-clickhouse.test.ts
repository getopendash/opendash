// The demo company in ClickHouse keeps support tickets as warehouses often keep a table they're sent changes of
//: a ReplacingMergeTree where a solved ticket still has its earlier, open version, its merges stopped.
// Read with FINAL it's the Postgres table; counted without, a solved ticket is open too. Skipped when ClickHouse isn't up.
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { demoRows } from "../src/saas/seed";
import { clickhouseAvailable, type SeededClickHouse, seededClickHouse } from "../src/testing";

const available = await clickhouseAvailable();
let db: SeededClickHouse;

describe.skipIf(!available)("support tickets in ClickHouse", () => {
  beforeAll(async () => {
    db = await seededClickHouse();
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  it("read with FINAL are the seed's own; counted without, a ticket solved since counts as open too", async () => {
    const client = createClient({
      url: `http://${db.host}:${db.port}`,
      username: db.reader.user,
      password: db.reader.password,
    });
    try {
      const count = async (final: string) => {
        const r = await client.query({
          query: `select count() as n from \`${db.prefix}support\`.tickets${final} where status = 'open'`,
          format: "JSONEachRow",
        });
        return Number(((await r.json()) as { n: string }[])[0]?.n);
      };
      const tickets = demoRows().find(([name]) => name === "support.tickets")?.[1] ?? [];
      const open = tickets.filter((t) => t.status === "open").length;
      const solved = tickets.filter((t) => t.status === "solved").length;
      expect(solved).toBeGreaterThan(0);
      expect(await count(" final")).toBe(open);
      expect(await count("")).toBe(open + solved);
    } finally {
      await client.close();
    }
  });
});
