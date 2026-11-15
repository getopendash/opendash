/**
 * What a source's catalog looks like, the same shape for every dialect: schemas (Postgres schemas, ClickHouse
 * databases), tables and views with their columns, keys and joins, as far as the database declares them.
 */
export interface ColumnInfo {
  name: string;
  ordinal: number;
  type: string;
  /** Text-like, so it can be value-indexed: text, varchar, char, citext, or an enum. */
  textual: boolean;
  temporal: boolean;
  numeric: boolean;
  nullable: boolean;
  comment: string | null;
}

export interface ForeignKeyInfo {
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
}

/**
 * How a table or view is built, as far as the database says: never data. A view's definition has every
 * literal replaced and its comments gone, so values written into it (a customer's name in a WHERE) aren't kept; when
 * it can't be cleaned, it isn't kept at all.
 */
export interface BuildInfo {
  /** ClickHouse's table engine: MergeTree, ReplacingMergeTree, View… */
  engine?: string;
  /** The engine's column arguments: a ReplacingMergeTree's version column, a CollapsingMergeTree's sign. */
  engineColumns?: string[];
  sortingKey?: string;
  primaryKey?: string;
  partitionKey?: string;
  /** A view's (or materialized view's) query, cleaned: literals are placeholders, comments are gone. */
  definition?: string;
  /** The tables and views a view reads. */
  reads?: { schema: string; name: string }[];
}

export interface RelationInfo {
  schema: string;
  name: string;
  kind: "table" | "view";
  comment: string | null;
  /** From the planner's statistics; null when the table has never been analyzed. */
  rowsEstimate: number | null;
  analyzed: boolean;
  columns: ColumnInfo[];
  primaryKey: string[];
  uniques: string[][];
  foreignKeys: ForeignKeyInfo[];
  /** How it's built, when the dialect reads it. */
  build?: BuildInfo;
}

export interface CatalogSnapshot {
  schemas: { name: string; comment: string | null }[];
  relations: RelationInfo[];
  /** True when there were more readable tables than the limit. */
  truncated: boolean;
}

/** A comment is read to at most this many characters, cut on the server: what's kept is shorter still (core). */
export const COMMENT_READ_CHARS = 4_000;
