import { type CatalogTable, type DefinitionStatus, engineInfo, joinLabel, keysLine, readsLine } from "@opendash/core";
import { CodeBlock } from "@opendash/ui";
import Link from "next/link";
import { DefinitionStatusChip } from "@/components/knowledge/definition-status";

/**
 * What OpenDash knows about a table, in the analyst's own wording (core's table-card): how it's
 * built, its keys, what a view reads, the joins checked on the data, and the datasets built over it. A view's
 * definition is for owners and admins.
 */
export function TableCard({ table, canManage }: { table: CatalogTable; canManage: boolean }) {
  const engine = engineInfo(table.build);
  const keys = keysLine(table.build, table.primaryKey);
  const reads = readsLine(table.build);
  const joins = table.columns.flatMap((c) => [
    ...(c.references
      ? [{ key: `${c.id}-ref`, text: `${c.name} ${joinLabel(target(c.references))}`, how: how(c.references) }]
      : []),
    ...c.partialJoins.map((p) => ({
      key: `${c.id}-${p.schema}.${p.table}.${p.column}`,
      text: `${c.name} ${joinLabel(target(p), true)}`,
      how: `${Math.max(1, Math.round(p.overlap * 100))}% of values match`,
    })),
  ]);
  const definition = canManage ? table.build?.definition : undefined;
  if (!engine && !keys && !reads && !joins.length && !table.models.length && !definition) return null;

  return (
    <div className="flex flex-col gap-2">
      <dl className="flex flex-col rounded-2xl border border-border px-4">
        {engine ? (
          <Row label="How it's built">
            <span className="font-mono text-small">{engine.name}</span>
            <span className="text-small text-muted">{engine.hint}.</span>
          </Row>
        ) : null}
        {keys ? (
          <Row label="Keys">
            <span className="font-mono text-small">{keys}</span>
          </Row>
        ) : null}
        {reads ? (
          <Row label="Reads">
            <span className="font-mono text-small">{reads.replace(/^reads /, "")}</span>
          </Row>
        ) : null}
        {joins.length ? (
          <Row label="Joins">
            {joins.map((j) => (
              <span key={j.key} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-small">{j.text}</span>
                {j.how ? <span className="text-small text-muted-tertiary">{j.how}</span> : null}
              </span>
            ))}
          </Row>
        ) : null}
        {table.models.length ? (
          <Row label="Modelled as">
            {table.models.map((m) => (
              <span key={m.ref} className="flex flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  {m.id ? (
                    <Link href={`/knowledge/datasets/${m.id}`} className="font-medium text-link hover:underline">
                      {m.ref}
                    </Link>
                  ) : (
                    <span className="font-medium">{m.ref}</span>
                  )}
                  <DefinitionStatusChip status={m.status as DefinitionStatus} />
                  {m.snapshot ? (
                    <span className="rounded-md bg-surface-secondary px-1.5 text-micro font-medium text-muted">
                      Snapshot
                    </span>
                  ) : null}
                </span>
                <span className="text-small text-muted">
                  {[sentence(m.grain), m.usageGuidance ?? m.description].filter(Boolean).join(". ")}
                </span>
              </span>
            ))}
          </Row>
        ) : null}
        {definition ? (
          <Row label="Definition">
            <span className="text-small text-muted">
              Only owners and admins see it. Every value written into it is a placeholder, and comments are gone.
            </span>
            <CodeBlock code={definition} label="Copy SQL" wrap />
          </Row>
        ) : null}
      </dl>
      <p className="text-small text-muted-tertiary">
        The analyst reads this same card. How a table is built comes from the source's schema; joins are checked on the
        data, between learned tables.
      </p>
    </div>
  );
}

/** A grain as a sentence's start: "one row per account." → "One row per account". */
const sentence = (text: string) => (text ? text[0]?.toUpperCase() + text.slice(1).replace(/\.$/, "") : "");

const target = (j: { schema: string; table: string; column: string }) => ({
  schema: j.schema,
  table: j.table,
  column: j.column,
});

/** How a join was found: declared by the source, or the share of values that match. */
function how(j: { declared?: boolean; overlap?: number }): string | null {
  if (j.declared) return "declared";
  return j.overlap !== undefined ? `${Math.max(1, Math.round(j.overlap * 100))}% of values match` : null;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-separator py-2.5 last:border-b-0 @xl/page:flex-row @xl/page:gap-4">
      <dt className="w-28 shrink-0 text-body text-muted">{label}</dt>
      <dd className="flex min-w-0 flex-1 flex-col gap-1 break-words">{children}</dd>
    </div>
  );
}
