/**
 * Break-glass for whoever runs the deployment: disables an identity provider from the server, for when it's broken and
 * enforcement keeps everyone at its domain out, owners included. The same as Disable on the settings page: nobody signs
 * in through it, its sessions end, requiring it lifts; its settings and domain proof stay. Recorded in the workspace's
 * audit log as done from the server.
 *
 *   pnpm sso:disable --provider <provider id>
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { auditSystem } from "@opendash/core";
import { closeDatabases, withSystem } from "@opendash/db";
import { getAuthDatabase, authTables as t } from "@opendash/db/auth";
import { eq } from "drizzle-orm";
import { loadRootEnv } from "../../scripts/load-env.mjs";
import { disableProvider } from "../src/sso/manage";

loadRootEnv(path.resolve(import.meta.dirname, "../.."));
const { values } = parseArgs({ options: { provider: { type: "string" } } });
const providerId = values.provider?.trim() ?? "";
if (!providerId) {
  console.error("Usage: pnpm sso:disable --provider <provider id>");
  process.exit(2);
}
try {
  const { db } = getAuthDatabase();
  const [row] = await db.select().from(t.ssoProvider).where(eq(t.ssoProvider.providerId, providerId));
  if (!row) {
    console.error(`No provider ${providerId} on this instance.`);
    process.exitCode = 1;
  } else {
    const { sessionsEnded } = await disableProvider(db, row);
    await withSystem((tx) =>
      auditSystem(tx, row.organizationId, {
        action: "sso.disabled",
        actor: { type: "system", name: "The deployment's operator" },
        target: { type: "sso_provider", name: row.name },
        detail: { domain: row.domain, sessionsEnded, by: "operator" },
      }),
    );
    console.info(
      `Disabled ${row.name || providerId} (${row.domain}): ${sessionsEnded} ${sessionsEnded === 1 ? "session" : "sessions"} ended${row.enforceSso ? ", and single sign-on is no longer required there" : ""}. People can sign in by email again.`,
    );
  }
} finally {
  await closeDatabases();
}
