import { brandOfDialect } from "@opendash/tokens/brands";
import { BrandTile } from "@opendash/ui";
import { dialectLabel } from "@/lib/format";

/** The databases a new source can be made from (Source Option). */
export type SourceKind = "postgres" | "mysql" | "clickhouse" | "snowflake" | "bigquery";

/**
 * The square brand tile for a source: its database's mark on that database's colour, by its dialect (md: lists and
 * forms, 32; lg: a source's page header, 44). A dialect without a mark (SQL Server, MotherDuck, the lake) shows its
 * name's first letter, never another database's mark.
 */
export function SourceTile({ kind, size = "md" }: { kind: string; size?: "md" | "lg" }) {
  return (
    <BrandTile brand={brandOfDialect(kind)} name={dialectLabel(kind, null)} size={size === "lg" ? "xl" : "source"} />
  );
}
