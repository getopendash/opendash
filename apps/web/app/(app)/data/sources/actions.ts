"use server";

import {
  applySourceUpdate,
  ConnectionError,
  type LimitErrors,
  parseSourceSettings,
  removeSource,
  renameSource,
  requestRetest,
  requestSourceUpdate,
  requestSync,
  type SettingsErrors,
  type SyncSchedule,
  setColumnSensitivity,
  setSourceDisabled,
  setSourceLimits,
  setSyncSchedule,
} from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireTenant } from "@/lib/auth";
import { canManageSources, getSource, queue, secretStore } from "@/lib/sources";

/** Sync now: learn the source again (one run at a time), then show its progress on the source's page. */
export async function syncSource(id: string): Promise<{ message: string }> {
  const viewer = await requireTenant();
  if (!canManageSources(viewer.role)) return { message: "Only owners and admins can sync sources." };
  if (typeof id !== "string" || !isUuid(id)) return { message: "That source doesn't exist." };
  const source = await getSource(viewer.ctx, id);
  if (!source) return { message: "That source doesn't exist." };
  if (source.status === "disabled") return { message: "This source is disabled." };
  try {
    const boss = await queue();
    await withTenant(viewer.ctx, (tx) =>
      requestSync({ boss }, tx, { orgId: viewer.ctx.orgId, userId: viewer.user.id }, id),
    );
  } catch (error) {
    console.error(JSON.stringify({ msg: "sync request failed", error: String(error) }));
    return { message: "Couldn't start syncing. Try again in a moment." };
  }
  revalidatePath("/", "layout");
  redirect(`/data/sources/${id}`);
}

/**
 * Test connection: check the source again with its own settings and secret. The page then shows the check as
 * it runs; the result is applied to the source when it finishes.
 */
export async function testSource(id: string): Promise<{ message: string } | undefined> {
  const viewer = await requireTenant();
  if (!canManageSources(viewer.role)) return { message: "Only owners and admins can test sources." };
  if (typeof id !== "string" || !isUuid(id)) return { message: "That source doesn't exist." };
  try {
    const boss = await queue();
    await withTenant(viewer.ctx, (tx) =>
      requestRetest({ boss }, tx, { orgId: viewer.ctx.orgId, userId: viewer.user.id }, id),
    );
  } catch (error) {
    if (error instanceof ConnectionError) return { message: error.message };
    console.error(JSON.stringify({ msg: "source test request failed", error: String(error) }));
    return { message: "Couldn't start the check. Try again in a moment." };
  }
  revalidatePath(`/data/sources/${id}`);
}

/**
 * An admin marks a column as personal data, or clears the mark. Marking removes what OpenDash kept of its values
 * at once; later syncs keep the choice.
 */
export async function setColumnPersonal(
  sourceId: string,
  columnId: string,
  personal: boolean,
): Promise<{ message: string } | undefined> {
  const viewer = await requireTenant();
  if (!canManageSources(viewer.role)) return { message: "Only owners and admins can change this." };
  if (typeof sourceId !== "string" || !isUuid(sourceId) || typeof columnId !== "string") {
    return { message: "That column doesn't exist." };
  }
  const result = await withTenant(viewer.ctx, (tx) =>
    setColumnSensitivity(
      tx,
      { orgId: viewer.ctx.orgId, userId: viewer.user.id },
      sourceId,
      columnId,
      personal === true,
    ),
  );
  if (!result.ok) {
    return {
      message:
        result.reason === "secret" ? "This column holds secrets and stays hidden." : "That column doesn't exist.",
    };
  }
  revalidatePath(`/data/sources/${sourceId}`, "layout");
}

/** Remove a source once its name is typed to confirm; then back to Sources. */
export async function deleteSource(id: string, confirmName: string): Promise<{ message: string }> {
  const viewer = await requireTenant();
  if (!canManageSources(viewer.role)) return { message: "Only owners and admins can remove sources." };
  if (typeof id !== "string" || typeof confirmName !== "string") return { message: "That source doesn't exist." };
  const result = await withTenant(viewer.ctx, (tx) => removeSource(tx, { orgId: viewer.ctx.orgId }, id, confirmName));
  if (!result.ok) {
    return {
      message: result.reason === "name_mismatch" ? "Type the source's name exactly." : "That source doesn't exist.",
    };
  }
  revalidatePath("/", "layout");
  redirect("/data/sources");
}

export interface SourceSettingsInput {
  host: string;
  port: string;
  database: string;
  user: string;
  sslMode: string;
  /** verify-full's CA certificate (PEM), as pasted; empty for the public CAs. */
  ca?: string;
  /** As typed; null keeps the saved password (same host and port only). */
  password: string | null;
}

export type SettingsTestResult =
  | { ok: true; testId: string }
  | { ok: false; errors?: SettingsErrors; message?: string };

/** Test new settings or a new password for a source. Nothing changes until they're saved. */
export async function startSourceUpdateTest(id: string, input: SourceSettingsInput): Promise<SettingsTestResult> {
  const viewer = await requireTenant();
  if (!canManageSources(viewer.role)) return { ok: false, message: "Only owners and admins can change sources." };
  if (typeof id !== "string" || !isUuid(id)) return { ok: false, message: "That source doesn't exist." };
  const source = await getSource(viewer.ctx, id);
  if (!source) return { ok: false, message: "That source doesn't exist." };
  // Server actions take whatever the client sends: check the shape before anything else.
  const dialect = source.dialect === "clickhouse" || source.dialect === "mysql" ? source.dialect : "postgres";
  const parsed = parseSourceSettings(input as unknown as Record<string, unknown>, dialect);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const password = typeof input?.password === "string" ? input.password : undefined;
  try {
    const boss = await queue();
    const testId = await withTenant(viewer.ctx, (tx) =>
      requestSourceUpdate(
        { boss, secrets: secretStore() },
        tx,
        { orgId: viewer.ctx.orgId, userId: viewer.user.id },
        id,
        { config: parsed.config, ...(password === undefined ? {} : { password }) },
      ),
    );
    return { ok: true, testId };
  } catch (error) {
    if (
      error instanceof ConnectionError &&
      (error.code === "PASSWORD_TOO_LONG" || error.code === "PASSWORD_REQUIRED")
    ) {
      return { ok: false, errors: { password: error.message } };
    }
    if (error instanceof ConnectionError) return { ok: false, message: error.message };
    console.error(JSON.stringify({ msg: "source update test request failed", error: String(error) }));
    return { ok: false, message: "Couldn't start the check. Try again in a moment." };
  }
}

/** Save settings that passed their check, then learn the source again on its overview. */
export async function saveSourceUpdate(
  id: string,
  input: { testId: string; acceptWriteAccess: boolean },
): Promise<{ message: string }> {
  const viewer = await requireTenant();
  if (!canManageSources(viewer.role)) return { message: "Only owners and admins can change sources." };
  if (typeof id !== "string" || !isUuid(id) || typeof input?.testId !== "string") {
    return { message: "That check doesn't exist." };
  }
  try {
    const boss = await queue();
    await withTenant(viewer.ctx, (tx) =>
      applySourceUpdate({ boss }, tx, { orgId: viewer.ctx.orgId, userId: viewer.user.id }, id, {
        testId: input.testId,
        acceptWriteAccess: input.acceptWriteAccess === true,
      }),
    );
  } catch (error) {
    if (error instanceof ConnectionError) return { message: error.message };
    console.error(JSON.stringify({ msg: "source update failed", error: String(error) }));
    return { message: "Couldn't save the settings. Try again." };
  }
  revalidatePath("/", "layout");
  redirect(`/data/sources/${id}`);
}

/** Rename a source. */
export async function renameSourceAction(id: string, name: string): Promise<{ message: string } | undefined> {
  const viewer = await requireTenant();
  if (!canManageSources(viewer.role)) return { message: "Only owners and admins can rename sources." };
  if (typeof id !== "string" || typeof name !== "string") return { message: "That source doesn't exist." };
  const result = await withTenant(viewer.ctx, (tx) => renameSource(tx, { orgId: viewer.ctx.orgId }, id, name));
  if (!result.ok) {
    return {
      message:
        result.reason === "taken"
          ? "Another source already has that name."
          : result.reason === "invalid"
            ? "Use 1 to 63 characters."
            : "That source doesn't exist.",
    };
  }
  revalidatePath("/", "layout");
}

/** Danger zone: stop or resume all use of a source. */
export async function setSourceDisabledAction(id: string, disabled: boolean): Promise<{ message: string } | undefined> {
  const viewer = await requireTenant();
  if (!canManageSources(viewer.role)) return { message: "Only owners and admins can change sources." };
  if (typeof id !== "string") return { message: "That source doesn't exist." };
  const result = await withTenant(viewer.ctx, (tx) =>
    setSourceDisabled(tx, { orgId: viewer.ctx.orgId }, id, disabled === true),
  );
  if (!result.ok) return { message: "That source doesn't exist." };
  revalidatePath("/", "layout");
}

/** Sync: when the source is learned again on its own. */
export async function setSyncScheduleAction(
  id: string,
  schedule: SyncSchedule,
): Promise<{ message: string } | undefined> {
  const viewer = await requireTenant();
  if (!canManageSources(viewer.role)) return { message: "Only owners and admins can change sources." };
  if (typeof id !== "string") return { message: "That source doesn't exist." };
  // Only the three shapes the schedule knows; anything else is refused before it reaches the rule.
  const s: SyncSchedule | null =
    schedule?.every === "off" || schedule?.every === "6h"
      ? { every: schedule.every }
      : schedule?.every === "day" && Number.isInteger(schedule.hour) && schedule.hour >= 0 && schedule.hour <= 23
        ? { every: "day", hour: schedule.hour }
        : null;
  if (!s) return { message: "Pick a schedule." };
  const result = await withTenant(viewer.ctx, (tx) => setSyncSchedule(tx, { orgId: viewer.ctx.orgId }, id, s));
  if (!result.ok) return { message: "That source doesn't exist." };
  revalidatePath(`/data/sources/${id}`, "layout");
}

/** Query limits: how hard OpenDash may use this source. Only ever tighter than the gateway's own budget. */
export async function setSourceLimitsAction(
  id: string,
  limits: { parallel: number; statementSeconds: number; maxRows: number },
): Promise<{ message?: string; errors?: LimitErrors } | undefined> {
  const viewer = await requireTenant();
  if (!canManageSources(viewer.role)) return { message: "Only owners and admins can change sources." };
  if (typeof id !== "string" || !limits) return { message: "That source doesn't exist." };
  const result = await withTenant(viewer.ctx, (tx) =>
    setSourceLimits(tx, { orgId: viewer.ctx.orgId }, id, {
      parallel: Number(limits.parallel),
      statementMs: Number(limits.statementSeconds) * 1000,
      maxRows: Number(limits.maxRows),
    }),
  );
  if (!result.ok) return result.errors ? { errors: result.errors } : { message: "That source doesn't exist." };
  revalidatePath(`/data/sources/${id}`, "layout");
}
