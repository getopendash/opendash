/**
 * For whoever runs the deployment: verifies an organization's audit chain from the server, as the system role, the same
 * walk as the Verify button. It exits 1 when a link is broken, naming the first event it found wrong.
 *
 *   pnpm audit:verify --org <organization id>
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { closeDatabases, isUuid, withSystem } from "@opendash/db";
import { loadRootEnv } from "../../scripts/load-env.mjs";
import { verifyChain } from "../src/audit/verify";

loadRootEnv(path.resolve(import.meta.dirname, "../.."));
const { values } = parseArgs({ options: { org: { type: "string" } } });
const org = values.org?.trim() ?? "";
if (!isUuid(org)) {
  console.error("Usage: pnpm audit:verify --org <organization id>");
  process.exit(2);
}
try {
  const result = await verifyChain((fn) => withSystem(fn), org);
  if (result.ok && result.agedOut) {
    console.info(
      `Every sealed event has passed the retention: nothing to walk. Head ${result.head ?? "none yet"}: compare it with your last export's head, which should match.`,
    );
  } else if (result.ok) {
    console.info(
      `Verified ${result.checked} events${result.fromSeq > 1 ? ` from event ${result.fromSeq}` : ""}: the chain is intact. Head ${result.head ?? "none yet"}.`,
    );
  } else {
    console.error(
      `The chain breaks at event ${result.at.seq}${result.at.id ? ` (${result.at.id})` : ""}: ${result.reason}`,
    );
    process.exitCode = 1;
  }
} finally {
  await closeDatabases();
}
