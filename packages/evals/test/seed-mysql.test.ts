// The demo company in MySQL: the same rows as in Postgres, the marker on public.plans, and a reader that can read and
// can't write.
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { demoRows } from "../src/saas/seed";
import { mysqlAvailable, type SeededMySql, seededMySql } from "../src/testing";

const up = await mysqlAvailable();
describe.skipIf(!up)("the demo company in MySQL", () => {
  let db: SeededMySql;
  beforeAll(async () => {
    db = await seededMySql();
  }, 300_000);
  afterAll(async () => {
    await db?.drop();
  });

  it("has every table with the Postgres seed's rows, readable by the reader and not writable", async () => {
    const conn = await mysql.createConnection({
      host: db.host,
      port: db.port,
      user: db.reader.user,
      password: db.reader.password,
      database: db.database,
    });
    try {
      for (const [name, rows] of demoRows()) {
        const [schema, table] = name.split(".") as [string, string];
        const [r] = (await conn.query(`select count(*) as n from \`${db.prefix}${schema}\`.\`${table}\``)) as [
          { n: number }[],
          unknown,
        ];
        expect(Number(r[0]?.n), name).toBe(rows.length);
      }
      const [c] = (await conn.query(
        "select table_comment as c from information_schema.tables where table_schema = database() and table_name = 'plans'",
      )) as [{ c: string }[], unknown];
      expect(c[0]?.c).toMatch(/^opendash:sample-data/);
      await expect(conn.query("update plans set name = 'x'")).rejects.toThrow(/denied/i);
    } finally {
      await conn.end();
    }
  });
});
