/**
 * The profiling rules every dialect shares (onboarding): what makes a column
 * personal or secret, free text, a category, a key, a time or an amount in cents, and which undeclared joins and
 * time columns are worth a look. Each dialect supplies the numbers (statistics, a sample) its own way; these rules
 * turn them into the same profile. Values of personal or secret columns are used to detect them, then dropped.
 */
import type { CatalogSnapshot, ColumnInfo, ForeignKeyInfo, RelationInfo } from "./catalog-types";

export type ColumnRole = "key" | "foreign_key" | "time" | "amount_cents" | "category" | "free_text" | "personal_data";
export type Sensitivity = "none" | "pii" | "secret";

export interface ColumnProfile {
  nullFrac: number | null;
  ndv: number | null;
  min?: string;
  max?: string;
  /** The most common values with an estimated count; never for personal or secret columns. */
  top?: { value: string; freq: number }[];
  roles: ColumnRole[];
  sensitivity: Sensitivity;
  /** Why it's personal or secret: "column name" or "values look like email addresses". */
  sensitivityReason?: string;
  references?: { schema: string; table: string; column: string; overlap: number; declared: boolean };
  /** Tables its values partly match (a subset: active_organizations, 11%), when it joins none fully. */
  partialJoins?: { schema: string; table: string; column: string; overlap: number }[];
  maxValue?: string;
}

export interface TableProfile {
  rows: number | null;
  method: "statistics" | "sample";
  sampled: number;
  columns: Record<string, ColumnProfile>;
  freshness?: { column: string; max: string };
}

export interface ProfileOptions {
  sampleRows: number;
  /** Text columns with at most this many distinct values are categories. */
  categoryMaxNdv: number;
  /**
   * An admin's choices for this table's columns, by column name. They replace detection, so a column marked
   * personal keeps no sample values or range and is never read for freshness, and a cleared one is profiled. A
   * column whose values look like secrets stays a secret whatever the choice.
   */
  sensitivity?: Record<string, Sensitivity>;
  /** The sync's join checks, shared by its tables (`newJoinChecks`); a table profiled alone gets its own. */
  joins?: JoinChecks;
}

export const PII_NAME =
  /(^|_)(e_?mail|phone|mobile|cell|fax|msisdn|caller_?(id|number)|wa_?id|whatsapp(_?id)?|tel(ephone)?|first_?name|last_?name|full_?name|surname|given_name|birth|dob|ssn|social_security|passport|tax_id|national_id|street|address|zip|postcode|postal_code|ip_?address|latitude|longitude)($|_)/i;
/**
 * A person's name, by the column's name (a text column only): who someone is in the row (contact, owner, assignee),
 * or the name on a table of people. A company's name (customer_name, account_name) isn't one: in B2B data customers
 * are organizations, and people filter by them.
 */
export const PERSON_NAME = /(^|_)(contact|owner|assignee|author|recipient|sender|person|employee|member)(_?name)?$/i;
const PERSON_TABLE = /(^|_)(users?|contacts?|people|persons?|members?|employees?|leads?|staff|profiles?)$/i;
const NAME_COLUMN = /^(name|display_?name|user_?name|nick_?name)$/i;
export const SECRET_NAME = /(^|_)(password|passwd|secret|token|api_?key|private_?key|salt|hash)($|_)/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const PHONE = /^\+?[\d\s().-]{7,20}$/;
/** Long, unbroken runs of letters and digits: API keys, tokens, hashes. UUIDs are identifiers, not secrets. */
const TOKEN = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_\-+/=.]{24,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * An identifier, by its name (org_id, account_uuid, orgId), whose values are all in a shape ids come in: plain digits,
 * a MongoDB ObjectId, a cuid, a ULID. Those aren't a phone number or a key. Anything else in a column named that way
 * is judged by its values like any other column (fail closed): a formatted phone number, a hex digest, an API key.
 * A phone or a caller is caught by its name first.
 */
const ID_NAME = /^(id|uuid|guid)$|_(id|ids|uuid|guid)$/i;
const CAMEL_ID = /[a-z0-9]Id$/;
const ID_VALUE = /^(\d{1,20}|[0-9a-f]{24}|c[a-z0-9]{24,31}|[0-9A-HJKMNP-TV-Z]{26})$/;
/** Credentials by their well-known prefixes, in any column: Stripe, GitHub, Slack and AWS keys, JWTs. */
const SECRET_VALUE =
  /^((sk|rk)_(live|test)_|gh[pousr]_|github_pat_|xox[abpr]-|AKIA[0-9A-Z]{16}$|ASIA[0-9A-Z]{16}$|eyJ[\w-]{8,}\.[\w-]{8,}\.)/;
/** An id that is a credential all the same: a session's, a reset's, an invitation's (as a whole word: not author_id). */
const CREDENTIAL = /(^|_)(session|auth|access|refresh|reset|invite|invitation|verification|api)(_|$)/i;
const CAMEL_CREDENTIAL = /^(session|auth|access|refresh|reset|invite|invitation|verification|api)[A-Z0-9]/;
const CENTS_NAME = /cents?($|_)|_minor($|_)/i;
const CENTS_COMMENT = /\bcents?\b|minor units?/i;
const FRESHNESS_ORDER = [/^updated_at$/, /^modified_at$/, /^(created|inserted)_at$/, /_at$/, /(date|time)/];

export function sensitivityOf(
  column: ColumnInfo,
  values: string[],
  table?: string,
): { sensitivity: Sensitivity; reason?: string } {
  if (SECRET_NAME.test(column.name)) return { sensitivity: "secret", reason: "column name" };
  if (PII_NAME.test(column.name)) return { sensitivity: "pii", reason: "column name" };
  if (column.textual && PERSON_NAME.test(column.name)) return { sensitivity: "pii", reason: "a person's name" };
  if (column.textual && table && PERSON_TABLE.test(table) && NAME_COLUMN.test(column.name)) {
    return { sensitivity: "pii", reason: "a person's name" };
  }
  if (column.textual && values.length >= 5) {
    const share = (re: RegExp) => values.filter((v) => re.test(v)).length / values.length;
    if (share(EMAIL) >= 0.5) return { sensitivity: "pii", reason: "values look like email addresses" };
    if (share(SECRET_VALUE) >= 0.5) return { sensitivity: "secret", reason: "values look like keys or tokens" };
    const ids =
      (ID_NAME.test(column.name) || CAMEL_ID.test(column.name)) &&
      !CREDENTIAL.test(column.name) &&
      !CAMEL_CREDENTIAL.test(column.name) &&
      values.every((v) => ID_VALUE.test(v));
    if (!ids && share(PHONE) >= 0.8 && values.some((v) => /\d{3}/.test(v)))
      return { sensitivity: "pii", reason: "values look like phone numbers" };
    const tokens = values.filter((v) => TOKEN.test(v) && !UUID.test(v)).length / values.length;
    if (!ids && tokens >= 0.8) return { sensitivity: "secret", reason: "values look like keys or tokens" };
  }
  return { sensitivity: "none" };
}

/** What a dialect knows about a column beyond the sample, when it knows it cheaply (Postgres's pg_stats). */
export interface ColumnStats {
  nullFrac: number | null;
  ndv: number | null;
  top?: { value: string; freq: number }[];
  min?: string;
  max?: string;
}

/**
 * One column's profile from its sample values (as text, nulls left out) and optional statistics. `rows` is the
 * table's row count (estimated) and scales sample counts.
 */
export function buildColumnProfile(input: {
  column: ColumnInfo;
  /** The table's name: a name column on a table of people is a person's name. */
  table?: string;
  raw: string[];
  sampled: number;
  rows: number | null;
  stats?: ColumnStats;
  unique: boolean;
  foreignKey?: ForeignKeyInfo;
  options: ProfileOptions;
}): ColumnProfile {
  const { column, raw, sampled, rows, stats, options } = input;
  const nulls = sampled - raw.length;
  const detected = sensitivityOf(column, raw, input.table);
  // An admin's choice replaces detection, except that values that look like secrets are always a secret: clearing a
  // personal-data mark must never let a secret be sampled or indexed.
  const override = detected.sensitivity === "secret" ? undefined : options.sensitivity?.[column.name];
  const sensitivity = override ?? detected.sensitivity;
  const reason = override ? (override === "none" ? undefined : "marked by an admin") : detected.reason;
  const hidden = sensitivity !== "none";
  const nullFrac = stats ? stats.nullFrac : sampled ? nulls / sampled : null;
  const ndv = stats?.ndv ?? (raw.length ? new Set(raw).size : null);

  const profile: ColumnProfile = { nullFrac, ndv, roles: [], sensitivity };
  if (reason) profile.sensitivityReason = reason;
  // Free text (notes, messages, descriptions) can hold names and emails no column-level check can see, so its
  // values are never kept or indexed either.
  const avgLength = raw.length ? raw.reduce((sum, v) => sum + v.length, 0) / raw.length : 0;
  const freeText = column.textual && avgLength > 40;

  if (!hidden && !freeText) {
    if (stats?.top?.length) {
      profile.top = stats.top.slice(0, 10);
    } else if (raw.length) {
      const counts = new Map<string, number>();
      for (const v of raw) counts.set(v, (counts.get(v) ?? 0) + 1);
      const scale = rows !== null && sampled ? rows / sampled : 1;
      profile.top = [...counts.entries()]
        .filter(([, n]) => n > 1)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 10)
        .map(([value, n]) => ({ value, freq: Math.round(n * scale) }));
    }
    if (stats?.min !== undefined && stats.max !== undefined) {
      profile.min = stats.min;
      profile.max = stats.max;
    } else if (raw.length && (column.numeric || column.temporal)) {
      const sorted = [...raw].sort((a, b) => (column.numeric ? Number(a) - Number(b) : a.localeCompare(b)));
      profile.min = sorted[0];
      profile.max = sorted.at(-1);
    }
  }

  if (input.unique) profile.roles.push("key");
  if (column.temporal) profile.roles.push("time");
  if (column.numeric && (CENTS_NAME.test(column.name) || CENTS_COMMENT.test(column.comment ?? "")))
    profile.roles.push("amount_cents");
  // Categories are short labels; long text is free text however often it repeats.
  if (freeText && !hidden) profile.roles.push("free_text");
  else if (
    column.textual &&
    !hidden &&
    ndv !== null &&
    ndv <= options.categoryMaxNdv &&
    (rows === null || ndv < rows / 2)
  )
    profile.roles.push("category");
  if (sensitivity === "pii") profile.roles.push("personal_data");
  const fk = input.foreignKey;
  if (fk) {
    profile.roles.push("foreign_key");
    profile.references = {
      schema: fk.refSchema,
      table: fk.refTable,
      column: fk.refColumns[0] ?? "",
      overlap: 1,
      declared: true,
    };
  }
  return profile;
}

/** An undeclared join is kept when at least this share of the column's values match the key. */
export const JOIN_OVERLAP = 0.95;
/** A match below that, from this share, is kept as a partial join: a subset (active_organizations, 11%). */
export const PARTIAL_JOIN = 0.01;
/** How many join checks (a query each on the source) a sync, and one table, may run. */
export const JOIN_CHECKS_PER_SYNC = 150;
export const JOIN_CHECKS_PER_TABLE = 10;
const CANDIDATES_PER_COLUMN = 3;

/** A sync's join checks: how many it may still run, and the keys it found unique (one check per key, per sync). */
export interface JoinChecks {
  left: number;
  unique: Map<string, boolean>;
}
export const newJoinChecks = (left = JOIN_CHECKS_PER_SYNC): JoinChecks => ({ left, unique: new Map() });

/** Short names warehouses use for what tables are named in full (org_id → organizations). */
const ABBREVIATIONS: Record<string, string> = {
  org: "organization",
  acct: "account",
  cust: "customer",
  usr: "user",
  sub: "subscription",
  prod: "product",
};
/** A column that names a row elsewhere: org_id, account_uuid, plan_code, orgId. */
const REFERENCE = /^(.+?)_(id|uuid|key|code)$/i;
const CAMEL_REFERENCE = /^(.+?)(Id|Uuid|Key|Code)$/;

/** The names a table holding `stem` rows goes by: org, orgs, organization, organizations, companies. */
function namesFor(stem: string): string[] {
  const s = stem.toLowerCase();
  const full = ABBREVIATIONS[s];
  const short = Object.entries(ABBREVIATIONS).find(([, f]) => f === s)?.[0];
  const bases = [s, ...(full ? [full] : []), ...(short ? [short] : [])];
  return [...new Set(bases.flatMap((b) => [b, `${b}s`, `${b}es`, b.replace(/y$/, "ies")]))];
}

const snake = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const camel = (name: string) => name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export interface JoinCandidate {
  target: RelationInfo;
  key: string;
}

/**
 * The tables a column may join to, best first, at most three: by its name (org_id → organizations, orgs, dim_orgs,
 * active_organizations), keyed by the same column name, else `id`, else the target's one-column key. Views count:
 * whether a key is unique is checked on the data, not declared. Names only; the data decides (`findJoins`).
 */
export function joinCandidates(column: ColumnInfo, relation: RelationInfo, catalog: CatalogSnapshot): JoinCandidate[] {
  const m = REFERENCE.exec(column.name) ?? CAMEL_REFERENCE.exec(column.name);
  if (!m?.[1]) return [];
  const names = namesFor(m[1].replace(/_$/, ""));
  const scored: { candidate: JoinCandidate; score: number }[] = [];
  // A view and the tables it reads hold the same rows: that's lineage, not a join (organizations reads org_rows).
  const reads = (a: RelationInfo, b: RelationInfo) =>
    (a.build?.reads ?? []).some((x) => x.schema === b.schema && x.name === b.name);
  for (const target of catalog.relations) {
    if (target.schema === relation.schema && target.name === relation.name) continue;
    if (reads(target, relation) || reads(relation, target)) continue;
    const name = target.name.toLowerCase();
    const named = names.includes(name)
      ? 3
      : names.some((n) => name.endsWith(`_${n}`) || name.startsWith(`${n}_`))
        ? 2
        : 0;
    const columns = new Set(target.columns.map((c) => c.name));
    const pk = target.primaryKey.length === 1 ? target.primaryKey[0] : undefined;
    // The same name, or spelled the other way (orgId and org_id), else `id`, else its one-column key.
    const spellings = [column.name, snake(column.name), camel(column.name)];
    const key = spellings.find((n) => columns.has(n)) ?? (columns.has("id") ? "id" : pk);
    if (!key) continue;
    // Not named for it: only when the other table's declared key has this very name (subscriptions.plan_code → plans).
    if (!named && !(pk === column.name)) continue;
    const sameName = spellings.includes(key);
    scored.push({ candidate: { target, key }, score: named * 10 + (sameName ? 2 : 0) - name.length / 1000 });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATES_PER_COLUMN)
    .map((s) => s.candidate);
}

/**
 * Finds the joins nobody declared, for a profiled table's columns: each candidate's key must be unique among its
 * values (declared in Postgres and MySQL, checked on the data in ClickHouse and for views), then the column's sampled
 * values must match it. The first match of 95% or more is the column's join; smaller ones (from 1%) are kept as
 * partial joins, at most two. Bounded by `checks`: per column, per table and per sync. A dialect gives the queries.
 */
export async function findJoins(input: {
  relation: RelationInfo;
  catalog: CatalogSnapshot;
  columns: Record<string, ColumnProfile>;
  checks: JoinChecks;
  /** Postgres's and MySQL's declared keys are unique; ClickHouse's primary key isn't. */
  declaredKeysUnique: boolean;
  unique: (target: RelationInfo, key: string) => Promise<boolean>;
  overlap: (column: ColumnInfo, target: RelationInfo, key: string) => Promise<{ n: number; matched: number }>;
}): Promise<void> {
  const { relation, catalog, columns, checks } = input;
  let budget = JOIN_CHECKS_PER_TABLE;
  const spend = () => {
    checks.left -= 1;
    budget -= 1;
  };
  for (const column of relation.columns) {
    const profile = columns[column.name];
    if (!profile || profile.references || profile.roles.includes("key") || profile.sensitivity === "secret") continue;
    const partial: NonNullable<ColumnProfile["partialJoins"]> = [];
    for (const { target, key } of joinCandidates(column, relation, catalog)) {
      if (budget <= 0 || checks.left <= 0) break;
      const declared =
        input.declaredKeysUnique &&
        ((target.primaryKey.length === 1 && target.primaryKey[0] === key) ||
          target.uniques.some((u) => u.length === 1 && u[0] === key));
      const id = `${target.schema}.${target.name}.${key}`;
      let unique = declared || checks.unique.get(id);
      if (unique === undefined) {
        spend();
        unique = await input.unique(target, key).catch(() => false);
        checks.unique.set(id, unique);
      }
      if (!unique || budget <= 0 || checks.left <= 0) continue;
      spend();
      const o = await input.overlap(column, target, key).catch(() => null);
      if (!o || o.n <= 0) continue;
      const share = Math.round((o.matched / o.n) * 1000) / 1000;
      const ref = { schema: target.schema, table: target.name, column: key, overlap: share };
      if (share >= JOIN_OVERLAP) {
        profile.roles.push("foreign_key");
        profile.references = { ...ref, declared: false };
        break;
      }
      if (share >= PARTIAL_JOIN && partial.length < 2) partial.push(ref);
    }
    if (partial.length) profile.partialJoins = partial;
  }
}

/** Time columns that hold what's planned, not what happened (trial_ends_at, period_end, expires_at, next_run_at…). */
const SCHEDULE_NAME = /(^|_)(ends?|expires?|expiry|due|until|scheduled|next|renews?|renewal)(_|$)/i;

/** How far ahead of now a "latest" value may be and still count as data so far (timestamps stored without a zone). */
export const FRESHNESS_FUTURE_SLACK_MS = 6 * 60 * 60_000;

/**
 * A data timestamp as a source writes it, as an ISO instant, or null. Postgres gives "2026-10-07 23:00:00+00",
 * ClickHouse "2026-10-07 23:00:00.000" (UTC), a date column "2026-10-07". Anything else isn't a time.
 */
export function parseDataTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(
    value.trim(),
  );
  if (!m) return null;
  const [, date, time = "00:00:00", zone] = m;
  const tz =
    !zone || zone === "Z" ? "Z" : zone.length === 3 ? `${zone}:00` : zone.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(`${date}T${time.replace(/(\.\d{3})\d+$/, "$1")}${tz}`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Whether a column's latest value can say how fresh the data is: a time, and not in the future. */
export function isFreshnessValue(value: string | null | undefined, now = Date.now()): boolean {
  const iso = parseDataTime(value);
  return iso !== null && Date.parse(iso) <= now + FRESHNESS_FUTURE_SLACK_MS;
}

/**
 * The time columns that best say how fresh a table is (updated_at before created_at…): never personal data, and
 * never a column of planned times.
 */
export function freshnessColumns(relation: RelationInfo, columns: Record<string, ColumnProfile>): ColumnInfo[] {
  const rank = (name: string) => {
    const i = FRESHNESS_ORDER.findIndex((re) => re.test(name));
    return i === -1 ? FRESHNESS_ORDER.length : i;
  };
  return relation.columns
    .filter((c) => c.temporal && columns[c.name]?.sensitivity === "none" && !SCHEDULE_NAME.test(c.name))
    .sort((a, b) => rank(a.name) - rank(b.name))
    .slice(0, 2);
}
