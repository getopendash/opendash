"use server";

import {
  ConnectionError,
  chooseLearnedTables,
  connectFromTest,
  getSource,
  learningChoice,
  listSyncRuns,
  loggableError,
  renameSource,
} from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import { revalidatePath } from "next/cache";
import { startConnectionTest } from "@/app/(app)/data/sources/new/actions";
import { CLICKHOUSE_PLAYGROUND } from "@/components/sources/playground";
import { requireTenant } from "@/lib/auth";
import { SAMPLE_SOURCE_NAME, SAMPLE_TABLES } from "@/lib/onboarding";
import { canManageSources, queue } from "@/lib/sources";

/**
 * The sample data in one press (the guided setup's Data step): ClickHouse's public playground, checked like any
 * source, connected, named, and its best tables for first questions chosen for the person, who'd otherwise face 90
 * tables to pick from. Each step is the product's own (the check, the connection, the choice of what's learned):
 * these only string them together, and the page follows them through `sampleDataProgress`.
 */

async function admin() {
  const viewer = await requireTenant();
  return canManageSources(viewer.role) ? viewer : null;
}

/** Starts the check of the playground: the page follows it like any connection check. */
export async function startSampleData(): Promise<{ ok: true; testId: string } | { ok: false; message: string }> {
  const result = await startConnectionTest({ ...CLICKHOUSE_PLAYGROUND, dialect: "clickhouse" });
  if (result.ok) return result;
  return { ok: false, message: result.message ?? "The sample data couldn't be checked. Try again in a moment." };
}

/** The check passed: the playground becomes a source, under its own name, and its first sync starts. */
export async function connectSampleData(
  testId: string,
): Promise<{ ok: true; connectionId: string } | { ok: false; message: string }> {
  const viewer = await admin();
  if (!viewer) return { ok: false, message: "Only owners and admins can connect data sources." };
  if (typeof testId !== "string" || !isUuid(testId)) return { ok: false, message: "That check doesn't exist." };
  const ctx = { orgId: viewer.ctx.orgId, userId: viewer.user.id };
  try {
    const boss = await queue();
    const connectionId = await withTenant(viewer.ctx, async (tx) => {
      const id = await connectFromTest({ boss }, tx, ctx, { testId, acceptWriteAccess: false });
      // "default" is its database's name; a name already taken (connected twice) keeps the database's.
      await renameSource(tx, ctx, id, SAMPLE_SOURCE_NAME);
      return id;
    });
    revalidatePath("/", "layout");
    return { ok: true, connectionId };
  } catch (error) {
    if (error instanceof ConnectionError) return { ok: false, message: error.message };
    console.error(JSON.stringify({ msg: "sample data not connected", error: loggableError(error) }));
    return { ok: false, message: "The sample data couldn't be connected. Try again." };
  }
}

export interface SampleDataProgress {
  /** reading: its schema is being read; learning: the chosen tables are being profiled; ready: it can be asked. */
  phase: "reading" | "learning" | "ready" | "failed";
  /** Tables found in it, once its schema is read. */
  tables: number | null;
  /** The tables being learned, by short name. */
  learning: string[];
  message: string | null;
}

/**
 * Where the sample data stands, and its next step taken when it's due: once its schema is read and nobody has chosen
 * what to learn, the tables that make good first questions are chosen (those the playground has today), which
 * starts the sync that learns them. Safe to call again and again: it's what the page polls.
 */
export async function sampleDataProgress(connectionId: string): Promise<SampleDataProgress> {
  const failed = (message: string): SampleDataProgress => ({ phase: "failed", tables: null, learning: [], message });
  const viewer = await admin();
  if (!viewer || typeof connectionId !== "string" || !isUuid(connectionId)) {
    return failed("That source doesn't exist.");
  }
  const ctx = { orgId: viewer.ctx.orgId, userId: viewer.user.id };
  try {
    const boss = await queue();
    const progress = await withTenant(viewer.ctx, async (tx): Promise<SampleDataProgress> => {
      const source = await getSource(tx, ctx.orgId, connectionId);
      if (!source) return failed("That source doesn't exist.");
      const [run] = await listSyncRuns(tx, ctx.orgId, connectionId, 1);
      const active = run?.status === "queued" || run?.status === "running";
      if (run?.status === "failed" && !source.learnedAt) {
        return failed(run.message ?? "The sample data couldn't be read. Try again in a moment.");
      }
      // Its first sync, reading the schema.
      if (!source.learnedAt) return { phase: "reading", tables: source.tables, learning: [], message: null };
      const choice = await learningChoice(tx, ctx.orgId, connectionId);
      const names = new Set((choice?.tables ?? []).map((t) => t.name));
      const picks = SAMPLE_TABLES.filter((name) => names.has(name));
      const short = (name: string) => name.replace(/^default\./, "");
      if (choice && !choice.chosen && !active) {
        // The playground changed and has none of them: what OpenDash would pick itself is learned instead.
        const chosen = picks.length ? picks : choice.tables.filter((t) => t.ticked).map((t) => t.name);
        if (chosen.length) {
          await chooseLearnedTables({ boss }, tx, ctx, connectionId, chosen);
          return { phase: "learning", tables: names.size, learning: chosen.map(short), message: null };
        }
      }
      const learning = (choice?.tables ?? []).filter((t) => t.ticked).map((t) => short(t.name));
      if (active || !choice?.chosen) return { phase: "learning", tables: names.size, learning, message: null };
      if (run?.status === "failed") {
        return failed(run.message ?? "The sample data couldn't be learned. Try again from Data → Sources.");
      }
      return { phase: "ready", tables: names.size, learning, message: null };
    });
    if (progress.phase === "ready") revalidatePath("/", "layout");
    return progress;
  } catch (error) {
    console.error(JSON.stringify({ msg: "sample data progress not read", error: loggableError(error) }));
    return failed("The sample data's progress couldn't be read. It may still be learning: check Data → Sources.");
  }
}
