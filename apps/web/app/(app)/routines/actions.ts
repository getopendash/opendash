"use server";

import {
  checkRoutineChannels,
  createRoutine,
  deleteRoutine,
  leaveRoutine,
  type RoutineInput,
  RoutineProblem,
  runRoutineNow,
  type Sensitivity,
  setOrgTz,
  setRoutineStatus,
  setSensitivity,
  unwatchMetric,
  updateRoutine,
  watchMetric,
} from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth";
import { canManageTeam } from "@/lib/roles";
import { slackDeps } from "@/lib/slack";
import { queue } from "@/lib/sources";

type Result<T = object> = ({ ok: true } & T) | { ok: false; message: string };

/** As the signed-in person; a routine's own problems come back in its words, and the routines' pages are redrawn. */
async function acting<T extends object>(
  fn: (
    actor: { orgId: string; userId: string; canManage: boolean },
    ctx: { orgId: string; userId: string },
  ) => Promise<T>,
): Promise<Result<T>> {
  const viewer = await requireTenant();
  const actor = { orgId: viewer.ctx.orgId, userId: viewer.user.id, canManage: canManageTeam(viewer.role) };
  try {
    const out = await fn(actor, { orgId: viewer.ctx.orgId, userId: viewer.user.id });
    revalidatePath("/routines", "layout");
    revalidatePath("/insights", "layout");
    return { ok: true, ...out };
  } catch (error) {
    if (error instanceof RoutineProblem) return { ok: false, message: error.message };
    throw error;
  }
}

const notFound = { ok: false as const, message: "That routine doesn't exist." };

/**
 * Saves a routine from the composer: a new one, or changes to one. Its Slack channels are checked with Slack first,
 * outside the save's transaction (there, not archived, OpenDash in each), and kept as Slack names them; the store
 * checks everything else it names.
 */
export async function saveRoutineAction(id: string | null, input: RoutineInput): Promise<Result<{ id: string }>> {
  if (id !== null && !isUuid(id)) return notFound;
  return acting(async (a, ctx) => {
    const slack = await checkRoutineChannels(slackDeps, a, input.slack ?? []);
    const checked = { ...input, slack };
    const saved = id ?? (await withTenant(ctx, (tx) => createRoutine(tx, a, checked)));
    if (id !== null) await withTenant(ctx, (tx) => updateRoutine(tx, a, id, checked));
    return { id: saved };
  });
}

export async function setRoutineStatusAction(id: string, status: "active" | "paused"): Promise<Result> {
  if (!isUuid(id)) return notFound;
  return acting(async (a, ctx) => {
    await withTenant(ctx, (tx) => setRoutineStatus(tx, a, id, status));
    return {};
  });
}

/** Run now (on a schedule) or Check now (one that watches). */
export async function runRoutineNowAction(id: string): Promise<Result<{ status: string }>> {
  if (!isUuid(id)) return notFound;
  const boss = await queue();
  return acting(async (a, ctx) => ({ status: await withTenant(ctx, (tx) => runRoutineNow(tx, boss, a, id)) }));
}

export async function deleteRoutineAction(id: string): Promise<Result> {
  if (!isUuid(id)) return notFound;
  return acting(async (a, ctx) => {
    await withTenant(ctx, (tx) => deleteRoutine(tx, a, id));
    return {};
  });
}

/** Stop sending it to me: off a routine that emails the person (theirs alone, it's deleted). */
export async function leaveRoutineAction(id: string): Promise<Result> {
  if (!isUuid(id)) return notFound;
  return acting(async (a, ctx) => {
    if (!(await withTenant(ctx, (tx) => leaveRoutine(tx, a, id)))) {
      throw new RoutineProblem("not_found", "You're not on that routine any more.");
    }
    return {};
  });
}

export async function setSensitivityAction(id: string, sensitivity: Sensitivity): Promise<Result> {
  if (!isUuid(id)) return notFound;
  return acting(async (a, ctx) => {
    await withTenant(ctx, (tx) => setSensitivity(tx, a, id, sensitivity));
    return {};
  });
}

/** The workspace's time zone, where its routines run and its metrics are checked (owners and admins). */
export async function setWorkspaceTzAction(tz: string): Promise<Result> {
  if (typeof tz !== "string") return { ok: false, message: "Pick a time zone from the list." };
  return acting(async (a, ctx) => {
    await withTenant(ctx, (tx) => setOrgTz(tx, a, tz));
    return {};
  });
}

/** One-tap Watch from a tile: the metric joins the workspace's Watching (owners and admins). */
export async function watchMetricAction(metricId: string, watch: boolean): Promise<Result> {
  if (!isUuid(metricId)) return { ok: false, message: "That metric doesn't exist." };
  return acting(async (a, ctx) => {
    await withTenant(ctx, async (tx) => {
      if (watch) await watchMetric(tx, a, metricId);
      else if (!(await unwatchMetric(tx, a, metricId))) {
        throw new RoutineProblem("not_found", "Watching doesn't watch that metric.");
      }
    });
    return {};
  });
}
