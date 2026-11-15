import type { SourceFormInput } from "@/app/(app)/data/sources/new/actions";

/**
 * ClickHouse's public playground: open datasets (house prices, GitHub events, taxi trips…) behind a read-only user
 * with no password, for trying OpenDash without a database of one's own. Its user has readonly = 1 on a server that
 * already bounds every query, which the connection check accepts (connectors' clickhouse/session.ts).
 */
export const CLICKHOUSE_PLAYGROUND: Omit<SourceFormInput, "dialect"> = {
  host: "play.clickhouse.com",
  port: "443",
  database: "default",
  user: "explorer",
  password: "",
  sslMode: "verify-full",
  ca: "",
};

export const CLICKHOUSE_PLAYGROUND_DOCS = "https://clickhouse.com/docs/get-started/sample-datasets/playground";

export const CLICKHOUSE_PLAYGROUND_PATH = "/data/sources/new/clickhouse?preset=playground";
