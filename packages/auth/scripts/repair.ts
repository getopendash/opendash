// pnpm auth:repair — finishes setting up organizations that have no app.org row or data key. Safe to re-run.
import path from "node:path";
import { kekFromEnv } from "@opendash/core";
import { closeDatabases } from "@opendash/db";
import { getAuthDatabase } from "@opendash/db/auth";
import { loadRootEnv } from "../../../scripts/load-env.mjs";
import { provisionMissingOrgs } from "../src/provision";

loadRootEnv(path.resolve(import.meta.dirname, "../../.."));
try {
  const fixed = await provisionMissingOrgs({ database: getAuthDatabase(), kek: kekFromEnv() });
  console.info(fixed.length ? `Set up ${fixed.length} organization(s): ${fixed.join(", ")}` : "Nothing to repair.");
} finally {
  await closeDatabases();
}
