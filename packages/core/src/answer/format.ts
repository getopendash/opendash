/**
 * How a referenced value is shown. The model picks a presentation from this fixed set (currency, percent, compact…);
 * it never picks the value. Anything outside the set is a gate problem, not a guess.
 */
export interface Format {
  currency?: string;
  percent?: boolean;
  compact?: boolean;
  signed?: boolean;
  decimals?: number;
  /** For date and timestamp cells. */
  month?: boolean;
  date?: boolean;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Parses "currency:USD,compact" into a Format, or says what's wrong with it. */
export function parseFormat(spec: string | undefined): { ok: true; format: Format } | { ok: false; message: string } {
  const format: Format = {};
  if (!spec?.trim()) return { ok: true, format };
  for (const raw of spec.split(",")) {
    const token = raw.trim();
    const currency = /^currency:([A-Z]{3})$/.exec(token);
    const decimals = /^decimals:([0-4])$/.exec(token);
    if (currency) format.currency = currency[1];
    else if (decimals) format.decimals = Number(decimals[1]);
    else if (token === "percent") format.percent = true;
    else if (token === "compact") format.compact = true;
    else if (token === "signed") format.signed = true;
    else if (token === "month") format.month = true;
    else if (token === "date") format.date = true;
    else if (token === "number") continue;
    else {
      return {
        ok: false,
        message: `"${token}" isn't a format. Use currency:USD (any ISO code), percent, compact, signed, decimals:0-4, month or date.`,
      };
    }
  }
  if (format.currency && format.percent) return { ok: false, message: "A value can't be both currency and percent." };
  return { ok: true, format };
}

export function formatNumber(value: number, format: Format): string {
  const options: Intl.NumberFormatOptions = {};
  if (format.signed) options.signDisplay = "exceptZero";
  if (format.currency) {
    options.style = "currency";
    options.currency = format.currency;
  } else if (format.percent) {
    options.style = "percent";
  }
  if (format.compact) options.notation = "compact";
  const decimals =
    format.decimals ?? (format.percent || format.compact ? 1 : format.currency ? 2 : Number.isInteger(value) ? 0 : 2);
  options.maximumFractionDigits = decimals;
  options.minimumFractionDigits = format.currency && !format.compact ? decimals : 0;
  // en-US compact notation writes 412.6K; OpenDash writes 412.6k (millions and billions stay M and B).
  return new Intl.NumberFormat("en-US", options).format(value).replace(/(\d)K\b/, "$1k");
}

/** A date or timestamp cell, as an ISO string from the gateway. */
export function formatTime(value: string, format: Format): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  const d = new Date(ms);
  if (format.month) return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (format.date) return `${MONTHS[d.getUTCMonth()]?.slice(0, 3)} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  const midnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
  return midnight ? d.toISOString().slice(0, 10) : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export type MetricFormat = "number" | "usd" | "percent";

/**
 * How a metric's values show (Home's tiles, a dashboard's, a review's, a metric's page): money from $1k and big counts
 * compact; money under $1k in full, its cents only when it has some ($191.92 and $10, not $191.9 and $10.00).
 */
export function metricFormat(format: MetricFormat, value: number): Format {
  return format === "usd"
    ? Math.abs(value) >= 1_000
      ? { currency: "USD", compact: true }
      : { currency: "USD", decimals: Number.isInteger(value) ? 0 : 2 }
    : format === "percent"
      ? { percent: true }
      : { compact: value >= 10_000 };
}

export const displayMetric = (format: MetricFormat, value: number) => formatNumber(value, metricFormat(format, value));
