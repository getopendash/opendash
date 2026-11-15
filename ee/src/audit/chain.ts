/**
 * The audit chain's recipe: each sealed row's hash is SHA-256 of the hash before it and the row's canonical form, so
 * changing, removing or reordering a sealed row breaks every link after it. The first row of a chain follows 32 zero
 * bytes. Seal, Verify and the exports all read rows through ROW_COLUMNS, so they hash the same text.
 */
import { createHash } from "node:crypto";
import { sql } from "@opendash/db";

export const ZERO = Buffer.alloc(32);

/** A row as the chain sees it: timestamps as exact text (microseconds, UTC), the address as text. */
export type ChainRow = {
  id: string;
  org_id: string;
  created_at: string;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  target_name: string | null;
  fields: string[];
  detail: unknown;
  ip: string | null;
  user_agent: string | null;
  seq: string | number | null;
  prev_hash: Buffer | null;
  hash: Buffer | null;
};

export const ROW_COLUMNS = sql`
  id, org_id, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at, actor_type,
  actor_id, actor_name, action, target_type, target_id, target_name, fields, detail, host(ip) as ip, user_agent, seq,
  prev_hash, hash`;

/** JSON with every object's keys sorted, so the same detail always hashes the same. */
export function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The row's canonical form: a version, then every column but the chain's own, in a fixed order, then its place. */
export function canonical(row: ChainRow, seq: number): string {
  return sortedJson([
    1,
    row.id,
    row.org_id,
    row.created_at,
    row.actor_type,
    row.actor_id,
    row.actor_name,
    row.action,
    row.target_type,
    row.target_id,
    row.target_name,
    row.fields ?? [],
    row.detail ?? {},
    row.ip,
    row.user_agent,
    seq,
  ]);
}

export function linkHash(prev: Buffer, row: ChainRow, seq: number): Buffer {
  return createHash("sha256").update(prev).update(canonical(row, seq), "utf8").digest();
}

export const hex = (b: Buffer | null | undefined): string | null => (b ? b.toString("hex") : null);
