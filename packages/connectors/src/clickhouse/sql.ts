import { type ParamKind, plainName, type SqlBuilder, type TimeGrain } from "../sql-builder";

const TRUNC: Record<TimeGrain, string> = {
  day: "toDate",
  week: "toMonday",
  month: "toStartOfMonth",
  quarter: "toStartOfQuarter",
  year: "toStartOfYear",
};

const SHIFT: Record<TimeGrain, string> = {
  day: "addDays",
  week: "addWeeks",
  month: "addMonths",
  quarter: "addQuarters",
  year: "addYears",
};

const TYPE: Record<ParamKind, string> = {
  string: "String",
  number: "Float64",
  boolean: "Bool",
  time: "DateTime64(3, 'UTC')",
  strings: "Array(String)",
  numbers: "Array(Float64)",
};

/**
 * ClickHouse pieces for the compiler. A Date or DateTime is read as an instant in UTC before truncating. `lagInFrame`
 * needs the whole partition as its frame, and returns the type's default (0, 1970-01-01) for the first row unless the
 * value is nullable, hence `toNullable`.
 */
export const clickhouseSql: SqlBuilder = {
  ident: (name) => `\`${plainName(name)}\``,
  truncTime: (expr, grain) => `${TRUNC[grain]}(toDateTime64(${expr}, 3, 'UTC'))`,
  shiftDate: (expr, n, grain) => `${SHIFT[grain]}(${expr}, ${n})`,
  previous: (expr, partitionBy, orderBy) =>
    `lagInFrame(toNullable(${expr})) over (${partitionBy.length ? `partition by ${partitionBy.join(", ")} ` : ""}order by ${orderBy} rows between unbounded preceding and unbounded following)`,
  param: (_position, name, kind) => `{${plainName(name)}:${TYPE[kind]}}`,
  inList: (expr, placeholder) => `has(${placeholder}, ${expr})`,
  timeValue: (t) => t.toISOString().replace("T", " ").replace("Z", ""),
};
