/**
 * Sending an outbox row (the `effect.send` job): claim it, check its routine still sends there (a
 * person still on it, still a member, address verified; a channel still on it, its Slack still connected), compose
 * what it says now (for that person, or as the whole workspace reads it in a channel), and send it once: an email with
 * the row's idempotency key, a Slack post marked with the row's id, looked for before an attempt after the first posts
 * again. Nothing to say, an address that can't receive, or no sender configured is `suppressed`, with why; Slack
 * refusing for good is `failed`, and a post nobody can tell went is `unknown`, never retried. The message itself is
 * never stored. Each settled row settles its run.
 */
import { isUuid, sql, type TenantTx } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { BUDGETS } from "../budgets";
import { type InsightView, listInsights } from "../checks/insights";
import { investigationsFor } from "../checks/investigate";
import { displayMetric } from "../figures/metric";
import type { GatewayDeps } from "../gateway/gateway";
import { threadReadableBy } from "../projects/access";
import { composeDigest, type DigestContent } from "../routines/actions/digest";
import { type SendPayload, settleRun } from "../routines/deliver";
import { sentenceText } from "../routines/sentence";
import { type FoundSpec, type RoutineSpec, SENSITIVITY } from "../routines/spec";
import { channelSentence, listRoutines, memberLeft } from "../routines/store";
import type { RunOutcome } from "../runs/ledger";
import { SLACK_FOR_GOOD, SlackApiError, type SlackPostInput, type SlackPostResult } from "../slack/api";
import type { UnsubscribeTarget } from "./unsubscribe";

/** A finding as an email tells it. */
export interface FindingItem {
  id: string;
  title: string;
  detail: string;
  verdict?: string;
}

/** What a routine's email says, composed here for its recipient (the shape @opendash/email's routineEmail takes). */
export type RoutineMessage = {
  /** Why it came: the routine's sentence, its page, and the one-click unsubscribe page. */
  because: string;
  routineUrl: string;
  unsubscribeUrl?: string;
} & (
  | {
      kind: "answer";
      answer: {
        organization: string;
        baseUrl: string;
        /** The conversation the answer is in, and the run that answered. */
        threadId: string;
        runId: string;
        question: string;
        sourceName: string;
        answeredAt: string;
        answer: string;
        verified: boolean;
      };
    }
  | { kind: "digest"; digest: DigestContent & { organization: string; baseUrl: string } }
  | { kind: "findings"; findings: { organization: string; baseUrl: string; roundup: boolean; findings: FindingItem[] } }
  | { kind: "paused"; paused: { organization: string; baseUrl: string; reason: string } }
);

const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const plain = (markdown: string) => markdown.replace(/\*\*|__|`/g, "").trim();

/** The answer as text: the gate's rendering, without markdown's marks, kept to an email's length. */
function answerText(answer: Extract<RunOutcome, { kind: "answer" }>): string {
  const text = plain(answer.rendered);
  return text.length > 1200 ? `${text.slice(0, 1199)}…` : text;
}

/** A finding's figure as the routine tells it: an unusual value against the band at the routine's own sensitivity. */
export function findingDetail(i: InsightView, spec: FoundSpec | null): string {
  if (i.claims) {
    const e = i.claims.expected;
    const k = spec?.condition.kind === "unusual" ? SENSITIVITY[spec.condition.sensitivity] : e.k;
    // Floored at zero where the band it was filed with was (a metric that's always been positive).
    const floored = e.lo > e.value - e.k * e.spread + 1e-9;
    const lo = floored ? Math.max(0, e.value - k * e.spread) : e.value - k * e.spread;
    // As precisely as its value is (86–93 for a count), like the band the insight shows.
    const decimals = Math.min(2, (String(i.claims.value.value).split(".")[1] ?? "").length);
    const round = (v: number) => Number(v.toFixed(decimals));
    const f = i.claims.metric.format;
    return `${i.claims.value.display} · usually ${displayMetric(f, round(lo))}–${displayMetric(f, round(e.value + k * e.spread))}`;
  }
  if (i.threshold) return `${i.threshold.value.display} · the line is ${i.threshold.line.display}`;
  if (i.trend) return `${i.trend.recent.display} lately, against ${i.trend.before.display} before`;
  if (i.goalRisk) {
    const month = MONTH.format(new Date(`${i.goalRisk.projected.month}T00:00:00Z`));
    return `${i.goalRisk.projected.display} projected for ${month} · goal ${i.goalRisk.goal.target.display}`;
  }
  return i.summary;
}

const VERDICT: Record<string, string> = {
  confirmed: "Its investigation confirmed it.",
  not_confirmed: "Its investigation didn't confirm it.",
  queued: "Still being investigated.",
  running: "Still being investigated.",
};

/** The email to send (what @opendash/email renders). */
export interface RenderedMessage {
  subject: string;
  html: string;
  text: string;
}

/**
 * A sender (@opendash/email's EmailSender). It rejects with an error whose `outcome` says whether the message may have
 * gone (EmailError's: `rejected`, `not_sent` or `unclear`); an error without one counts as `unclear`.
 */
export interface MessageSender {
  send(
    message: RenderedMessage & { to: string; tags?: Record<string, string>; headers?: Record<string, string> },
    options?: { idempotencyKey?: string; signal?: AbortSignal },
  ): Promise<{ id: string }>;
}

export interface DeliveryOut {
  /** Null where no email is configured: the row is suppressed, saying so. */
  sender: MessageSender | null;
  render: (message: RoutineMessage) => RenderedMessage;
  /** The web app's origin, for every link. */
  baseUrl: string;
  /** False for an address that would only bounce (reserved test domains). */
  canDeliver: (email: string) => boolean;
  /**
   * The unsubscribe links for an email to this target: the page a person opens, and the address a mail client posts
   * to for one-click unsubscribe. Null where links can't be signed.
   */
  unsubscribe?: (t: UnsubscribeTarget) => { page: string; oneClick: string } | null;
  /** Posting to Slack channels: a message rendered as blocks (@opendash/slack), posted once (`slackPoster`). */
  slack?: {
    render: (message: RoutineMessage) => { text: string; blocks: unknown[] };
    post: (input: SlackPostInput) => Promise<SlackPostResult>;
  } | null;
}

export type DeliveryResult = "sent" | "suppressed" | "skipped" | "failed" | "unknown";

/** What a sender's failure says about the message (MessageSender); unsaid, it may have gone. */
function sendOutcome(error: unknown): "rejected" | "not_sent" | "unclear" {
  const outcome = (error as { outcome?: unknown } | null)?.outcome;
  return outcome === "rejected" || outcome === "not_sent" ? outcome : "unclear";
}

type Payload = SendPayload & { routineId?: string; userId?: string; slack?: { teamId?: string; channelId?: string } };

/** Who it's composed for: a person, or a channel (what the whole workspace can open, read with its owner's rights). */
type Reader = { kind: "person"; userId: string } | { kind: "channel"; ownerId: string };

type Compose = (
  out: DeliveryOut,
  footer: { because: string; routineUrl: string; unsubscribeUrl?: string },
) => RoutineMessage;

async function settle(
  tx: TenantTx,
  boss: PgBoss,
  orgId: string,
  id: string,
  status: "sent" | "suppressed" | "failed" | "queued" | "unknown",
  receipt: Record<string, unknown>,
  /** After the send: only while the row is still this attempt's (a later attempt may have taken it over). */
  opts: { providerRef?: string | null; attempt?: number } = {},
) {
  const [e] = await tx.execute<{ source_id: string | null; source_type: string }>(sql`
    update app.effect set status = ${status}, receipt = ${JSON.stringify(receipt)}::jsonb,
      provider_ref = coalesce(${opts.providerRef ?? null}, provider_ref), updated_at = now(),
      sent_at = ${status === "sent" ? sql`now()` : sql`sent_at`}
    where org_id = ${orgId} and id = ${id}
      ${opts.attempt === undefined ? sql`` : sql`and status = 'sending' and attempt = ${opts.attempt}`}
    returning source_id, source_type`);
  // A routine run's status follows its sends.
  if (status !== "queued" && e?.source_type === "routine_run" && e.source_id) {
    await settleRun(tx, boss, orgId, e.source_id);
  }
}

export async function deliverEffect(
  deps: Pick<GatewayDeps, "withTenant"> & { boss: PgBoss },
  job: { orgId: string; effectId: string },
  out: DeliveryOut,
): Promise<DeliveryResult> {
  const { orgId } = job;
  const claimed = await deps.withTenant(orgId, async (tx) => {
    const suppressed = async (reason: string) => {
      await settle(tx, deps.boss, orgId, job.effectId, "suppressed", { reason });
      return "suppressed" as const;
    };
    // A send an earlier attempt stopped in the middle of (its job lost with the worker) is still 'sending'.
    const [e] = await tx.execute<{
      source_type: string;
      channel: string;
      payload: Payload;
      idempotency_key: string;
      attempt: number;
      created_at: string;
      was: string;
    }>(sql`
      with was as (select status from app.effect where org_id = ${orgId} and id = ${job.effectId} for update)
      update app.effect e set status = 'sending', attempt = e.attempt + 1, updated_at = now()
      from was
      where e.org_id = ${orgId} and e.id = ${job.effectId} and was.status in ('queued', 'sending')
      returning e.source_type, e.channel, e.payload, e.idempotency_key, e.attempt, e.created_at, was.status as was`);
    if (!e) return null;
    // An email may have gone (SMTP has no idempotency key), so it isn't sent again: the run says so. A Slack post is
    // taken up again, since it looks for itself before it posts.
    if (e.was === "sending" && e.channel !== "slack") {
      await settle(tx, deps.boss, orgId, job.effectId, "unknown", {
        reason: "An earlier attempt stopped while sending it, so it isn't sent again in case it went.",
      });
      return "unknown" as const;
    }
    const p = e.payload;
    if (e.source_type !== "routine_run" || !p.routineId || !isUuid(p.routineId)) {
      return suppressed("Only routines' sends are sent.");
    }
    if (e.channel === "slack") {
      const c = await claimChannel(tx, orgId, p, p.routineId);
      if (typeof c === "string") return suppressed(c);
      return { ...c, attempt: e.attempt, since: new Date(e.created_at) };
    }
    if (e.channel !== "email" || !p.userId) return suppressed("Only routines' emails and Slack posts are sent.");
    const userId = p.userId;
    const [routine] = await tx.execute<{
      status: string;
      deleted: boolean;
      user_ids: string[];
      owner_id: string;
      paused_reason: string | null;
      spec: RoutineSpec;
    }>(sql`
      select status, deleted_at is not null as deleted, user_ids, owner_id, paused_reason, spec from app.routine
      where org_id = ${orgId} and id = ${p.routineId}`);
    if (!routine || routine.deleted) return suppressed("Its routine was deleted.");
    if (p.kind === "paused") {
      if (routine.status !== "paused") return suppressed("It was resumed before this went.");
    } else {
      if (routine.status !== "active") return suppressed("Its routine was paused.");
      // Still on it when it's sent: taken off (or unsubscribed) since, nothing goes.
      if (!routine.user_ids.includes(userId)) return suppressed("They're not on it any more.");
    }
    const [who] = await tx.execute<{ email: string; name: string; verified: boolean }>(
      sql`select email, name, verified from app.member_recipient(${userId})`,
    );
    if (!who) {
      // Gone from the workspace: they're taken off every routine, so coming back doesn't restart emails.
      await memberLeft(tx, orgId, userId);
      return suppressed("They're no longer a member.");
    }
    // Still a member, but nothing goes to an address that isn't verified; they stay on the routine.
    if (!who.verified) return suppressed("Their address isn't verified.");
    const [o] = await tx.execute<{ name: string }>(sql`select name from app.org where id = ${orgId}`);
    const organization = o?.name ?? "your workspace";
    const viewer = { orgId, userId, canManage: false };
    const [view] = await listRoutines(tx, viewer, { id: p.routineId });
    const because = view ? sentenceText(view.sentence) : "A routine in OpenDash.";
    const reader: Reader = { kind: "person", userId };
    const compose = await composeFor(tx, { orgId, reader, organization, payload: p, routine });
    if (typeof compose === "string") return suppressed(compose);
    return {
      channel: "email" as const,
      attempt: e.attempt,
      email: who.email,
      userId,
      key: e.idempotency_key,
      because,
      routineId: p.routineId,
      compose,
      kind: p.kind,
    };
  });
  if (!claimed) return "skipped";
  if (claimed === "suppressed" || claimed === "unknown") return claimed;
  // Every settle after the claim is this attempt's: a later one may have taken the row over.
  const settleClaimed = <S extends "sent" | "suppressed" | "failed" | "queued" | "unknown">(
    status: S,
    receipt: Record<string, unknown>,
    providerRef?: string | null,
  ) =>
    deps.withTenant(orgId, async (tx) => {
      await settle(tx, deps.boss, orgId, job.effectId, status, receipt, { providerRef, attempt: claimed.attempt });
      return status;
    });
  const suppress = (reason: string) => settleClaimed("suppressed", { reason });
  if (claimed.channel === "slack") {
    if (!out.slack) return suppress("Slack isn't set up on this deployment.");
    const base = out.baseUrl.replace(/\/$/, "");
    const rendered = out.slack.render(
      claimed.compose(out, {
        because: claimed.because,
        routineUrl: `${base}/routines/${encodeURIComponent(claimed.routineId)}`,
      }),
    );
    let posted: SlackPostResult;
    try {
      posted = await out.slack.post({
        orgId,
        teamId: claimed.teamId,
        channelId: claimed.channelId,
        effectId: job.effectId,
        attempt: claimed.attempt,
        since: claimed.since,
        ...rendered,
      });
    } catch (error) {
      if (error instanceof SlackApiError && SLACK_FOR_GOOD.has(error.code)) {
        return settleClaimed("failed", {
          error:
            error.code === "channel_external"
              ? "The channel is shared with another company now, so nothing of a routine's is posted there."
              : `Slack refused it: ${error.code}.`,
        });
      }
      // Back in the queue: the next attempt looks for this post before it posts.
      const message = (error instanceof Error ? error.message : "It couldn't be posted.").slice(0, 200);
      await settleClaimed("queued", { error: message });
      throw error;
    }
    if (posted.status === "unknown") {
      // Posting again could post twice: it settles as it is, and the run says so.
      return settleClaimed("unknown", {
        reason: `Slack couldn't say whether it was posted (${posted.why}), so it isn't posted again.`,
      });
    }
    // Outside the send's try: a failure to record it isn't a failed post (a retry finds the post and records it).
    return settleClaimed("sent", {}, posted.ts || null);
  }
  if (!out.canDeliver(claimed.email)) return suppress("That address can't receive email.");
  if (!out.sender) return suppress("No email sender is configured.");
  const links =
    claimed.kind === "paused"
      ? null
      : (out.unsubscribe?.({ orgId, userId: claimed.userId, routineId: claimed.routineId }) ?? null);
  const base = out.baseUrl.replace(/\/$/, "");
  const message = out.render(
    claimed.compose(out, {
      because: claimed.because,
      routineUrl: `${base}/routines/${encodeURIComponent(claimed.routineId)}`,
      ...(links ? { unsubscribeUrl: links.page } : {}),
    }),
  );
  let sent: { id: string };
  try {
    sent = await out.sender.send(
      {
        ...message,
        to: claimed.email,
        tags: { kind: claimed.kind },
        // RFC 8058: mail clients' own unsubscribe button posts here, and it works without signing in.
        ...(links
          ? {
              headers: {
                "List-Unsubscribe": `<${links.oneClick}>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              },
            }
          : {}),
      },
      { idempotencyKey: `${orgId}:${claimed.key}`, signal: AbortSignal.timeout(BUDGETS.email.sendMs) },
    );
  } catch (error) {
    // At most once: only a send the provider surely didn't take goes back in the queue for the job's retry.
    const message = (error instanceof Error ? error.message : "It couldn't be sent.").slice(0, 200);
    const outcome = sendOutcome(error);
    if (outcome === "rejected") return settleClaimed("failed", { error: message });
    if (outcome === "unclear") {
      return settleClaimed("unknown", {
        error: message,
        reason: "The email provider didn't confirm it, so it isn't sent again in case it went.",
      });
    }
    await settleClaimed("queued", { error: message });
    throw error;
  }
  // Outside the send's try: it went, whatever recording it does (a retry finds it 'sending' and says it may have).
  return settleClaimed("sent", {}, sent.id);
}

/**
 * A post to a channel, checked as it goes: its routine still on and still posting there, its Slack still the one
 * connected. What it says is composed as the channel reads it.
 */
async function claimChannel(
  tx: TenantTx,
  orgId: string,
  p: Payload,
  routineId: string,
): Promise<
  { channel: "slack"; teamId: string; channelId: string; because: string; routineId: string; compose: Compose } | string
> {
  const teamId = p.slack?.teamId;
  const channelId = p.slack?.channelId;
  if (!teamId || !channelId) return "It names no channel.";
  if (p.kind === "paused") return "A routine's pause is told to its owner, by email.";
  const [routine] = await tx.execute<{
    status: string;
    deleted: boolean;
    owner_id: string;
    paused_reason: string | null;
    spec: RoutineSpec;
    slack: { teamId: string; channelId: string }[];
  }>(sql`
    select status, deleted_at is not null as deleted, owner_id, paused_reason, spec, slack from app.routine
    where org_id = ${orgId} and id = ${routineId}`);
  if (!routine || routine.deleted) return "Its routine was deleted.";
  if (routine.status !== "active") return "Its routine was paused.";
  if (!routine.slack.some((c) => c.teamId === teamId && c.channelId === channelId)) {
    return "The routine doesn't post there any more.";
  }
  const [w] = await tx.execute<{ team_id: string; removed: boolean }>(sql`
    select team_id, removed_at is not null as removed from app.slack_workspace where org_id = ${orgId}`);
  if (!w || w.removed || w.team_id !== teamId) return "Slack isn't connected to this workspace any more.";
  const [o] = await tx.execute<{ name: string }>(sql`select name from app.org where id = ${orgId}`);
  const reader: Reader = { kind: "channel", ownerId: routine.owner_id };
  const compose = await composeFor(tx, {
    orgId,
    reader,
    organization: o?.name ?? "your workspace",
    payload: p,
    routine,
  });
  if (typeof compose === "string") return compose;
  const because = (await channelSentence(tx, orgId, routineId, channelId)) ?? "A routine in OpenDash.";
  return { channel: "slack", teamId, channelId, because, routineId, compose };
}

/** What it says for this reader, or why nothing goes. */
async function composeFor(
  tx: TenantTx,
  c: {
    orgId: string;
    reader: Reader;
    organization: string;
    payload: Payload;
    routine: { paused_reason: string | null; spec: RoutineSpec };
  },
): Promise<Compose | string> {
  const { orgId, reader, organization, payload: p } = c;
  // Read with the person's own rights; a channel with its owner's, and only what the whole workspace may open.
  const as = { orgId, userId: reader.kind === "person" ? reader.userId : reader.ownerId };
  const everyone = reader.kind === "channel";
  if (p.kind === "paused") {
    const reason = c.routine.paused_reason ?? "It failed four times in a row.";
    return (out, footer) => ({ ...footer, kind: "paused", paused: { organization, baseUrl: out.baseUrl, reason } });
  }
  if (p.kind === "answer") {
    // Read as the reader would read it: the conversation still theirs to open (a channel, the whole workspace's).
    const [a] = isUuid(p.runId)
      ? await tx.execute<{
          thread_id: string;
          question: string;
          source: string | null;
          finished_at: string | null;
          outcome: RunOutcome | null;
          visibility: string;
        }>(sql`
          select r.thread_id, coalesce(nullif(trim(m.text), ''), t.title, '') as question, c.name as source,
            r.finished_at, r.outcome, t.visibility
          from app.run r
          join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
          left join app.message m on m.org_id = r.org_id and m.id = r.input_message_id
          left join app.connection c on c.org_id = r.org_id and c.id = coalesce(r.connection_id, t.connection_id)
          where r.org_id = ${orgId} and r.id = ${p.runId} and ${threadReadableBy(as.userId)}`)
      : [];
    if (a?.outcome?.kind !== "answer") return "That answer isn't theirs to read any more.";
    if (everyone && a.visibility !== "org") return "That answer isn't shared with the whole workspace.";
    const outcome = a.outcome;
    // The question this answer answers, as it was asked: the routine's may have changed since.
    const question = a.question;
    return (out, footer) => ({
      ...footer,
      kind: "answer",
      answer: {
        organization,
        baseUrl: out.baseUrl,
        threadId: a.thread_id,
        runId: p.runId,
        question,
        sourceName: a.source ?? "its source",
        answeredAt: a.finished_at ? new Date(a.finished_at).toISOString() : new Date().toISOString(),
        answer: answerText(outcome),
        verified: Boolean(outcome.verified),
      },
    });
  }
  if (p.kind === "digest") {
    const digest = await composeDigest(tx, { orgId, userId: everyone ? null : as.userId });
    if (!digest) return "Nothing to say this time.";
    return (out, footer) => ({ ...footer, kind: "digest", digest: { ...digest, organization, baseUrl: out.baseUrl } });
  }
  // A finding told at once, or the day's roundup: only those still open (one dismissed since isn't news).
  // A channel reads the workspace's findings only; a person, theirs too (a private routine's own).
  const insights = (
    await listInsights(tx, { orgId, userId: everyone ? null : as.userId }, { ids: p.insightIds })
  ).filter((i) => i.status === "new" || i.status === "seen");
  if (!insights.length) return "What it found was dismissed or resolved before it went.";
  const verdicts = await investigationsFor(
    tx,
    orgId,
    insights.map((i) => i.id),
  );
  const spec = c.routine.spec.trigger === "found" ? c.routine.spec : null;
  const findings: FindingItem[] = insights.map((i) => {
    const v = verdicts.get(i.id)?.status;
    return {
      id: i.id,
      title: i.title,
      detail: findingDetail(i, spec),
      ...(v && VERDICT[v] ? { verdict: VERDICT[v] } : {}),
    };
  });
  return (out, footer) => ({
    ...footer,
    kind: "findings",
    findings: { organization, baseUrl: out.baseUrl, roundup: p.kind === "roundup", findings },
  });
}

/** The dead letter's part: a row whose sends kept failing is marked failed, and its run settles. */
export async function effectFailed(
  deps: Pick<GatewayDeps, "withTenant"> & { boss: PgBoss },
  job: { orgId: string; effectId: string },
) {
  await deps.withTenant(job.orgId, async (tx) => {
    const [e] = await tx.execute<{ source_id: string | null; source_type: string }>(sql`
      update app.effect set status = 'failed', updated_at = now()
      where org_id = ${job.orgId} and id = ${job.effectId} and status in ('queued', 'sending')
      returning source_id, source_type`);
    if (e?.source_type === "routine_run" && e.source_id) await settleRun(tx, deps.boss, job.orgId, e.source_id);
  });
}
