"use server";

import {
  type DefinitionKind,
  saveDefinition,
  setReportStatus,
  validateDefinition,
  verifyDefinitions,
} from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth";
import { canVerify } from "@/lib/knowledge";
import { queue } from "@/lib/sources";

/**
 * Approves definitions: they become verified at their current version, and Ask uses them from the next
 * question on. A metric is only approved with its dataset (core refuses one without).
 */
export async function approveDefinitions(ids: string[]): Promise<{ approved: number } | { message: string }> {
  const viewer = await requireTenant();
  if (!canVerify(viewer.role)) return { message: "Only owners and admins can approve definitions." };
  const valid = ids.filter(isUuid).slice(0, 200);
  const approved = await withTenant(viewer.ctx, (tx) =>
    verifyDefinitions(tx, { orgId: viewer.ctx.orgId, userId: viewer.user.id }, valid),
  );
  revalidatePath("/knowledge", "layout");
  revalidatePath("/", "layout");
  return { approved: approved.length };
}

export interface DraftInput {
  id?: string;
  kind: DefinitionKind;
  connectionId: string;
  body: string;
  expectedVersion?: number;
}

export type DraftCheck = {
  name: string;
  status: "passed" | "failed" | "pending";
  detail?: string;
};

export interface DraftReport {
  checks: DraftCheck[];
  /** The line to point at (1-based), when a problem is about one. */
  line: number | null;
  /** The first problem, said once under the editor. */
  problem: string | null;
}

const lineOf = (body: string, field: string) => {
  const i = body.split("\n").findIndex((l) => l.startsWith(`${field}:`));
  return i >= 0 ? i + 1 : null;
};

/**
 * The editor's "Checks before saving", run as someone types: the same validation a save does, nothing written.
 */
export async function checkDefinitionDraft(input: DraftInput): Promise<DraftReport> {
  const viewer = await requireTenant();
  if (!isUuid(input.connectionId) || (input.id && !isUuid(input.id))) {
    return { checks: [], line: null, problem: "That source doesn't exist." };
  }
  const v = await withTenant(viewer.ctx, (tx) => validateDefinition(tx, { orgId: viewer.ctx.orgId }, input));
  const lines = input.body.split("\n").length;
  const kindName = input.kind === "metric" ? "metric" : "dataset";
  const problem = v.ok ? null : (v.problems[0] ?? null);
  const after = (stage: string) =>
    v.ok ? "passed" : order.indexOf(v.stage) > order.indexOf(stage) ? "passed" : "pending";
  const order = ["yaml", "spec", "name", "model"];
  const checks: DraftCheck[] = [
    v.ok || v.stage !== "yaml"
      ? { name: "Valid YAML", status: "passed", detail: `${lines} lines` }
      : { name: "Valid YAML", status: "failed", detail: problem ?? "" },
    !v.ok && v.stage === "spec"
      ? { name: `Matches the ${kindName} spec`, status: "failed", detail: v.problems.slice(0, 3).join(" ") }
      : {
          name: `Matches the ${kindName} spec`,
          status: after("spec"),
          ...(v.ok ? { detail: `${v.fields} fields` } : {}),
        },
  ];
  if (input.id) {
    checks.push(
      !v.ok && v.stage === "name"
        ? { name: "Keeps its name", status: "failed", detail: problem ?? "" }
        : { name: "Keeps its name", status: after("name") },
    );
  }
  checks.push(
    !v.ok && v.stage === "model"
      ? { name: "Fits with the source's other definitions", status: "failed", detail: v.problems.join(" ") }
      : { name: "Fits with the source's other definitions", status: after("model") },
  );
  // Point at the line a problem is about: YAML gives its line; a spec or model problem names a field.
  let line: number | null = null;
  if (!v.ok) {
    const yamlLine = /at line (\d+)/.exec(problem ?? "")?.[1];
    const field = /^(\w+)[.:]/.exec(problem ?? "")?.[1];
    const named = /no dataset|no measure|no segment|time column/.exec(problem ?? "")?.[0];
    line = yamlLine
      ? Number(yamlLine)
      : named === "no dataset"
        ? lineOf(input.body, "dataset")
        : named === "no measure"
          ? lineOf(input.body, "measure")
          : field
            ? lineOf(input.body, field)
            : null;
  }
  return { checks, line, problem };
}

/** Saves a definition as a new version (or a new one), then opens its page, where its tests show as they run. */
export async function saveDefinitionAction(
  input: DraftInput & { changeNote?: string },
): Promise<{ ok: true; href: string; version: number } | { ok: false; message: string }> {
  const viewer = await requireTenant();
  if (!canVerify(viewer.role)) return { ok: false, message: "Only owners and admins can change definitions." };
  if (!isUuid(input.connectionId) || (input.id && !isUuid(input.id))) {
    return { ok: false, message: "That source doesn't exist." };
  }
  const boss = await queue();
  const r = await withTenant(viewer.ctx, (tx) =>
    saveDefinition(
      { boss },
      tx,
      { orgId: viewer.ctx.orgId, userId: viewer.user.id },
      {
        kind: input.kind,
        connectionId: input.connectionId,
        body: input.body,
        ...(input.id ? { id: input.id } : {}),
        ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
        ...(input.changeNote ? { changeNote: input.changeNote } : {}),
      },
    ),
  );
  if (!r.ok) return { ok: false, message: r.problems.join(" ") };
  revalidatePath("/knowledge", "layout");
  return {
    ok: true,
    href: `/knowledge/${input.kind === "metric" ? "metrics" : "datasets"}/${r.id}`,
    version: r.version,
  };
}

/** Dismisses a report (it's been dealt with, or the answer was right), or opens it again. Owners and admins. */
export async function setReportStatusAction(id: string, status: "new" | "ignored"): Promise<{ message?: string }> {
  const viewer = await requireTenant();
  if (!canVerify(viewer.role)) return { message: "Only owners and admins review feedback." };
  if (!isUuid(id) || (status !== "new" && status !== "ignored")) return { message: "That report doesn't exist." };
  const ok = await withTenant(viewer.ctx, (tx) => setReportStatus(tx, viewer.ctx.orgId, id, status));
  revalidatePath("/knowledge", "layout");
  return ok ? {} : { message: "That report doesn't exist." };
}
