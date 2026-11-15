"use server";

import {
  analyticsConfig,
  ConnectionError,
  connectFromTest,
  getSource,
  parseSourceSettings,
  requestConnectionTest,
  type SettingsErrors,
  track,
} from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireTenant } from "@/lib/auth";
import { canManageSources, queue, secretStore } from "@/lib/sources";

export type TestRequestResult = { ok: true; testId: string } | { ok: false; errors?: SettingsErrors; message?: string };

export interface SourceFormInput {
  /** Which kind of database the form is for. */
  dialect: "postgres" | "clickhouse" | "mysql";
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  sslMode: string;
  /** verify-full's CA certificate (PEM), as pasted; empty for the public CAs. */
  ca?: string;
}

async function admin() {
  const viewer = await requireTenant();
  if (!canManageSources(viewer.role)) return null;
  return viewer;
}

/** Queues a connection test. The worker reports each step on the test row, which the form polls. */
export async function startConnectionTest(input: SourceFormInput): Promise<TestRequestResult> {
  const viewer = await admin();
  if (!viewer) return { ok: false, message: "Only owners and admins can connect data sources." };
  // Server actions take whatever the client sends: check the shape before anything else.
  const dialect = input?.dialect === "clickhouse" || input?.dialect === "mysql" ? input.dialect : "postgres";
  const parsed = parseSourceSettings(input as unknown as Record<string, unknown>, dialect);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const password = typeof input.password === "string" ? input.password : "";
  try {
    const boss = await queue();
    const testId = await withTenant(viewer.ctx, (tx) =>
      requestConnectionTest(
        { boss, secrets: secretStore() },
        tx,
        { orgId: viewer.ctx.orgId, userId: viewer.user.id },
        {
          dialect,
          config: parsed.config,
          password,
        },
      ),
    );
    return { ok: true, testId };
  } catch (error) {
    if (error instanceof ConnectionError && error.code === "PASSWORD_TOO_LONG") {
      return { ok: false, errors: { password: error.message } };
    }
    if (error instanceof ConnectionError) return { ok: false, message: error.message };
    console.error(JSON.stringify({ msg: "connection test request failed", error: String(error) }));
    return { ok: false, message: "Couldn't start the check. Try again in a moment." };
  }
}

/** Connect, or Connect anyway: create the connection from a finished test, then show it being learned. */
export async function connectSource(input: {
  testId: string;
  acceptWriteAccess: boolean;
}): Promise<{ message: string }> {
  const viewer = await admin();
  if (!viewer) return { message: "Only owners and admins can connect data sources." };
  if (typeof input?.testId !== "string" || !isUuid(input.testId)) return { message: "That check doesn't exist." };
  let id: string;
  try {
    const boss = await queue();
    id = await withTenant(viewer.ctx, (tx) =>
      connectFromTest(
        { boss },
        tx,
        { orgId: viewer.ctx.orgId, userId: viewer.user.id },
        { testId: input.testId, acceptWriteAccess: input.acceptWriteAccess === true },
      ),
    );
  } catch (error) {
    if (error instanceof ConnectionError) return { message: error.message };
    console.error(JSON.stringify({ msg: "connect source failed", error: String(error) }));
    return { message: "Couldn't save the connection. Try again." };
  }
  // Product analytics, only where it's on (POSTHOG_KEY): which kind of database, and whether it's the sample data.
  if (analyticsConfig()) {
    const source = await withTenant(viewer.ctx, (tx) => getSource(tx, viewer.ctx.orgId, id));
    void track({
      event: "source_connected",
      userId: viewer.user.id,
      orgId: viewer.ctx.orgId,
      properties: { dialect: source?.dialect ?? null, sample: source?.sample ?? false },
    });
  }
  // The shell (sidebar setup card, nav) reads the workspace too, so refresh the whole layout, not just the page.
  revalidatePath("/", "layout");
  // Watch it being learned.
  redirect(`/data/sources/${id}`);
}
