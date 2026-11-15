/**
 * A routine as one sentence: "Every Monday at 08:00, ask “How did MRR move last week?” and send the answer to Priya and
 * #leadership." Its parts carry their role (when, what, where) for the composer's highlights. Pure:
 * the names come resolved.
 */
import type { Condition, RoutineSpec, ScheduleRule, Weekday } from "./spec";

export interface SentencePart {
  text: string;
  role?: "when" | "what" | "where";
}

export interface SentenceNames {
  /** The source it asks, the metrics it watches: null for one that's gone. */
  metrics?: string[];
  /** A line's value as its metric shows it ("$400k"). */
  line?: string;
  /** Who it emails, by name; the viewer is "me". */
  people: { name: string; isViewer: boolean }[];
  /** The Slack channels it posts to, "#name". */
  channels: string[];
}

const DAY_NAMES: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};
const ORDER: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** "a", "a and b", "a, b and c". */
export function listWords(items: string[], last = "and"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${last} ${items.at(-1)}`;
}

/** "Every Monday at 08:00", "Every weekday at 09:00", "On the last day of each month at 18:00". */
export function ruleWords(rule: ScheduleRule): string {
  if (rule.every === "day") return `Every day at ${rule.at}`;
  if (rule.every === "month") {
    return `On the ${rule.on === "first" ? "first" : "last"} day of each month at ${rule.at}`;
  }
  const days = ORDER.filter((d) => rule.days.includes(d));
  if (days.length === 7) return `Every day at ${rule.at}`;
  if (days.length === 5 && !days.includes("sat") && !days.includes("sun")) return `Every weekday at ${rule.at}`;
  return `Every ${listWords(days.map((d) => DAY_NAMES[d]))} at ${rule.at}`;
}

function metricWords(names: string[] | undefined): string {
  const all = names?.length ? names : ["a metric that's gone"];
  return all.length > 3 ? `${all.slice(0, 2).join(", ")} or ${all.length - 2} more` : listWords(all, "or");
}

function conditionWords(c: Condition, metrics: string, line: string | undefined): string {
  if (c.kind === "unusual") return `${metrics} is unusual`;
  if (c.kind === "crosses")
    return `${metrics} ${c.direction === "below" ? "falls below" : "goes above"} ${line ?? c.value}`;
  if (c.kind === "goal_risk") return `${metrics} is at risk of missing its goal`;
  return `${metrics} has no data for its latest period`;
}

/** Who it reaches: "me", "Priya and #leadership"; null for nobody (the workspace's Watching routine). */
export function destinationWords(names: Pick<SentenceNames, "people" | "channels">): string | null {
  const people = [...names.people].sort((a, b) => Number(b.isViewer) - Number(a.isViewer));
  const all = [...people.map((p) => (p.isViewer ? "me" : p.name)), ...names.channels];
  return all.length ? listWords(all) : null;
}

export function routineSentence(spec: RoutineSpec, names: SentenceNames): SentencePart[] {
  const where = destinationWords(names);
  if (spec.trigger === "schedule") {
    const a = spec.action;
    const what = a.kind === "ask" ? `ask “${a.question}” and send the answer` : "send what OpenDash found";
    return [
      { text: ruleWords(spec.rule), role: "when" },
      { text: ", " },
      { text: what, role: "what" },
      ...(where ? [{ text: " to " }, { text: where, role: "where" as const }] : []),
      { text: "." },
    ];
  }
  const when = conditionWords(spec.condition, metricWords(names.metrics), names.line);
  if (!where) {
    return [
      { text: "When " },
      { text: when, role: "when" },
      { text: ", " },
      { text: "keep it in Insights", role: "what" },
      { text: "." },
    ];
  }
  return [
    { text: "When " },
    { text: when, role: "when" },
    { text: ", " },
    { text: spec.investigate ? "investigate, then tell" : "tell", role: "what" },
    { text: " " },
    { text: where, role: "where" },
    { text: spec.tell === "at_once" ? " at once" : " in the day's roundup", role: "what" },
    { text: "." },
  ];
}

export const sentenceText = (parts: SentencePart[]) => parts.map((p) => p.text).join("");
