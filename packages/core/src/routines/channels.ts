/**
 * A routine's Slack channels, checked with Slack before it's saved: each one there, not archived,
 * and with OpenDash's bot in it, named as Slack names it. It calls Slack, so it runs before the save's transaction;
 * the store checks the rest (the workspace connected, the team, what the channel may read).
 */
import type { TenantTx } from "@opendash/db";
import type { SecretStore } from "../secrets/store";
import { SlackApiError, type SlackFetch, slackChannelInfo, slackWorkspaceToken } from "../slack/api";
import type { SlackDestination } from "./spec";
import { MAX_CHANNELS, RoutineProblem } from "./store";

const why = (error: unknown) =>
  error instanceof SlackApiError && ["token_revoked", "invalid_auth", "account_inactive"].includes(error.code)
    ? "Slack took the app back. Connect it again in Settings → Slack."
    : "Slack couldn't be reached to check the channels. Try again in a moment.";

/** The channels, as Slack has them now; a problem with one says which and what to do. */
export async function checkRoutineChannels(
  deps: {
    withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
    secrets: SecretStore;
  },
  actor: { orgId: string; canManage: boolean },
  input: unknown,
  fetchImpl?: SlackFetch,
): Promise<SlackDestination[]> {
  if (!Array.isArray(input) || !input.length) return [];
  // Only those who may post to a channel get Slack asked about one: nothing about a channel reaches anyone else.
  if (!actor.canManage) {
    throw new RoutineProblem("forbidden", "Only owners and admins can make routines that reach other people.");
  }
  const orgId = actor.orgId;
  const ids = [
    ...new Set(
      input.map((c) => {
        const id = (c as { channelId?: unknown } | null)?.channelId;
        if (typeof id !== "string" || !/^[A-Z0-9]{6,20}$/.test(id)) {
          throw new RoutineProblem("invalid", "Pick a Slack channel from the list.");
        }
        return id;
      }),
    ),
  ];
  if (ids.length > MAX_CHANNELS)
    throw new RoutineProblem("invalid", `A routine posts to ${MAX_CHANNELS} channels at most.`);
  const w = await slackWorkspaceToken(deps, orgId).catch(() => null);
  if (!w) throw new RoutineProblem("invalid", "Connect Slack first, in Settings → Slack.");
  const out: SlackDestination[] = [];
  for (const id of ids) {
    const c = await slackChannelInfo(w.token, id, fetchImpl).catch((error: unknown) => {
      throw new RoutineProblem("invalid", why(error));
    });
    if (!c) throw new RoutineProblem("invalid", "A channel you picked isn't in Slack any more.");
    if (c.archived) throw new RoutineProblem("invalid", `#${c.name} is archived. Pick another channel.`);
    // Written for the workspace (its own people read what a routine posts), never for people outside its company.
    if (c.external) {
      throw new RoutineProblem(
        "invalid",
        `#${c.name} is shared with another company. A routine posts only to your workspace's own channels.`,
      );
    }
    if (!c.member) {
      throw new RoutineProblem(
        "invalid",
        `OpenDash isn't in #${c.name}. Invite it there first: /invite @opendash in the channel.`,
      );
    }
    out.push({ teamId: w.teamId, channelId: c.id, name: c.name.slice(0, 80), ...(c.private ? { private: true } : {}) });
  }
  return out;
}
