import type { Enterprise } from "@opendash/core/enterprise";
import { auditChain } from "@opendash/ee/audit";
import { licenseGate } from "@opendash/ee/license";

let gate: Enterprise | undefined;

/**
 * The enterprise features this build carries and the license that unlocks them. The key is checked once, the first time
 * it's asked, so after the worker has read its settings. The only file in the worker that imports ee/ (lint enforces
 * it): a build without ee/ returns `communityEdition(process.env.NODE_ENV === "production")` from
 * @opendash/core/enterprise here instead.
 */
export const enterprise = (): Enterprise => {
  gate ??= { ...licenseGate(), audit: auditChain() };
  return gate;
};
