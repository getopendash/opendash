/**
 * A dashboard's own dataset, checked when it's saved: its SQL run once through the gateway as Ask's is (read-only,
 * learned tables only, personal columns never returned, new columns refused, the database's advice), asking for the
 * columns it declares, one row at most. What comes back types its columns; a column it doesn't return, or anything the
 * gateway refuses, is said in the gateway's words. It's run again by the same gateway whenever a query reads it.
 */
import type { SqlDataset } from "@opendash/apps/dashboard";
import { type DialectId, dialectFor, type ResultColumn } from "@opendash/connectors";
import { sql as q } from "@opendash/db";
import { type GatewayDeps, runQuery } from "../gateway/gateway";

type Checked = { ok: true; columns: SqlDataset["columns"] } | { ok: false; message: string };

/** A result column's type as a dataset column's. */
function typeOf(c: ResultColumn): SqlDataset["columns"][number]["type"] {
  if (c.type === "number") return "number";
  if (c.type === "date" || c.type === "timestamp") return "time";
  if (c.type === "boolean") return "boolean";
  return "string";
}

export async function probeOwnDataset(
  deps: GatewayDeps,
  input: {
    orgId: string;
    name: string;
    dataset: SqlDataset;
    requester: { type: "run" | "dashboard" | "api"; id: string | null };
    toolCallId?: string;
    signal?: AbortSignal;
  },
): Promise<Checked> {
  const { dataset: ds } = input;
  const [source] = await deps.withTenant(input.orgId, (tx) =>
    tx.execute<{ dialect: DialectId }>(
      q`select dialect from app.connection where org_id = ${input.orgId} and id = ${ds.connection} and deleted_at is null`,
    ),
  );
  if (!source) return { ok: false, message: "That source isn't there any more." };
  const b = dialectFor(source.dialect).sql;
  const body = ds.sql.trim().replace(/;\s*$/, "");
  const statement = [
    `with ${b.ident("__d")} as (\n${body}\n)`,
    `select ${ds.columns.map((c) => b.ident(c.name)).join(", ")} from ${b.ident("__d")}`,
    "limit 1",
  ].join("\n");
  const r = await runQuery(deps, {
    orgId: input.orgId,
    connectionId: ds.connection,
    sql: statement,
    mode: "execute",
    title: `Dashboard dataset · ${input.name}`,
    advise: true,
    requester: input.requester,
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (r.status !== "succeeded") {
    const e = r.error;
    return { ok: false, message: [e?.message ?? "The warehouse didn't answer.", e?.fix].filter(Boolean).join(" ") };
  }
  const got = new Map(r.columns.map((c) => [c.name.toLowerCase(), c]));
  const missing = ds.columns.filter((c) => !got.has(c.name.toLowerCase())).map((c) => c.name);
  if (missing.length) return { ok: false, message: `Its SQL doesn't return ${missing.join(", ")}.` };
  return {
    ok: true,
    columns: ds.columns.map((c) => ({ name: c.name, type: typeOf(got.get(c.name.toLowerCase()) as ResultColumn) })),
  };
}
