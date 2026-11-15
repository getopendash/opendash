import { catalogTable, catalogTree, tablePatterns } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { CodeBlock } from "@opendash/ui";
import { notFound, redirect } from "next/navigation";
import { CatalogTree } from "@/components/sources/catalog-tree";
import { ColumnsTable } from "@/components/sources/columns-table";
import { TableCard } from "@/components/sources/table-card";
import { requireTenant } from "@/lib/auth";
import { count, dataTime } from "@/lib/format";
import { canManageSources, sourcePage } from "@/lib/sources";

/**
 * Catalog: every table OpenDash learned in this source, and one table's columns with what was detected about each.
 * Its card says how it's built and joined, and what models it, as the analyst reads it. Admins can mark a
 * column as personal data (or clear it), and see a view's definition; everything else here is read-only.
 */
export default async function SourceCatalog({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ table?: string }>;
}) {
  const [{ id }, { table: wanted }] = await Promise.all([params, searchParams]);
  const viewer = await requireTenant();
  const data = await sourcePage(viewer.ctx.orgId, viewer.user.id, id);
  if (!data) notFound();
  if (!data.source.learnedAt) redirect(`/data/sources/${id}`);
  const schemas = await withTenant(viewer.ctx, (tx) => catalogTree(tx, viewer.ctx.orgId, id));
  const tableId = wanted ?? schemas.find((s) => s.tables.length)?.tables[0]?.id ?? null;
  const table = tableId ? await withTenant(viewer.ctx, (tx) => catalogTable(tx, viewer.ctx.orgId, id, tableId)) : null;
  const canManage = canManageSources(viewer.role);
  // The team's most-run queries of the table. Their SQL is for owners and admins; everyone sees the count.
  const patterns =
    table && canManage && table.queries > 0
      ? await withTenant(viewer.ctx, (tx) => tablePatterns(tx, viewer.ctx.orgId, id, `${table.schema}.${table.name}`))
      : [];
  // MySQL keeps only its recent statements (a buffer of the last 10,000 by default): say so, not "most-run".
  const historyFrom =
    data.source.dialect === "clickhouse"
      ? "system.query_log"
      : data.source.dialect === "mysql"
        ? "the server's recent statements"
        : "pg_stat_statements";
  const now = Date.now();
  const freshAt = table?.freshness?.at ?? null;

  return (
    // overflow-clip, not hidden: it rounds the corners without becoming a scroller, so the table list can stick.
    <div className="flex flex-col overflow-clip rounded-2xl border border-border @5xl/page:flex-row">
      <div className="border-border @5xl/page:w-72 @5xl/page:shrink-0 @5xl/page:border-r">
        {/* The table list stays in view and scrolls on its own while a long table's columns scroll the page. */}
        <div className="p-2 @5xl/page:sticky @5xl/page:top-0 @5xl/page:max-h-side-pane @5xl/page:overflow-y-auto">
          <CatalogTree sourceId={id} schemas={schemas} selectedId={table?.id ?? null} />
        </div>
      </div>
      <section aria-labelledby="table-title" className="flex min-w-0 flex-1 flex-col gap-4 p-5">
        {table ? (
          <>
            <div className="flex flex-col gap-1">
              <h2 id="table-title" className="font-mono text-heading">
                {table.schema}.{table.name}
              </h2>
              <p className="text-small text-muted">
                {[
                  table.kind === "view" ? "View" : null,
                  table.rows !== null
                    ? `${count(Math.round(table.rows), "row")}${table.method === "sample" ? " (sampled)" : ""}`
                    : null,
                  count(table.columns.length, "column"),
                  table.freshness && freshAt
                    ? `data to ${dataTime(freshAt, now)} (from ${table.freshness.column})`
                    : null,
                  table.queries > 0
                    ? `read by ${table.queries.toLocaleString("en-US")} of your team's query runs`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {table.comment ? <p className="text-body text-muted">{table.comment}</p> : null}
            </div>
            <TableCard table={table} canManage={canManage} />
            <ColumnsTable key={table.id} sourceId={id} columns={table.columns} canManage={canManage} />
            <p className="text-small text-muted-tertiary">
              Columns marked as personal data are never sampled or shown to the model; queries can still count and
              filter on them. An admin's choice is kept on later syncs. OpenDash keeps stats about a column, never its
              values: they're read from the source when a question needs one.
            </p>
            {patterns.length ? (
              <section aria-labelledby="team-queries-title" className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h3 id="team-queries-title" className="text-small font-medium">
                    How your team queries it
                  </h3>
                  <span className="text-small text-muted-tertiary">From {historyFrom} · only admins see the SQL</span>
                </div>
                {patterns.map((p) => (
                  <div key={p.sql} className="flex flex-col gap-1">
                    <span className="text-small text-muted-tertiary">Run {count(p.calls, "time")}</span>
                    <CodeBlock code={p.sql} label="Copy SQL" wrap />
                  </div>
                ))}
                <p className="text-small text-muted-tertiary">
                  Normalized by the database: every value is a placeholder, and comments are dropped. The analyst sees
                  these as examples of how your team asks.
                </p>
              </section>
            ) : null}
          </>
        ) : (
          <p className="text-body text-muted">{wanted ? "That table isn't in this source." : "No tables yet."}</p>
        )}
      </section>
    </div>
  );
}
