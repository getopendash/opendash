/**
 * Postgres's text and jsonb can't hold a NUL character (U+0000), and a source's strings can: a ClickHouse String is
 * any bytes, a FixedString is padded with NULs, a MySQL VARCHAR may carry one. Anything read from a source that
 * OpenDash keeps (a profile's values, a result's preview) goes through `storable` first; the value index leaves such
 * values out instead (`hasNul`), since a changed value would no longer match the source's own.
 */
const NUL = String.fromCharCode(0);

export const hasNul = (value: string) => value.includes(NUL);

/** The value as Postgres can keep it: each NUL in a string, however deep, becomes U+FFFD (the replacement character). */
export function storable<T>(value: T): T {
  if (typeof value === "string") return (hasNul(value) ? value.replaceAll(NUL, "\uFFFD") : value) as T;
  if (Array.isArray(value)) return value.map(storable) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [storable(k), storable(v)])) as T;
  }
  return value;
}
