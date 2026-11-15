import { clickhouseDialect } from "./clickhouse/dialect";
import type { Dialect, DialectId } from "./dialect";
import { mysqlDialect } from "./mysql/dialect";
import { postgresDialect } from "./postgres/dialect";

const DIALECTS: Record<DialectId, Dialect> = {
  postgres: postgresDialect,
  clickhouse: clickhouseDialect,
  mysql: mysqlDialect,
};

/** The adapter for a connection's dialect. Connections of a dialect without an adapter can't be used yet. */
export function dialectFor(id: string): Dialect {
  const dialect = DIALECTS[id as DialectId];
  if (!dialect) throw new Error(`No adapter for ${id} sources yet.`);
  return dialect;
}
