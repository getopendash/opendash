// The migrator as containers run it: several at once apply each migration once, and a database that
// wasn't bootstrapped is refused, naming what's missing, before any migration runs.
import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { migrationsFolder, runMigrations } from "../src/migrate";
import { bootstrappedDatabase } from "./harness";

const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8")) as {
  entries: unknown[];
};

describe("migrations", () => {
  it("apply once when three containers start together", async () => {
    const db = await bootstrappedDatabase();
    try {
      await Promise.all([runMigrations(db.ownerUrl), runMigrations(db.ownerUrl), runMigrations(db.ownerUrl)]);
      const [row] = await db.admin<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`;
      expect(row?.n).toBe(journal.entries.length);
      // And a later boot finds nothing to apply.
      await runMigrations(db.ownerUrl);
      const [again] = await db.admin<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`;
      expect(again?.n).toBe(journal.entries.length);
    } finally {
      await db.drop();
    }
  });

  it("keep other roles on the server out of OpenDash's database", async () => {
    const db = await bootstrappedDatabase();
    const role = `opendash_outsider_t_${Math.random().toString(16).slice(2, 8)}`;
    try {
      await db.admin.unsafe(`create role ${role} login password 'pw'`);
      const url = new URL(db.ownerUrl);
      url.username = role;
      url.password = "pw";
      const outsider = postgres(url.toString(), { max: 1, onnotice: () => {} });
      await expect(outsider`select 1`).rejects.toThrow(/permission denied for database/);
      await outsider.end();
      // OpenDash's own roles still connect.
      await runMigrations(db.ownerUrl);
    } finally {
      await db.admin.unsafe(`drop role if exists ${role}`);
      await db.drop();
    }
  });

  it("refuse a database without the extensions, naming them, before any migration", async () => {
    const db = await bootstrappedDatabase();
    try {
      await db.admin`drop extension btree_gin`;
      await expect(runMigrations(db.ownerUrl)).rejects.toThrow(
        /doesn't have the btree_gin extension\. Run the bootstrap/,
      );
      const [row] = await db.admin<{ n: number }[]>`
        select count(*)::int as n from information_schema.tables where table_schema = 'app'`;
      expect(row?.n).toBe(0);
    } finally {
      await db.drop();
    }
  });
});
