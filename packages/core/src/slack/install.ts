/**
 * Add to Slack on its way: Slack returns to OpenDash's public address (a tunnel locally, the
 * cloud's own domain in production), where the browser's session may not be. So the callback only holds what Slack
 * gave (the bot token, encrypted, and the team), and the person who started it connects it by confirming, signed in,
 * from the browser they started in (a secret it keeps), the one Slack sent back (a code it carries), pressing Connect on
 * a page that names both workspaces. Without that last step, someone could start an install in their own OpenDash
 * workspace and have another workspace's admin approve it.
 */
import { createHash, randomBytes } from "node:crypto";
import { type SystemTx, sql, type TenantTx, uuidv7 } from "@opendash/db";
import type { SecretStore } from "../secrets/store";
import type { SlackTeam } from "./slack";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(24).toString("base64url");

/** How long an install may take, from Add to Slack to confirmed. */
export const SLACK_INSTALL_MINUTES = 10;

/**
 * Starts an install for an owner or admin (checked by the caller): its id, and the secret their browser keeps. Their
 * earlier unfinished ones here go, with any token they held, so one person has one at a time.
 */
export async function startSlackInstall(
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
): Promise<{ installId: string; browserSecret: string }> {
  const earlier = await tx.execute<{ secret_id: string | null }>(sql`
    delete from app.slack_install where org_id = ${ctx.orgId} and user_id = ${ctx.userId} returning secret_id`);
  for (const e of earlier) {
    if (e.secret_id) await tx.execute(sql`delete from app.secret where org_id = ${ctx.orgId} and id = ${e.secret_id}`);
  }
  const installId = uuidv7();
  const browserSecret = secret();
  await tx.execute(sql`
    insert into app.slack_install (org_id, id, user_id, browser_hash, expires_at)
    values (${ctx.orgId}, ${installId}, ${ctx.userId}, ${hash(browserSecret)},
      now() + make_interval(mins => ${SLACK_INSTALL_MINUTES}))`);
  return { installId, browserSecret };
}

/** Slack came back for it: once, while it's fresh. False when it was used, expired, or never was. */
export async function returnSlackInstall(tx: TenantTx, orgId: string, installId: string): Promise<boolean> {
  const rows = await tx.execute(sql`
    update app.slack_install set status = 'returned'
    where org_id = ${orgId} and id = ${installId} and status = 'started' and expires_at > now()
    returning id`);
  return rows.length > 0;
}

/** Holds what Slack gave until it's confirmed: the token encrypted, and the team. The code goes to the browser. */
export async function holdSlackInstall(
  deps: { secrets: SecretStore },
  tx: TenantTx,
  orgId: string,
  installId: string,
  team: SlackTeam,
  token: string,
): Promise<string> {
  const code = secret();
  const secretId = await deps.secrets.put(tx, orgId, "oauth", token);
  const held = await tx.execute(sql`
    update app.slack_install set secret_id = ${secretId}, team = ${JSON.stringify(team)}::jsonb,
      confirm_hash = ${hash(code)}
    where org_id = ${orgId} and id = ${installId} and status = 'returned' and secret_id is null
    returning id`);
  // Gone meanwhile (replaced by a newer one, or purged): nothing is held, and the secret isn't kept either.
  if (!held.length) throw new SlackInstallGone();
  return code;
}

/** An install that isn't there to hold Slack's answer any more. */
export class SlackInstallGone extends Error {
  constructor() {
    super("That Add to Slack isn't waiting any more.");
  }
}

/**
 * Slack said no, or the person cancelled there: an install still waiting for Slack goes. One Slack came back to (held,
 * waiting to be confirmed) isn't touched by this, since anyone holding the callback's address could ask for it.
 */
export async function cancelSlackInstall(tx: TenantTx, orgId: string, installId: string): Promise<void> {
  await tx.execute(sql`
    delete from app.slack_install where org_id = ${orgId} and id = ${installId} and status = 'started'`);
}

/** Forgets an install, and any token it held. */
export async function dropSlackInstall(tx: TenantTx, orgId: string, installId: string): Promise<void> {
  const [gone] = await tx.execute<{ secret_id: string | null }>(sql`
    delete from app.slack_install where org_id = ${orgId} and id = ${installId} returning secret_id`);
  if (gone?.secret_id) await tx.execute(sql`delete from app.secret where org_id = ${orgId} and id = ${gone.secret_id}`);
}

const heldBy = (
  ctx: { orgId: string; userId: string },
  input: { installId: string; code: string; browserSecret: string },
) =>
  sql`org_id = ${ctx.orgId} and id = ${input.installId} and user_id = ${ctx.userId} and status = 'returned'
    and expires_at > now() and browser_hash = ${hash(input.browserSecret)} and confirm_hash = ${hash(input.code)}`;

/**
 * Which Slack workspace a held install would connect, for the page that asks to confirm it: only for the person who
 * started it, from the browser they started in, with the code Slack's return carried, while it's fresh.
 */
export async function heldSlackInstall(
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  input: { installId: string; code: string; browserSecret: string },
): Promise<SlackTeam | null> {
  if (!input.code || !input.browserSecret) return null;
  const [row] = await tx.execute<{ team: SlackTeam | null }>(sql`
    select team from app.slack_install where ${heldBy(ctx, input)} and secret_id is not null`);
  return row?.team ?? null;
}

/**
 * Takes a held install to connect: only for the person who started it, from the browser they started in, with the
 * code Slack's return carried, while it's fresh; once. Its token and team, or null.
 */
export async function takeSlackInstall(
  deps: { secrets: SecretStore },
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  input: { installId: string; code: string; browserSecret: string },
): Promise<{ team: SlackTeam; token: string } | null> {
  if (!input.code || !input.browserSecret) return null;
  const [row] = await tx.execute<{ secret_id: string | null; team: SlackTeam | null }>(sql`
    select secret_id, team from app.slack_install where ${heldBy(ctx, input)} for update`);
  if (!row?.secret_id || !row.team) return null;
  const token = await deps.secrets.reveal(tx, ctx.orgId, row.secret_id, "oauth");
  await dropSlackInstall(tx, ctx.orgId, input.installId);
  return { team: row.team, token };
}

/** Installs never confirmed, an hour after they expired, with the tokens they held (maint, hourly). */
export async function purgeSlackInstalls(
  withSystem: <T>(fn: (tx: SystemTx) => Promise<T>) => Promise<T>,
): Promise<number> {
  return withSystem(async (tx) => {
    const gone = await tx.execute<{ org_id: string; secret_id: string | null }>(sql`
      delete from app.slack_install where expires_at < now() - interval '1 hour' returning org_id, secret_id`);
    for (const g of gone) {
      if (g.secret_id) await tx.execute(sql`delete from app.secret where org_id = ${g.org_id} and id = ${g.secret_id}`);
    }
    return gone.length;
  });
}
