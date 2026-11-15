/**
 * Apps built before select to edit have bundles that don't mark their pieces, so Select finds nothing in them. Once
 * at start, each such stored bundle (a draft's or a version's) is built again from its own stored files, with the
 * same build a save uses. Only the bundle and its hash change: the source, the revision and every check of it stay,
 * since the App is the same code. A bundle that marks its pieces is left alone, so this does nothing after one pass.
 */
import { marksPieces, previewParts } from "@opendash/apps/build";
import { loggableError } from "@opendash/core";
import { type SystemTx, sql } from "@opendash/db";

interface RebuildCtx {
  withSystem: <T>(fn: (tx: SystemTx) => Promise<T>) => Promise<T>;
  log: (msg: string, fields?: Record<string, unknown>) => void;
}

type Stored = { kind: "draft" | "version"; org_id: string; dashboard_id: string; version: number | null };

export async function rebuildUnmarkedBundles(ctx: RebuildCtx): Promise<void> {
  // Which ones, without loading every bundle at once: each is read and built on its own.
  const stored = await ctx.withSystem((tx) =>
    tx.execute<Stored>(sql`
      select 'draft' as kind, org_id, dashboard_id, null::int as version from app.dashboard_draft
      where bundle is not null and strpos(bundle, 'jsxDevRuntime') = 0
      union all
      select 'version', org_id, dashboard_id, version from app.dashboard_version
      where bundle is not null and strpos(bundle, 'jsxDevRuntime') = 0`),
  );
  let rebuilt = 0;
  let failed = 0;
  for (const row of stored) {
    try {
      const done = await ctx.withSystem(async (tx) => {
        const [had] =
          row.kind === "draft"
            ? await tx.execute<{ parts: Record<string, string> | null; bundle: string }>(sql`
                select parts, bundle from app.dashboard_draft
                where org_id = ${row.org_id} and dashboard_id = ${row.dashboard_id}`)
            : await tx.execute<{ parts: Record<string, string> | null; bundle: string }>(sql`
                select parts, bundle from app.dashboard_version
                where org_id = ${row.org_id} and dashboard_id = ${row.dashboard_id} and version = ${row.version}`);
        if (!had?.parts || marksPieces(had.bundle)) return false;
        const built = await previewParts(had.parts);
        if (!built) return false;
        if (row.kind === "draft") {
          await tx.execute(sql`
            update app.dashboard_draft set bundle = ${built.bundle}, bundle_hash = ${built.bundleHash}
            where org_id = ${row.org_id} and dashboard_id = ${row.dashboard_id} and bundle = ${had.bundle}`);
        } else {
          await tx.execute(sql`
            update app.dashboard_version set bundle = ${built.bundle}, bundle_hash = ${built.bundleHash}
            where org_id = ${row.org_id} and dashboard_id = ${row.dashboard_id} and version = ${row.version}`);
        }
        return true;
      });
      if (done) rebuilt++;
      else failed++;
    } catch (error) {
      failed++;
      ctx.log("bundle rebuild failed", { dashboardId: row.dashboard_id, kind: row.kind, error: loggableError(error) });
    }
  }
  if (stored.length) ctx.log("bundles rebuilt to mark their pieces", { rebuilt, left: failed });
}
