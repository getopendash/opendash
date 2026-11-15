import { v7 } from "uuid";

/** App-generated, time-ordered ids. Every tenant table uses (org_id, id) with id = uuidv7. */
export const uuidv7 = (): string => v7();

/**
 * The smallest uuidv7 for a moment, as app.uuidv7_floor makes it: an `id >=` bound beside a time filter lets Postgres
 * skip the RANGE(id) partitions before it (a created_at filter alone reads every one).
 */
export function uuidv7Floor(at: Date): string {
  const hex = Math.max(0, Math.floor(at.getTime())).toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
