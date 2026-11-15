import type { EnterpriseAudit } from "@opendash/core/enterprise";
import { exportAudit } from "./export";
import { seal } from "./seal";
import { chainStatus, verifyChain } from "./verify";

export { canonical, linkHash, sortedJson, ZERO } from "./chain";
export { CSV_COLUMNS, csvCell, exportAudit } from "./export";
export { SEAL_LIMITS, seal, sealOrg } from "./seal";
export { chainStatus, verifyChain } from "./verify";

/** ee/'s audit chain, handed to the core through each app's enterprise.ts. */
export const auditChain = (): EnterpriseAudit => ({
  seal,
  status: chainStatus,
  verify: verifyChain,
  export: exportAudit,
});
