// pnpm auth:two-factor-off <email> — for the deployment's operator: turns off a person's two-factor sign-in when
// they've lost the app and their backup codes, and signs them out everywhere (src/recovery.ts).
import path from "node:path";
import { closeDatabases, withSystem } from "@opendash/db";
import { getAuthDatabase } from "@opendash/db/auth";
import { loadRootEnv } from "../../../scripts/load-env.mjs";
import { authAudit } from "../src/audit";
import { turnOffTwoFactor } from "../src/recovery";

loadRootEnv(path.resolve(import.meta.dirname, "../../.."));
const email = process.argv[2];
if (!email) {
  console.error("Usage: pnpm auth:two-factor-off <email>");
  process.exit(2);
}
try {
  const database = getAuthDatabase();
  const result = await turnOffTwoFactor(database, email);
  if (!result.found) {
    console.error(`No account for ${email}.`);
    process.exitCode = 1;
  } else {
    // In each of their workspaces' audit logs, as the deployment's own doing.
    const audits = authAudit({ db: database.db, system: withSystem, ipAddress: {} });
    const operator = { type: "system" as const, name: "The deployment's operator" };
    const target = { type: "user" as const, id: result.userId, name: email };
    if (result.wasOn) await audits.forUser(result.userId, { action: "two_factor.disabled", actor: operator, target });
    if (result.keys > 0) {
      await audits.forUser(result.userId, {
        action: "api_key.revoked",
        actor: operator,
        target,
        detail: { owner: "user", count: result.keys },
      });
    }
    console.info(
      `${result.wasOn ? "Two-factor is off" : "Two-factor wasn't on"} for ${email}; signed out of ${result.sessions} session(s). They sign in with their password next, and can turn it on again in Settings → Security.`,
    );
  }
} finally {
  await closeDatabases();
}
