// Routines in words: what a routine does each time, what each run did, how its checks went.
// Pure, so the composer (a client component) and the routine's page say it the same way, and tests read it.
import type { CheckGrain, RoutineSpec } from "@opendash/core/routines";
import { listWords, ruleWords } from "@opendash/core/routines";

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** "Mon Oct 19, 07:00", where the workspace is. */
export function whenLine(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: tz,
  })
    .format(new Date(iso))
    .replace(",", "");
}

const periodName = (period: string, grain: CheckGrain | null) => {
  const d = new Date(`${period.slice(0, 10)}T00:00:00Z`);
  return grain === "week" ? `the week of ${DAY.format(d)}` : MONTH.format(d);
};

/** A check's last read: when, and what it judged, waits for, or couldn't do. */
export function checkLine(
  c: {
    grain: CheckGrain | null;
    state: { lastRunAt?: string; lastStatus?: string; lastError?: string; lastPeriod?: string };
  },
  tz: string,
): { text: string; problem: boolean } {
  const s = c.state;
  if (!c.grain) return { text: "It has no weeks or months to check any more", problem: true };
  if (!s.lastRunAt) return { text: "First check within a minute", problem: false };
  const at = whenLine(s.lastRunAt, tz);
  if (s.lastStatus === "error") return { text: `${at} · couldn't check: ${s.lastError ?? "it failed"}`, problem: true };
  if (s.lastStatus === "waiting" && s.lastPeriod) {
    return { text: `${at} · waiting for ${periodName(s.lastPeriod, c.grain)}`, problem: false };
  }
  return { text: s.lastPeriod ? `${at} · ${periodName(s.lastPeriod, c.grain)} judged` : at, problem: false };
}

export interface RunLike {
  triggerKey: string;
  status: string;
  error: string | null;
  /** The answer a scheduled question sent, when its conversation is the reader's to open. */
  answer?: { threadId: string; runId: string } | null;
  insights?: { id: string; title: string }[];
}

/** What a run did, in a few words, and whether it went wrong. */
export function runLine(r: RunLike): { text: string; tone: "ok" | "bad" | "pending" | "plain" } {
  const found = r.triggerKey.startsWith("found:");
  const roundup = r.triggerKey.startsWith("roundup:");
  const what = found
    ? `Told: ${r.insights?.[0]?.title ?? "a finding"}`
    : roundup
      ? `The day's roundup: ${r.insights?.length ?? 0} ${(r.insights?.length ?? 0) === 1 ? "finding" : "findings"}`
      : r.answer
        ? "Answered and sent"
        : "Sent";
  if (r.status === "failed") return { text: `Failed: ${r.error ?? "it didn't go"}`, tone: "bad" };
  if (r.status === "skipped") return { text: `Skipped: ${r.error ?? "nothing to send"}`, tone: "plain" };
  if (r.status === "delivered") return { text: what, tone: "ok" };
  if (r.status === "waiting") {
    return { text: roundup ? "Waiting for 07:00" : "Waiting for its investigation", tone: "pending" };
  }
  if (r.status === "writing") return { text: "Writing…", tone: "pending" };
  if (r.status === "sending") return { text: "Sending…", tone: "pending" };
  return { text: "Running…", tone: "pending" };
}

export interface HappensNames {
  /** Each watched metric's name, and how many other routines watch it. */
  metrics: { title: string; others: number; grain: CheckGrain | null }[];
  /** A line's value as its metric shows it ("$400k"). */
  line: string | null;
  source: string | null;
  /** Who it reaches, in words ("you, Sam and Ines"); null for nobody. */
  where: string | null;
  /** It reaches past its owner: the team's. */
  team: boolean;
  /** Its first run or check, in words. */
  first: string | null;
}

/** What a routine does each time (the composer's "What happens", a routine's page), what it keeps, and who it is. */
export function whatHappens(
  spec: RoutineSpec,
  n: HappensNames,
): { items: string[]; keeps: { kept: boolean; text: string }; who: string; first: string | null } {
  const where = n.where;
  const who = n.team
    ? "A team routine: owners and admins make these. It uses the workspace's shared knowledge only, never anyone's personal memory."
    : "Only you get it.";
  if (spec.trigger === "schedule") {
    const when = ruleWords(spec.rule);
    const a = spec.action;
    const tell = where ? ` to ${where}` : "";
    if (a.kind === "ask") {
      return {
        items: [
          `${when}, the analyst answers “${a.question}” from ${n.source ?? "its source"}, checked like any answer.`,
          `It sends the answer${tell}.`,
          "It keeps each answer in its conversation in Ask, where anyone it reaches can ask on.",
        ],
        keeps: { kept: true, text: "Keeps each answer: a conversation in Ask." },
        who,
        first: n.first,
      };
    }
    return {
      items: [
        `${when}, OpenDash gathers what's open in Insights and each person's open tasks.`,
        `It emails them${tell}. With nothing to say, nothing is sent.`,
      ],
      keeps: { kept: false, text: "Nothing kept: what's found lives in Insights." },
      who,
      first: n.first,
    };
  }
  const names = n.metrics.map((m) => m.title);
  const metrics = names.length
    ? listWords(names.length > 3 ? [...names.slice(0, 2), `${names.length - 2} more`] : names)
    : "Each metric";
  const grains = new Set(n.metrics.map((m) => m.grain));
  const cadence =
    grains.size === 1 && grains.has("month") ? "after each month closes" : "each week, once its data is in";
  const shared = n.metrics.filter((m) => m.others > 0);
  const items = [
    `OpenDash checks ${metrics} ${cadence}, at 06:00 where the workspace is.${
      shared.length
        ? ` ${shared.length === 1 ? `${shared[0]?.title} is` : "Some are"} watched by other routines too, so each is still one query.`
        : ""
    }`,
  ];
  const c = spec.condition;
  const how = spec.tell === "at_once" ? "at once" : "in the day's roundup at 07:00";
  const tell = where ? `it tells ${where} ${how}` : "it keeps it in Insights";
  if (c.kind === "unusual") {
    items.push(`If one is outside its usual range, or its trend shifts, ${tell}.`);
  } else if (c.kind === "crosses") {
    const line = n.line ?? String(c.value);
    items.push(`If ${names[0] ?? "it"} is ${c.direction} ${line}, ${tell}.`);
    items.push(
      `It tells once, and again only after ${names[0] ?? "it"} has come back ${c.direction === "below" ? "above" : "below"} ${line}.`,
    );
  } else if (c.kind === "goal_risk") {
    items.push(`If a goal on one is at risk of being missed, ${tell}.`);
  } else {
    items.push(`If its source's data hasn't arrived when it's checked, ${tell}.`);
  }
  if (spec.investigate) {
    items.push("It investigates each finding first, from the background budget, and waits at most 30 minutes for it.");
  }
  items.push("The finding is filed in Insights once, whichever routines tell people about it.");
  return {
    items,
    keeps: { kept: false, text: "Nothing kept apart: what's found is an insight, and lives in Insights." },
    who,
    first: n.first,
  };
}
