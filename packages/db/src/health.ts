import { sql } from "drizzle-orm";
import { getAppDatabase } from "./client";
import type { SystemTx, TenantTx } from "./tenant";

export const REQUIRED_EXTENSIONS = ["vector", "pg_trgm", "btree_gin"] as const;

/** Boot-time check: fail fast with a clear message if the database lacks an extension we rely on. */
export async function checkExtensions(tx: TenantTx | SystemTx): Promise<void> {
  const rows = await tx.execute<{ extname: string }>(sql`select extname from pg_extension`);
  const installed = new Set(rows.map((r) => r.extname));
  const missing = REQUIRED_EXTENSIONS.filter((ext) => !installed.has(ext));
  if (missing.length > 0) {
    throw new Error(
      `Postgres is missing extensions: ${missing.join(", ")}. Run \`pnpm --filter @opendash/db bootstrap\` as an admin, ` +
        "or use the pgvector/pgvector image (see infra/docker-compose.yml).",
    );
  }
}

/**
 * When the named dispatcher last ran, read through `app.last_tick()`, which the app's role may
 * call without reading the system's table. Null when it never ran; throws when the database can't be reached.
 */
export async function lastTick(name = "system.tick"): Promise<Date | null> {
  const [row] = await getAppDatabase().client<{ at: Date | string | null }[]>`select app.last_tick(${name}) as at`;
  return row?.at ? new Date(row.at) : null;
}
