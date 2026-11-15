import "server-only";
import { definitionUsage } from "@opendash/core";
import { withTenant } from "@opendash/db";

/** "Used by" for a definition's page and its editor. */
export const usageFor = (
  orgId: string,
  userId: string,
  d: { id: string; kind: "dataset" | "metric"; slug: string; connectionId: string },
) => withTenant({ orgId, userId }, (tx) => definitionUsage(tx, { orgId, userId }, d));
