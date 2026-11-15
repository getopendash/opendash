/**
 * A dashboard version's render revision: what one drawing of it is made of, as one hash. The definition
 * (canonical, so key order never matters), its parts bundle, the runtime that draws it, and the contracts version
 * (the definition's format and the data API's). A definition-only edit is a new revision with the same bundle: nothing
 * rebuilds, and the frame reuses the bundle it has. Server-side only (node:crypto).
 */
import { createHash } from "node:crypto";

/** The definition format and the data API, together: a change to either makes every revision new. */
export const CONTRACTS_VERSION = "dashboard@1";

/** JSON with every object's keys sorted, at every depth; arrays keep their order. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function revisionOf(input: { definition: unknown; bundleHash: string | null; runtimeHash: string }): string {
  return createHash("sha256")
    .update(canonical(input.definition))
    .update("\0")
    .update(input.bundleHash ?? "")
    .update("\0")
    .update(input.runtimeHash)
    .update("\0")
    .update(CONTRACTS_VERSION)
    .digest("hex");
}
