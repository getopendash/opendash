import "server-only";
import {
  type Actor,
  type InsightReader,
  type InvestigationView,
  investigationsFor as investigations,
  listInsights,
  openInsightCount,
  watchedByRoutines,
} from "@opendash/core";
import { withTenant } from "@opendash/db";

/** The feed: open or closed insights this person sees (the workspace's and their own), most severe first. */
export const insightsFor = (reader: InsightReader, status: "open" | "closed" = "open", limit = 50) =>
  withTenant({ orgId: reader.orgId }, (tx) => listInsights(tx, reader, { status, limit }));

/** How many they see are open: the sidebar's count. */
export const openInsightsFor = (reader: InsightReader) =>
  withTenant({ orgId: reader.orgId }, (tx) => openInsightCount(tx, reader));

/** How many metrics routines watch: the Watching tab's count. */
export const watchedCountFor = async (actor: Actor) =>
  (await withTenant({ orgId: actor.orgId }, (tx) => watchedByRoutines(tx, actor))).length;

/** The investigations of these insights (the Investigator), by insight. */
export const investigationsFor = async (
  orgId: string,
  insightIds: string[],
): Promise<Record<string, InvestigationView>> =>
  Object.fromEntries(await withTenant({ orgId }, (tx) => investigations(tx, orgId, insightIds)));
