import postgres from "postgres";
import { createDemoDatabase, type DemoPostgresOptions } from "../saas/demo-postgres";
import { grantLumenReader, type LumenOptions, seedLumen } from "./seed";

export interface DemoCommerceOptions extends DemoPostgresOptions, LumenOptions {}

/** The defaults: Lumen's own database and its read-only user. */
export const LUMEN_DATABASE = "opendash_demo_lumen";
export const LUMEN_READER = "opendash_lumen_reader";

/**
 * Lumen, the second sample company (a home-lighting brand with orders, returns, campaigns and stock), as its own
 * database on the Postgres server `adminUrl` points at, with a read-only user, like Acme. The data runs to
 * `options.asOf`: by default the end of yesterday (UTC), so it's always "up to recent days". What `pnpm demo:seed
 * --commerce` does (refreshing it).
 */
export async function seedDemoCommerce(
  adminUrl: string,
  options: DemoCommerceOptions,
): Promise<{ seeded: false } | { seeded: true; tables: number; rows: number; asOf: number }> {
  const created = await createDemoDatabase(adminUrl, options);
  if (created.skipped) return { seeded: false };
  const sql = postgres(created.url, { max: 1, onnotice: () => {} });
  try {
    const summary = await seedLumen(sql, options);
    await grantLumenReader(sql, options.reader);
    const counts = Object.values(summary.tables);
    return { seeded: true, tables: counts.length, rows: counts.reduce((a, b) => a + b, 0), asOf: summary.asOf };
  } finally {
    await sql.end();
  }
}
