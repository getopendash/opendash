/**
 * Slack: a Slack workspace connected to one OpenDash workspace, the
 * people linked to their OpenDash accounts, the questions they ask there, and the record of each reply. The bot itself
 * (Chat SDK) is @opendash/slack; this is what it reads and writes, under the same rules as everything else.
 */
import { createHash, randomBytes } from "node:crypto";
import { isUuid, type PublicTx, type SystemTx, sql, type TenantTx, uuidv7 } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { AiProblem, choiceForQuestion, type DeploymentKeys } from "../ai/settings";
import { audit } from "../audit/write";
import { AttachmentProblem } from "../context/attachments";
import { enqueue } from "../jobs/boss";
import { type SlackReplyJob, slackReplyQueue } from "../jobs/queues";
import { type ClarifyQuestion, clarifyQuestions } from "../runs/clarify";
import { type LedgerDeps, NotFound, NotYours, RunActive, type RunOutcome, submitQuestion } from "../runs/ledger";
import { requestStop } from "../runs/threads";
import type { SecretStore } from "../secrets/store";
import { suggestedQuestions } from "../sources/catalog-view";
import { askableSources } from "../sources/summary";
import { SpendLimitReached } from "../usage/limits";
import { slackInboundAsked } from "./inbound";

export class SlackProblem extends Error {}

/** Why a Slack workspace couldn't be connected here: it's another OpenDash workspace's, or this one has another. */
export class SlackTaken extends SlackProblem {
  constructor(readonly where: "elsewhere" | "here") {
    super(
      where === "elsewhere"
        ? "This Slack workspace is connected to another OpenDash workspace."
        : "Another Slack workspace is connected here. Disconnect it first.",
    );
  }
}

type PublicDeps = { withPublic: <T>(fn: (tx: PublicTx) => Promise<T>) => Promise<T> };
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export interface SlackTeam {
  teamId: string;
  teamName: string;
  teamDomain: string | null;
  botUserId: string;
}

/**
 * Connects a Slack workspace from Add to Slack (an owner or admin, checked by the caller): its bot token kept
 * as an encrypted secret. The same workspace again (re-added after Slack took it back, or approved again) replaces its
 * token; one that's another OpenDash workspace's, or a second one here, is refused with SlackTaken.
 */
export async function connectSlack(
  deps: { secrets: SecretStore },
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  team: SlackTeam,
  botToken: string,
): Promise<void> {
  const [elsewhere] = await tx.execute<{ org_id: string }>(sql`select org_id from app.slack_team(${team.teamId})`);
  if (elsewhere && elsewhere.org_id !== ctx.orgId) throw new SlackTaken("elsewhere");
  const [mine] = await tx.execute<{ team_id: string; secret_id: string | null }>(sql`
    select team_id, secret_id from app.slack_workspace where org_id = ${ctx.orgId} for update`);
  if (mine && mine.team_id !== team.teamId) throw new SlackTaken("here");
  const secretId = await deps.secrets.put(tx, ctx.orgId, "oauth", botToken);
  await tx.execute(sql`
    insert into app.slack_workspace (org_id, team_id, team_name, team_domain, bot_user_id, secret_id, connected_by)
    values (${ctx.orgId}, ${team.teamId}, ${team.teamName}, ${team.teamDomain}, ${team.botUserId}, ${secretId},
      ${ctx.userId})
    on conflict (org_id, team_id) do update set team_name = excluded.team_name, team_domain = excluded.team_domain,
      bot_user_id = excluded.bot_user_id, secret_id = excluded.secret_id, connected_by = excluded.connected_by,
      connected_at = now(), removed_at = null, removed_why = null`);
  if (mine?.secret_id && mine.secret_id !== secretId) {
    await tx.execute(sql`delete from app.secret where org_id = ${ctx.orgId} and id = ${mine.secret_id}`);
  }
  await audit(tx, {
    action: "slack.installed",
    actor: { type: "user", id: ctx.userId },
    target: { type: "slack", name: team.teamName },
  });
}

export interface SlackWorkspaceView extends SlackTeam {
  connectedBy: string | null;
  connectedAt: string;
  /** Slack took the app back: when, and how (uninstalled there, or its token revoked). */
  removed: { at: string; why: "uninstalled" | "tokens_revoked" } | null;
}

export async function slackWorkspace(tx: TenantTx, orgId: string): Promise<SlackWorkspaceView | null> {
  const [w] = await tx.execute<{
    team_id: string;
    team_name: string;
    team_domain: string | null;
    bot_user_id: string;
    connected_by: string | null;
    connected_at: string;
    removed_at: string | null;
    removed_why: "uninstalled" | "tokens_revoked" | null;
  }>(sql`select * from app.slack_workspace where org_id = ${orgId}`);
  if (!w) return null;
  return {
    teamId: w.team_id,
    teamName: w.team_name,
    teamDomain: w.team_domain,
    botUserId: w.bot_user_id,
    connectedBy: w.connected_by,
    connectedAt: new Date(w.connected_at).toISOString(),
    removed: w.removed_at && w.removed_why ? { at: new Date(w.removed_at).toISOString(), why: w.removed_why } : null,
  };
}

/**
 * Disconnects it: its token, links, conversations' Slack threads and pending links go; the conversations stay. The
 * token is handed back so the caller revokes it at Slack, after this transaction (never during it).
 */
export async function disconnectSlack(
  deps: { secrets: SecretStore },
  tx: TenantTx,
  orgId: string,
): Promise<{ disconnected: boolean; token: string | null; unreadable: boolean }> {
  const [w] = await tx.execute<{ secret_id: string | null }>(sql`
    select secret_id from app.slack_workspace where org_id = ${orgId} for update`);
  if (!w) return { disconnected: false, token: null, unreadable: false };
  const token = w.secret_id ? await deps.secrets.reveal(tx, orgId, w.secret_id, "oauth").catch(() => null) : null;
  const [gone] = await tx.execute<{ team_name: string }>(sql`
    delete from app.slack_workspace where org_id = ${orgId} returning team_name`);
  if (w.secret_id) await tx.execute(sql`delete from app.secret where org_id = ${orgId} and id = ${w.secret_id}`);
  await audit(tx, { action: "slack.removed", target: { type: "slack", name: gone?.team_name ?? null } });
  // A token that couldn't be read can't be revoked: the caller says so, rather than a plain success.
  return { disconnected: true, token, unreadable: Boolean(w.secret_id) && !token };
}

/**
 * Slack took the app back from a workspace: `app_uninstalled`, or its bot token revoked. The workspace is
 * marked removed and its token deleted, so nothing more is posted there, and replies still going are closed quietly.
 * The links stay, for when it's added again. Not applied to an install made after Slack's event (a retried event
 * arriving late), nor for a token revoked that isn't this workspace's bot's. False when nothing was removed.
 */
export async function slackRemovedBySlack(
  deps: PublicDeps & Pick<LedgerDeps, "withTenant">,
  removal: {
    teamId: string;
    why: "uninstalled" | "tokens_revoked";
    eventTime?: number | null;
    botUserIds?: string[];
  },
): Promise<boolean> {
  const [team] = await deps.withPublic((tx) =>
    tx.execute<{ org_id: string; bot_user_id: string }>(
      sql`select org_id, bot_user_id from app.slack_team(${removal.teamId})`,
    ),
  );
  if (!team) return false;
  if (removal.why === "tokens_revoked" && !removal.botUserIds?.includes(team.bot_user_id)) return false;
  const at = removal.eventTime ?? null;
  return deps.withTenant(team.org_id, async (tx) => {
    const [w] = await tx.execute<{ secret_id: string | null }>(sql`
      select secret_id from app.slack_workspace
      where org_id = ${team.org_id} and team_id = ${removal.teamId} and removed_at is null
        and (${at}::double precision is null or connected_at < to_timestamp(${at}::double precision))
      for update`);
    if (!w) return false;
    const [gone] = await tx.execute<{ team_name: string }>(sql`
      update app.slack_workspace set removed_at = now(), removed_why = ${removal.why}, secret_id = null
      where org_id = ${team.org_id} and team_id = ${removal.teamId}
      returning team_name`);
    await audit(tx, {
      action: "slack.removed",
      actor: { type: "slack", name: "Slack" },
      target: { type: "slack", name: gone?.team_name ?? null },
      detail: { by: removal.why },
    });
    if (w.secret_id) {
      await tx.execute(sql`delete from app.secret where org_id = ${team.org_id} and id = ${w.secret_id}`);
    }
    await tx.execute(sql`
      update app.slack_reply set status = 'failed', finished_at = now()
      where org_id = ${team.org_id} and team_id = ${removal.teamId} and status = 'streaming'`);
    return true;
  });
}

export interface SlackIdentityView {
  slackUserId: string;
  /** Their Slack name, when Slack shared it. */
  slackUserName: string | null;
  userId: string;
  linkedAt: string;
}

/** Who's linked here: each Slack account and the member it belongs to. */
export async function slackIdentities(tx: TenantTx, orgId: string): Promise<SlackIdentityView[]> {
  const rows = await tx.execute<{
    slack_user_id: string;
    slack_user_name: string | null;
    user_id: string;
    linked_at: string;
  }>(sql`
    select slack_user_id, slack_user_name, user_id, linked_at from app.slack_identity
    where org_id = ${orgId} order by linked_at`);
  return rows.map((r) => ({
    slackUserId: r.slack_user_id,
    slackUserName: r.slack_user_name,
    userId: r.user_id,
    linkedAt: new Date(r.linked_at).toISOString(),
  }));
}

/** A person's own Slack link here, if they have one (Settings → Security, App Home). */
export async function mySlackIdentity(
  tx: TenantTx,
  orgId: string,
  userId: string,
): Promise<(SlackIdentityView & { teamName: string }) | null> {
  const [r] = await tx.execute<{
    slack_user_id: string;
    slack_user_name: string | null;
    linked_at: string;
    team_name: string;
  }>(sql`
    select i.slack_user_id, i.slack_user_name, i.linked_at, w.team_name from app.slack_identity i
    join app.slack_workspace w on w.org_id = i.org_id and w.team_id = i.team_id
    where i.org_id = ${orgId} and i.user_id = ${userId}`);
  return r
    ? {
        slackUserId: r.slack_user_id,
        slackUserName: r.slack_user_name,
        userId,
        linkedAt: new Date(r.linked_at).toISOString(),
        teamName: r.team_name,
      }
    : null;
}

/** An admin unlinks someone's Slack account: their next question there asks them to link again. */
export async function unlinkSlackIdentity(tx: TenantTx, orgId: string, slackUserId: string): Promise<boolean> {
  const gone = await tx.execute(sql`
    delete from app.slack_identity where org_id = ${orgId} and slack_user_id = ${slackUserId} returning slack_user_id`);
  return gone.length > 0;
}

/** A person unlinks their own Slack account (Settings → Security, App Home). */
export async function unlinkMySlack(tx: TenantTx, orgId: string, userId: string): Promise<boolean> {
  const gone = await tx.execute(sql`
    delete from app.slack_identity where org_id = ${orgId} and user_id = ${userId} returning slack_user_id`);
  return gone.length > 0;
}

export type SlackAsker =
  | { kind: "unconnected" }
  | { kind: "unlinked"; orgId: string }
  | { kind: "member"; orgId: string; userId: string; role: string };

/**
 * Who is asking, from a Slack event, before any tenant is known: the connected workspace, and the member the person
 * linked. A link only exists while its member does (its foreign key to the membership), and the role is read live.
 */
export async function slackAsker(
  deps: PublicDeps & Pick<LedgerDeps, "withTenant">,
  teamId: string,
  slackUserId: string,
): Promise<SlackAsker> {
  const [row] = await deps.withPublic((tx) =>
    tx.execute<{ org_id: string; user_id: string | null; role: string | null }>(sql`
      select * from app.slack_asker(${teamId}, ${slackUserId})`),
  );
  if (!row) return { kind: "unconnected" };
  if (row.user_id && row.role) return { kind: "member", orgId: row.org_id, userId: row.user_id, role: row.role };
  return { kind: "unlinked", orgId: row.org_id };
}

/**
 * The bot token for a connected team, decrypted. Null when the team isn't connected, or Slack took the app back: then
 * nothing is posted for it.
 */
export async function slackBotToken(
  deps: PublicDeps & Pick<LedgerDeps, "withTenant"> & { secrets: SecretStore },
  teamId: string,
): Promise<{ orgId: string; botUserId: string; token: string } | null> {
  const [team] = await deps.withPublic((tx) =>
    tx.execute<{ org_id: string; secret_id: string | null; bot_user_id: string }>(sql`
      select org_id, secret_id, bot_user_id from app.slack_team(${teamId})`),
  );
  if (!team?.secret_id) return null;
  const secretId = team.secret_id;
  const token = await deps.withTenant(team.org_id, (tx) => deps.secrets.reveal(tx, team.org_id, secretId, "oauth"));
  return { orgId: team.org_id, botUserId: team.bot_user_id, token };
}

/** What App Home shows someone: the workspace, whether they're linked, their recent conversations. */
export interface SlackHome {
  /** The OpenDash workspace the Slack workspace is connected to. */
  organization: string;
  /** Linked: they ask as themselves. A viewer can't ask (told at link time); they're shown as linked all the same. */
  linked: boolean;
  /** Their last five conversations asked from Slack, most recent first. */
  conversations: { threadId: string; title: string; at: string }[];
}

/**
 * App Home's content for a Slack user, null when the team isn't connected. It reads nothing of the person's OpenDash
 * account but whether it's linked (app code never reads auth), and only their own conversations.
 */
export async function slackHomeOf(
  deps: PublicDeps & Pick<LedgerDeps, "withTenant">,
  teamId: string,
  slackUserId: string,
): Promise<SlackHome | null> {
  const [team] = await deps.withPublic((tx) =>
    tx.execute<{ org_id: string; secret_id: string | null }>(
      sql`select org_id, secret_id from app.slack_team(${teamId})`,
    ),
  );
  if (!team?.secret_id) return null;
  const asker = await slackAsker(deps, teamId, slackUserId);
  return deps.withTenant(team.org_id, async (tx) => {
    const [org] = await tx.execute<{ name: string }>(sql`select name from app.org where id = ${team.org_id}`);
    const conversations =
      asker.kind === "member"
        ? await tx.execute<{ id: string; title: string; at: string }>(sql`
            select t.id, t.title, coalesce(t.last_message_at, t.created_at) as at
            from app.slack_conversation c
            join app.thread t on t.org_id = c.org_id and t.id = c.thread_id
            where c.org_id = ${team.org_id} and c.team_id = ${teamId} and c.slack_user_id = ${slackUserId}
              and t.deleted_at is null and t.created_by = ${asker.userId}
            order by coalesce(t.last_message_at, t.created_at) desc limit 5`)
        : [];
    return {
      organization: org?.name ?? "",
      linked: asker.kind === "member",
      conversations: conversations.map((c) => ({
        threadId: c.id,
        title: c.title,
        at: new Date(c.at).toISOString(),
      })),
    };
  });
}

/** How long a link to confirm a Slack account works. */
export const SLACK_LINK_MINUTES = 10;

/**
 * Up to three questions to start with in Slack (its suggested prompts, when someone opens OpenDash there): the ones
 * the empty Ask page suggests, from what OpenDash learned of the asker's data. Null when they aren't a member here yet,
 * or have several sources (their first question asks which): Slack then shows the app's own.
 */
export async function slackSuggestions(
  deps: PublicDeps & Pick<LedgerDeps, "withTenant">,
  teamId: string,
  slackUserId: string,
): Promise<string[] | null> {
  const asker = await slackAsker(deps, teamId, slackUserId);
  if (asker.kind !== "member") return null;
  return deps.withTenant(asker.orgId, async (tx) => {
    const sources = await askableSources(tx, asker.orgId);
    const [only] = sources;
    if (sources.length !== 1 || !only) return null;
    const questions = await suggestedQuestions(tx, asker.orgId, only.id);
    return questions.length ? questions : null;
  });
}

/**
 * A link for a Slack user to confirm their account (sent to them privately): its token, shown only in the link. Their
 * Slack account's email is kept with it: confirming needs it to be the signed-in person's own.
 */
export async function startSlackLink(
  tx: TenantTx,
  orgId: string,
  teamId: string,
  slackUserId: string,
  slackUser: { name?: string | null; email?: string | null } = {},
): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  const email = slackUser.email?.trim().toLowerCase() || null;
  await tx.execute(sql`
    insert into app.slack_link
      (org_id, id, team_id, slack_user_id, slack_user_name, slack_user_email, token_hash, expires_at)
    values (${orgId}, ${uuidv7()}, ${teamId}, ${slackUserId}, ${slackUser.name?.slice(0, 120) ?? null}, ${email},
      ${hash(token)}, now() + make_interval(mins => ${SLACK_LINK_MINUTES}))`);
  return token;
}

/** An email with most of its name hidden: p•••@acme.com. */
export const maskEmail = (email: string) => {
  const [name = "", domain = ""] = email.split("@");
  return `${name.slice(0, 1)}•••@${domain}`;
};

/** Whether a link's Slack email is the person's own: both known, the same address. */
const sameEmail = (slack: string | null, mine: string) => Boolean(slack) && slack === mine.trim().toLowerCase();

/** Who opens a link: the signed-in person, in their active workspace, with their role there. */
export interface SlackLinkViewer {
  orgId: string;
  userId: string;
  email: string;
  role: string;
}

export type SlackLinkCheck =
  | { kind: "ok"; orgId: string; teamName: string; slackUserName: string | null }
  /** Used, expired, or never a link. */
  | { kind: "invalid" }
  /** The Slack account's email isn't the person's own (or Slack didn't share it): it's partly shown, when known. */
  | { kind: "not_yours"; shown: string | null }
  /** Theirs, but for another of their OpenDash workspaces than the one they're in. */
  | { kind: "other_workspace" }
  /** Theirs, but they're a viewer there: asking needs member access. */
  | { kind: "viewer" };

type LinkRow = {
  org_id: string;
  id: string;
  team_id: string;
  slack_user_id: string;
  slack_user_name: string | null;
  slack_user_email: string | null;
  team_name: string;
};

/**
 * The checks a link passes, in an order that tells a stranger nothing: first that its Slack account's
 * email is the signed-in person's own, so a forwarded link only ever says "not yours"; then that it names the workspace
 * they're in; then that they may ask there.
 */
function checkLink(link: LinkRow | undefined, viewer: SlackLinkViewer): SlackLinkCheck {
  if (!link) return { kind: "invalid" };
  if (!sameEmail(link.slack_user_email, viewer.email)) {
    return { kind: "not_yours", shown: link.slack_user_email ? maskEmail(link.slack_user_email) : null };
  }
  if (link.org_id !== viewer.orgId) return { kind: "other_workspace" };
  if (viewer.role === "viewer") return { kind: "viewer" };
  return { kind: "ok", orgId: link.org_id, teamName: link.team_name, slackUserName: link.slack_user_name };
}

const readLink = async (deps: PublicDeps, token: string): Promise<LinkRow | undefined> => {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return undefined;
  const [link] = await deps.withPublic((tx) =>
    tx.execute<LinkRow>(sql`select * from app.resolve_slack_link(${hash(token)})`),
  );
  return link;
};

/** What the link page shows before anyone confirms: the checks, and on passing, which Slack account in which team. */
export async function slackLinkPreview(
  deps: PublicDeps,
  token: string,
  viewer: SlackLinkViewer,
): Promise<SlackLinkCheck> {
  return checkLink(await readLink(deps, token), viewer);
}

export type SlackLinkResult = { kind: "linked"; teamName: string } | Exclude<SlackLinkCheck, { kind: "ok" }>;

/**
 * Confirms a link, signed in (a link can be forwarded): the checks again, then the link is
 * used once and the Slack account linked to them, replacing whoever it was linked to before, and any other Slack
 * account they had linked here (one per person).
 */
export async function confirmSlackLink(
  deps: PublicDeps & Pick<LedgerDeps, "withTenant">,
  viewer: SlackLinkViewer,
  token: string,
): Promise<SlackLinkResult> {
  const link = await readLink(deps, token);
  const checked = checkLink(link, viewer);
  if (checked.kind !== "ok" || !link) return checked.kind === "ok" ? { kind: "invalid" } : checked;
  return deps.withTenant(viewer.orgId, async (tx) => {
    const used = await tx.execute(sql`
      update app.slack_link set used_at = now()
      where org_id = ${viewer.orgId} and id = ${link.id} and used_at is null and expires_at > now()
      returning id`);
    if (!used.length) return { kind: "invalid" as const };
    await tx.execute(sql`
      delete from app.slack_identity
      where org_id = ${viewer.orgId} and user_id = ${viewer.userId}
        and (team_id, slack_user_id) is distinct from (${link.team_id}, ${link.slack_user_id})`);
    await tx.execute(sql`
      insert into app.slack_identity (org_id, team_id, slack_user_id, user_id, slack_user_name)
      values (${viewer.orgId}, ${link.team_id}, ${link.slack_user_id}, ${viewer.userId}, ${link.slack_user_name})
      on conflict (org_id, team_id, slack_user_id) do update set user_id = excluded.user_id,
        slack_user_name = excluded.slack_user_name, linked_at = now()`);
    return { kind: "linked" as const, teamName: link.team_name };
  });
}

/**
 * Used and expired links go (maint, hourly): a link is only ever useful for its 10 minutes, and it keeps a Slack email.
 * An expired one stays a day, so its page can still say it expired.
 */
export async function purgeSlackLinks(
  withSystem: <T>(fn: (tx: SystemTx) => Promise<T>) => Promise<T>,
): Promise<number> {
  return withSystem(async (tx) => {
    const gone = await tx.execute(sql`
      delete from app.slack_link where used_at is not null or expires_at < now() - interval '1 day' returning id`);
    return gone.length;
  });
}

export interface SlackQuestion {
  orgId: string;
  userId: string;
  role: string;
  teamId: string;
  /** Chat SDK's thread id, and the person: together, which OpenDash conversation this continues. */
  slackThreadId: string;
  slackUserId: string;
  /** Slack's id for the message: a redelivered event asks once. */
  slackMessageId: string;
  text: string;
  /** Files OpenDash's reader read. */
  files: { name: string; text: string }[];
  /** The source chosen, when the person picked one. */
  connectionId?: string;
  /** The question's record, marked asked in the transaction that asks it. */
  inboundKey?: string;
}

/** Two first questions at once in a new Slack thread: the second finds the conversation the first made. */
class ConversationTaken extends Error {}

export type SlackAskResult =
  | { kind: "asked"; runId: string; threadId: string }
  /** Sent while the last answer here was being worked on: it reads it next, and answers both. */
  | { kind: "queued"; runId: string; threadId: string }
  | { kind: "choose_source"; sources: { id: string; name: string }[] }
  | { kind: "refused"; message: string };

/**
 * Asks a question from Slack as the member who asked it: the same submit, run, answer gate and spend limits as the
 * web's (channel `slack`). The question, which Slack thread it came from and the reply job are written together.
 */
export async function askFromSlack(
  deps: LedgerDeps & { boss: PgBoss; deploymentKeys: DeploymentKeys },
  q: SlackQuestion,
): Promise<SlackAskResult> {
  try {
    return await askOnce(deps, q);
  } catch (error) {
    // It lost the race to start the Slack thread's conversation, and nothing of it was kept: asked again, it's the
    // first one's follow-up.
    if (error instanceof ConversationTaken) return askOnce(deps, q);
    throw error;
  }
}

async function askOnce(
  deps: LedgerDeps & { boss: PgBoss; deploymentKeys: DeploymentKeys },
  q: SlackQuestion,
): Promise<SlackAskResult> {
  if (q.role === "viewer") {
    return { kind: "refused", message: "Viewers read shared conversations. Ask an admin for the Member role to ask." };
  }
  const text = q.text.trim();
  if (!text) return { kind: "refused", message: "Ask a question about your data." };
  try {
    const plan = await deps.withTenant(q.orgId, async (tx) => {
      const [continued] = await tx.execute<{ thread_id: string }>(sql`
        select thread_id from app.slack_conversation
        where org_id = ${q.orgId} and team_id = ${q.teamId} and slack_thread_id = ${q.slackThreadId}
          and slack_user_id = ${q.slackUserId}`);
      const model = await choiceForQuestion(tx, q.orgId, deps.deploymentKeys, undefined);
      if (continued) return { kind: "follow_up" as const, threadId: continued.thread_id, model };
      const sources = await askableSources(tx, q.orgId);
      const chosen = q.connectionId && isUuid(q.connectionId) ? sources.find((s) => s.id === q.connectionId) : null;
      if (q.connectionId && !chosen) return { kind: "refused" as const, message: "That source isn't ready to ask." };
      if (chosen) return { kind: "new" as const, connectionId: chosen.id, model };
      if (!sources.length) {
        return { kind: "refused" as const, message: "No data source is ready to ask yet. Connect one in OpenDash." };
      }
      if (sources.length === 1) return { kind: "new" as const, connectionId: (sources[0] as { id: string }).id, model };
      return { kind: "choose" as const, sources: sources.map((s) => ({ id: s.id, name: s.name })) };
    });
    if (plan.kind === "refused") return plan;
    if (plan.kind === "choose") return { kind: "choose_source", sources: plan.sources };
    const submitted = await submitQuestion(
      { withTenant: deps.withTenant, boss: deps.boss },
      {
        orgId: q.orgId,
        userId: q.userId,
        connectionId: plan.kind === "new" ? plan.connectionId : "",
        ...(plan.kind === "follow_up" ? { threadId: plan.threadId } : {}),
        clientMsgId: q.slackMessageId,
        text,
        channel: "slack",
        model: plan.model.model,
        provider: plan.model.provider,
        reasoning: plan.model.reasoning,
        attachments: q.files.map((f) => ({ kind: "file" as const, id: uuidv7(), name: f.name, text: f.text })),
        canTryDrafts: q.role === "owner" || q.role === "admin",
        afterSubmit: async (tx, s) => {
          const made = await tx.execute<{ thread_id: string }>(sql`
            insert into app.slack_conversation (org_id, team_id, slack_thread_id, slack_user_id, thread_id)
            values (${q.orgId}, ${q.teamId}, ${q.slackThreadId}, ${q.slackUserId}, ${s.threadId})
            on conflict do nothing returning thread_id`);
          if (!made.length && plan.kind === "new") throw new ConversationTaken();
          if (q.inboundKey) await slackInboundAsked(tx, q.orgId, q.teamId, q.inboundKey, s.runId);
          await tx.execute(sql`
            insert into app.slack_reply (org_id, run_id, team_id, slack_thread_id, slack_user_id, slack_message_ts)
            values (${q.orgId}, ${s.runId}, ${q.teamId}, ${q.slackThreadId}, ${q.slackUserId},
              ${SLACK_TS.test(q.slackMessageId) ? q.slackMessageId : null})
            on conflict do nothing`);
          await enqueue<SlackReplyJob>(
            deps.boss,
            tx,
            slackReplyQueue,
            { orgId: q.orgId, runId: s.runId },
            { singletonKey: s.runId },
          );
        },
      },
    );
    return { kind: submitted.queued ? "queued" : "asked", runId: submitted.runId, threadId: submitted.threadId };
  } catch (error) {
    if (error instanceof RunActive) {
      return { kind: "refused", message: "I'm still answering your last question here. Ask again once it's done." };
    }
    if (
      error instanceof SpendLimitReached ||
      error instanceof AiProblem ||
      error instanceof AttachmentProblem ||
      error instanceof NotFound ||
      error instanceof NotYours
    ) {
      return { kind: "refused", message: error.message };
    }
    throw error;
  }
}

/** A Slack message's id, its ts (a button press's stand-in id isn't one). */
const SLACK_TS = /^\d{6,12}\.\d{1,9}$/;

export interface SlackReplyTarget {
  teamId: string;
  slackThreadId: string;
  slackUserId: string;
  /** The asker's message, when there is one: it carries the 👀 while the reply works and the ✅ after. */
  slackMessageTs: string | null;
  status: "streaming" | "done" | "failed";
  /** Who asked (the conversation's author): the reply reads the run as them. */
  userId: string | null;
  /** Someone else has a conversation in the same Slack thread: the reply names its asker, so the thread reads. */
  shared: boolean;
  /**
   * Their Slack account is still linked to them as a member: the link goes with the
   * membership, so nothing more is posted to someone who left while their question ran.
   */
  linked: boolean;
}

/** Where a run's reply goes, and whether it went already. */
export async function slackReplyOf(tx: TenantTx, orgId: string, runId: string): Promise<SlackReplyTarget | null> {
  const [r] = await tx.execute<{
    team_id: string;
    slack_thread_id: string;
    slack_user_id: string;
    slack_message_ts: string | null;
    status: SlackReplyTarget["status"];
    created_by: string | null;
    shared: boolean;
    linked: boolean;
  }>(sql`
    select p.team_id, p.slack_thread_id, p.slack_user_id, p.slack_message_ts, p.status, t.created_by,
      exists (
        select 1 from app.slack_conversation o
        where o.org_id = p.org_id and o.team_id = p.team_id and o.slack_thread_id = p.slack_thread_id
          and o.slack_user_id <> p.slack_user_id
      ) as shared,
      exists (
        select 1 from app.slack_identity i
        where i.org_id = p.org_id and i.team_id = p.team_id and i.slack_user_id = p.slack_user_id
          and i.user_id = t.created_by
      ) as linked
    from app.slack_reply p
    join app.run r on r.org_id = p.org_id and r.id = p.run_id
    join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
    where p.org_id = ${orgId} and p.run_id = ${runId}`);
  return r
    ? {
        teamId: r.team_id,
        slackThreadId: r.slack_thread_id,
        slackUserId: r.slack_user_id,
        slackMessageTs: r.slack_message_ts,
        status: r.status,
        userId: r.created_by,
        shared: r.shared,
        linked: r.linked,
      }
    : null;
}

/** A question form in Slack, as a Send press finds it. */
export interface SlackAsk {
  questions: ClarifyQuestion[];
  /** Who asked, in Slack: only they answer it. */
  slackUserId: string;
  /** Still the conversation's latest ask: an answer since (typed in Slack, or given in the web) makes it an old one. */
  latest: boolean;
}

/** The questions a run asked in Slack, who asked them, and whether they're still the latest ask; null for any other run. */
export async function slackAskOf(tx: TenantTx, orgId: string, runId: string): Promise<SlackAsk | null> {
  if (!isUuid(runId)) return null;
  const [r] = await tx.execute<{ outcome: RunOutcome | null; slack_user_id: string; latest: boolean }>(sql`
    select r.outcome, p.slack_user_id,
      r.id = (
        select l.id from app.run l
        where l.org_id = r.org_id and l.thread_id = r.thread_id and l.parent_run_id is null
        order by l.queued_at desc, l.id desc limit 1
      ) as latest
    from app.run r
    join app.slack_reply p on p.org_id = r.org_id and p.run_id = r.id
    where r.org_id = ${orgId} and r.id = ${runId}`);
  if (r?.outcome?.kind !== "clarify") return null;
  return { questions: clarifyQuestions(r.outcome), slackUserId: r.slack_user_id, latest: r.latest };
}

/** An answer in Slack, as a press under it finds it: who asked it, its follow-ups, whether it's the latest. */
export interface SlackAnswer {
  /** Who asked, in Slack: only they rate it or take a follow-up from it. */
  slackUserId: string;
  /** The follow-ups it offered, in order (each button carries only its place). */
  next: string[];
  /** Still the conversation's latest: a follow-up taken since (from any answer) makes it an old one. */
  latest: boolean;
}

/** A run's answer as asked from Slack, for a press under it; null for any other run, or one that isn't an answer. */
export async function slackAnswerOf(tx: TenantTx, orgId: string, runId: string): Promise<SlackAnswer | null> {
  if (!isUuid(runId)) return null;
  const [r] = await tx.execute<{ outcome: RunOutcome | null; slack_user_id: string; latest: boolean }>(sql`
    select r.outcome, p.slack_user_id,
      r.id = (
        select l.id from app.run l
        where l.org_id = r.org_id and l.thread_id = r.thread_id and l.parent_run_id is null
        order by l.queued_at desc, l.id desc limit 1
      ) as latest
    from app.run r
    join app.slack_reply p on p.org_id = r.org_id and p.run_id = r.id
    where r.org_id = ${orgId} and r.id = ${runId}`);
  if (r?.outcome?.kind !== "answer") return null;
  const next = (r.outcome.next ?? []).filter((q): q is string => typeof q === "string" && q.trim() !== "");
  return { slackUserId: r.slack_user_id, next, latest: r.latest };
}

export async function finishSlackReply(
  tx: TenantTx,
  orgId: string,
  runId: string,
  status: "done" | "failed",
): Promise<void> {
  await tx.execute(sql`
    update app.slack_reply set status = ${status}, finished_at = now()
    where org_id = ${orgId} and run_id = ${runId} and status = 'streaming'`);
}

/**
 * Slack's stop button, which says the thread and person but not the team: stops their run there, if one is going,
 * as long as they're still the member who asked.
 */
export async function stopSlackRunFor(
  deps: PublicDeps & Pick<LedgerDeps, "withTenant"> & { boss?: PgBoss | null },
  slackThreadId: string,
  slackUserId: string,
): Promise<boolean> {
  const [conversation] = await deps.withPublic((tx) =>
    tx.execute<{ org_id: string; team_id: string }>(sql`
      select * from app.slack_conversation_of(${slackThreadId}, ${slackUserId})`),
  );
  if (!conversation) return false;
  const asker = await slackAsker(deps, conversation.team_id, slackUserId);
  if (asker.kind !== "member") return false;
  return stopSlackRun(deps, asker, conversation.team_id, slackThreadId, slackUserId);
}

/**
 * Slack's stop button: stops the person's run in that Slack thread, if one is going. With the queue, a run stopped
 * before it started passes on what was added meanwhile.
 */
export async function stopSlackRun(
  deps: LedgerDeps & { boss?: PgBoss | null },
  asker: { orgId: string; userId: string },
  teamId: string,
  slackThreadId: string,
  slackUserId: string,
): Promise<boolean> {
  const [run] = await deps.withTenant(asker.orgId, (tx) =>
    tx.execute<{ id: string }>(sql`
      select r.id from app.slack_conversation c
      join app.run r on r.org_id = c.org_id and r.thread_id = c.thread_id
      where c.org_id = ${asker.orgId} and c.team_id = ${teamId} and c.slack_thread_id = ${slackThreadId}
        and c.slack_user_id = ${slackUserId} and r.status in ('queued', 'running')
      order by r.id desc limit 1`),
  );
  return run ? requestStop(deps, asker, run.id) : false;
}
