/** Display formats shared by the Data screens. Pure, so server and client render the same text. */

const DIALECT_NAMES: Record<string, string> = { postgres: "PostgreSQL", clickhouse: "ClickHouse", mysql: "MySQL" };

/** "PostgreSQL 16", "ClickHouse 26". */
export function dialectLabel(dialect: string, serverVersion: string | null): string {
  const major = serverVersion?.split(".")[0];
  return `${DIALECT_NAMES[dialect] ?? dialect}${major ? ` ${major}` : ""}`;
}

/** "just now", "5 min ago", "2h ago", "3d ago". `now` comes from the server so the client renders the same. */
export function ago(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const sameYear = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
const otherYear = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * A data timestamp: "Oct 7, 23:00", or "Oct 7, 2025" in another year. In UTC, which is how sources store most time
 * columns, until organizations have a time zone.
 */
export function dataTime(iso: string, now: number): string {
  const d = new Date(iso);
  return d.getUTCFullYear() === new Date(now).getUTCFullYear() ? sameYear.format(d) : otherYear.format(d);
}

export const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

const short = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** "Oct 6". */
export const shortDate = (iso: string) => short.format(new Date(iso));

const shortTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

/** "Oct 6, 14:02" (UTC): when a run started. */
export const shortDateTime = (iso: string) => `${shortTime.format(new Date(iso))} UTC`;

const compactFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** "6", "3.1k", "402k", "1.2m": row counts in the catalog tree. */
export const compact = (n: number) => compactFormat.format(n).toLowerCase();

/** "28.1K", "3.9M": token counts. */
export const tokens = (n: number) => compactFormat.format(n);

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
/** "$3.12", and a model call's fraction of a cent to four places ("$0.0218"). */
export const usd = (n: number) => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : dollars.format(n));

/** A usage row's cost: "—" when none of its calls had a price, a lower bound ("≥ $1.20") while some didn't. */
export const costLabel = (r: { costUsd: number; unpriced: number; calls: number }) =>
  r.unpriced === r.calls && r.calls > 0 ? "—" : `${r.unpriced ? "≥ " : ""}${usd(r.costUsd)}`;

/** "Daily at 02:00 UTC", "Every 6 hours", "Off": a sync schedule (sources/schedule.ts) in words. */
export function scheduleLabel(s: { every: "off" } | { every: "6h" } | { every: "day"; hour: number }): string {
  if (s.every === "off") return "Off (Sync now only)";
  if (s.every === "6h") return "Every 6 hours";
  return `Daily at ${String(s.hour).padStart(2, "0")}:00 UTC`;
}
