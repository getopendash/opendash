import { plainName, type SqlBuilder, type TimeGrain } from "../sql-builder";

const INTERVAL: Record<TimeGrain, [number, string]> = {
  day: [1, "days"],
  week: [7, "days"],
  month: [1, "months"],
  quarter: [3, "months"],
  year: [1, "years"],
};

/** Postgres pieces for the compiler. Sessions run in UTC (session.ts), so a timestamptz truncates in UTC. */
export const postgresSql: SqlBuilder = {
  ident: (name) => `"${plainName(name)}"`,
  truncTime: (expr, grain) => `date_trunc('${grain}', (${expr})::timestamptz at time zone 'UTC')::date`,
  shiftDate: (expr, n, grain) => {
    const [size, unit] = INTERVAL[grain];
    return `((${expr}) + interval '${n * size} ${unit}')::date`;
  },
  previous: (expr, partitionBy, orderBy) =>
    `lag(${expr}) over (${partitionBy.length ? `partition by ${partitionBy.join(", ")} ` : ""}order by ${orderBy})`,
  param: (position, _name, kind) =>
    kind === "time"
      ? `$${position}::timestamptz`
      : kind === "strings"
        ? `$${position}::text[]`
        : kind === "numbers"
          ? `$${position}::float8[]`
          : `$${position}`,
  inList: (expr, placeholder) => `${expr} = any(${placeholder})`,
  timeValue: (t) => t.toISOString(),
};
