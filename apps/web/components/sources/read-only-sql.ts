const quoteIdent = (name: string) => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`);
const backtick = (name: string) =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name.replaceAll("`", "\\`")}\``;

export type ConnectKind = "postgres" | "clickhouse" | "mysql";

/** The SQL an admin runs to create the read-only user OpenDash asks for (the connection guide). */
export function readOnlyUserSql(kind: ConnectKind = "postgres", database?: string) {
  if (kind === "mysql") {
    // SELECT and nothing else: OpenDash's check refuses a user that can write or reach beyond the data.
    return [
      "CREATE USER 'opendash_reader'@'%' IDENTIFIED BY '…';",
      `GRANT SELECT ON ${backtick(database || "your_database")}.* TO 'opendash_reader'@'%';`,
    ].join("\n");
  }
  if (kind === "clickhouse") {
    // readonly = 2: the user can't write tables, and can still take the per-query limits OpenDash sets.
    return [
      "CREATE USER opendash_reader IDENTIFIED BY '…'",
      "  SETTINGS readonly = 2;",
      `GRANT SELECT ON ${backtick(database || "your_database")}.* TO opendash_reader;`,
    ].join("\n");
  }
  const db = quoteIdent(database || "your_database");
  return [
    "CREATE ROLE opendash_reader LOGIN PASSWORD '…';",
    `GRANT CONNECT ON DATABASE ${db} TO opendash_reader;`,
    "GRANT USAGE ON SCHEMA public TO opendash_reader;",
    "GRANT SELECT ON ALL TABLES IN SCHEMA public TO opendash_reader;",
    "ALTER DEFAULT PRIVILEGES IN SCHEMA public",
    "  GRANT SELECT ON TABLES TO opendash_reader;",
  ].join("\n");
}
