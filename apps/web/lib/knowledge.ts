import "server-only";
import {
  type DefinitionKind,
  type DefinitionStatus,
  getDefinition,
  listDefinitions,
  loadSemanticModel,
  reportsForDefinition,
} from "@opendash/core";
import { withTenant } from "@opendash/db";
import { cache } from "react";

/** A source's (or every source's) definitions, for Knowledge's lists. */
export const definitionsFor = (
  orgId: string,
  filter: { kind?: DefinitionKind; status?: DefinitionStatus; connectionId?: string } = {},
) => withTenant({ orgId }, (tx) => listDefinitions(tx, orgId, filter));

/** One definition with its history; loaded once per request (metadata and page). */
export const definitionFor = cache((orgId: string, userId: string, id: string) =>
  withTenant({ orgId, userId }, (tx) => getDefinition(tx, { orgId, userId }, id)),
);

/** Only owners and admins verify definitions: verified is what every answer on the metric path trusts. */
export const canVerify = (role: string) => role === "owner" || role === "admin";

/** A source's definitions as a model, proposals included: what a definition's page shows it joins and groups by. */
export const sourceModelFor = cache((orgId: string, connectionId: string) =>
  withTenant({ orgId }, (tx) => loadSemanticModel(tx, orgId, connectionId, { includeUnverified: true })),
);

/** Open reports on answers that used a definition (its page). */
export const reportsFor = (orgId: string, userId: string, itemId: string) =>
  withTenant({ orgId, userId }, (tx) => reportsForDefinition(tx, { orgId, userId }, itemId));
