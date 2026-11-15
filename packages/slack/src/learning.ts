/**
 * A learning in Slack: when one is decided, whoever gave its correction in a Slack thread hears it there,
 * privately. An owner or admin gets "Make this a team learning?" with one tap (or "OpenDash learned for the team ·
 * Revert" when the rule released it); anyone else "Suggested to your admins". The presses are handled in bot.ts, each
 * an owner's or admin's act checked again there.
 */
import type { SlackAdapter } from "@chat-adapter/slack";
import {
  type LearningCard,
  learningCard,
  learningPlaces,
  REVERT_SUPERSEDED,
  type SecretStore,
  slackBotToken,
} from "@opendash/core";
import type { PublicTx, TenantTx } from "@opendash/db";

export const LEARNING_APPROVE = "opendash:learning:approve";
export const LEARNING_REJECT = "opendash:learning:reject";
export const LEARNING_REVERT = "opendash:learning:revert";
export const LEARNING_SUGGEST = "opendash:learning:suggest";

/** What a Revert press is told, by how it went (`revertLearning`). */
export const REVERTED = {
  reverted: "Reverted: the team no longer uses it.",
  superseded: REVERT_SUPERSEDED,
  not_found: "It's not the team's to revert.",
} as const;

const text = (t: string) => ({ type: "plain_text", text: t.slice(0, 2_000), emoji: false });

/** What a learning says, in a line: the word, where it lives, and what it is not. */
export function learningLine(l: Pick<LearningCard, "term" | "means" | "column" | "values" | "not">): string {
  const where = l.column ? l.column.split(".").slice(-2) : null;
  const is = where
    ? `${where[0]}${l.values.length ? ` where ${where[1]} = ${l.values.join(", ")}` : ""}`
    : (l.means ?? "");
  const not = l.not.length ? `; not ${l.not.map((t) => t.split(".").at(-1)).join(", ")}` : "";
  return `${l.term ?? "This"} means ${is}${not}`;
}

/** The private message about a learning, for one person: an approver's has its buttons. */
export function learningBlocks(
  l: LearningCard,
  approver: boolean,
): { text: string; blocks: Record<string, unknown>[] } {
  const value = JSON.stringify({ p: l.id });
  if (l.status === "approved") {
    const said = `${l.automatic ? "OpenDash learned for the team" : "A team learning now"}: ${learningLine(l)}.`;
    return {
      text: said,
      blocks: [
        {
          type: "section",
          text: text(said),
          ...(approver
            ? { accessory: { type: "button", action_id: LEARNING_REVERT, text: text("Revert"), value } }
            : {}),
        },
      ],
    };
  }
  if (!approver) {
    const said = `Suggested to your admins: ${learningLine(l)}.`;
    return { text: said, blocks: [{ type: "section", text: text(said) }] };
  }
  const checked = [
    `Said ${l.said.length === 1 ? "once" : `${l.said.length} times`}${l.people > 1 ? ` by ${l.people} people` : ""}`,
    l.check ? (l.check.ok ? "check passed" : "check didn't pass") : null,
    l.test ? (l.test.ok && l.test.used ? "test passed" : "test didn't pass") : null,
    "change it on Knowledge → Proposals",
  ]
    .filter(Boolean)
    .join(" · ");
  // The other words it brings: the analyst reads each as the term, so the approver sees them before the tap.
  const also = l.synonyms.length ? ` Also called: ${l.synonyms.join(", ")}.` : "";
  return {
    text: `Make this a team learning? ${learningLine(l)}.${also}`,
    blocks: [
      { type: "section", text: text(`Make this a team learning? ${learningLine(l)}.${also}`) },
      { type: "context", elements: [text(checked)] },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: LEARNING_APPROVE,
            text: text("Make it a team learning"),
            style: "primary",
            value,
          },
          { type: "button", action_id: LEARNING_REJECT, text: text("Not this"), value },
        ],
      },
    ],
  };
}

export interface TellLearningDeps {
  withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  withPublic: <T>(fn: (tx: PublicTx) => Promise<T>) => Promise<T>;
  secrets: SecretStore;
}

/**
 * Tells a decided learning (open, or approved) privately in each Slack thread one of its corrections came from, once a
 * status. Returns how many were told; Slack refusing one is the caller's to log.
 */
export async function tellLearning(
  deps: TellLearningDeps,
  slack: Pick<SlackAdapter, "withBotToken" | "webClient" | "decodeThreadId">,
  orgId: string,
  proposalId: string,
): Promise<number> {
  const [where, card] = await deps.withTenant(
    orgId,
    async (tx) => [await learningPlaces(tx, orgId, proposalId), await learningCard(tx, orgId, proposalId)] as const,
  );
  if (!card || !where.places.length) return 0;
  let told = 0;
  for (const place of where.places) {
    const bot = await slackBotToken(deps, place.teamId);
    if (!bot) continue;
    const { channel, threadTs } = slack.decodeThreadId(place.slackThreadId);
    const message = learningBlocks(card, place.approver);
    await slack.withBotToken(
      bot.token,
      () =>
        slack.webClient.chat.postEphemeral({
          channel,
          user: place.slackUserId,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          text: message.text,
          blocks: message.blocks as never,
        }),
      { installationId: place.teamId },
    );
    told += 1;
  }
  return told;
}
