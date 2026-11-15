import { plainName, type SqlBuilder, type TimeGrain } from "../sql-builder";

const UNIT: Record<TimeGrain, [number, string]> = {
  day: [1, "day"],
  week: [7, "day"],
  month: [1, "month"],
  quarter: [3, "month"],
  year: [1, "year"],
};

/**
 * MySQL pieces for the compiler. Sessions run in UTC (session.ts). A list parameter is one `?` in `x in (?)`, bound
 * as a list: the driver writes each value escaped (`'Starter', 'Growth'`), under the session's pinned sql_mode. (MEMBER
 * OF with a JSON array was the first choice; the statement check's parser doesn't read it.)
 */
export const mysqlSql: SqlBuilder = {
  ident: (name) =>
    plainName(name)
      .split(".")
      .map((part) => `\`${part}\``)
      .join("."),
  truncTime: (expr, grain) => {
    const d = `date(${expr})`;
    switch (grain) {
      case "day":
        return d;
      case "week":
        return `date_sub(${d}, interval weekday(${expr}) day)`;
      case "month":
        return `date_sub(${d}, interval (dayofmonth(${expr}) - 1) day)`;
      case "quarter":
        return `makedate(year(${expr}), 1) + interval ((quarter(${expr}) - 1) * 3) month`;
      case "year":
        return `makedate(year(${expr}), 1)`;
    }
  },
  shiftDate: (expr, n, grain) => {
    const [size, unit] = UNIT[grain];
    return `date(date_add(${expr}, interval ${n * size} ${unit}))`;
  },
  previous: (expr, partitionBy, orderBy) =>
    `lag(${expr}) over (${partitionBy.length ? `partition by ${partitionBy.join(", ")} ` : ""}order by ${orderBy})`,
  param: (_position, _name, kind) => (kind === "time" ? "cast(? as datetime(3))" : "?"),
  inList: (expr, placeholder) => `${expr} in (${placeholder})`,
  timeValue: (t) => t.toISOString().replace("T", " ").replace("Z", ""),
};
