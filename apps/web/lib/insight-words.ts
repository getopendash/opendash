import type { InsightView } from "@opendash/core";

const BASE: Record<string, string> = {
  rose: "rise",
  fell: "fall",
  grew: "grow",
  slowed: "slow",
  "sped up": "speed up",
  eased: "ease",
  steepened: "steepen",
  turned: "turn",
  stopped: "stop",
  started: "start",
};

/**
 * An insight as a question for the analyst (Investigate opens a thread). Words only: the analyst finds the
 * numbers itself. "New accounts fell more than usual in September 2026" → "Why did New accounts fall more than
 * usual in September 2026?"
 */
export function investigateQuestion(title: string): string {
  const goal = /^(.+) is on course to (miss|go over) its goal for (.+)$/.exec(title.trim());
  if (goal) {
    const [, metric, way, due] = goal;
    return `What would it take for ${metric} to ${way === "miss" ? "reach" : "stay within"} its goal for ${due}?`;
  }
  // Trends: "MRR's growth slowed over the last 3 months", "Net adds turned from growth to decline over …".
  const shift = /^(.+(?:'s|')) (growth|decline) (slowed|sped up|eased|steepened) (over the last \d+ months)$/.exec(
    title.trim(),
  );
  if (shift) {
    const [, who, noun, verb, span] = shift;
    return `Why did ${who} ${noun} ${BASE[verb as string]} ${span}?`;
  }
  const turn = /^(.+) (turned|stopped|started) (.+) (over the last \d+ months)$/.exec(title.trim());
  if (turn) {
    const [, metric, verb, rest, span] = turn;
    return `Why did ${metric} ${BASE[verb as string]} ${rest} ${span}?`;
  }
  // Lines: "MRR went below $400k in September 2026", "New accounts has been below 50 for 3 weeks".
  const went = /^(.+) went (below|above) (.+) in (.+)$/.exec(title.trim());
  if (went) {
    const [, metric, way, line, when] = went;
    return `Why did ${metric} go ${way} ${line} in ${when}?`;
  }
  const stayed = /^(.+) has been (below|above) (.+) for (\d+ (?:weeks|months))$/.exec(title.trim());
  if (stayed) {
    const [, metric, way, line, span] = stayed;
    return `Why has ${metric} been ${way} ${line} for ${span}?`;
  }
  const m = /^(.+) (rose|fell|grew) (more|less) than usual in (.+)$/.exec(title.trim());
  if (!m) return `What's behind this: ${title.trim()}?`;
  const [, metric, verb, amount, month] = m;
  return `Why did ${metric} ${BASE[verb as string]} ${amount} than usual in ${month}?`;
}

/** The chip on an insight's card. */
export function severityChip(i: Pick<InsightView, "kind" | "severity">): {
  label: string;
  tone: "default" | "warning" | "danger";
} {
  if (i.kind === "data_quality") return { label: "Data late", tone: "warning" };
  if (i.kind === "goal_risk") return { label: "Goal at risk", tone: i.severity >= 3 ? "danger" : "warning" };
  if (i.kind === "threshold") return { label: "Line crossed", tone: i.severity >= 2 ? "warning" : "default" };
  // A trend's kind is in the card's line ("Trend · MRR"); the chip says how big the shift is.
  if (i.kind === "trend") {
    return i.severity >= 3
      ? { label: "Very large shift", tone: "danger" }
      : i.severity === 2
        ? { label: "Large shift", tone: "warning" }
        : { label: "Notable", tone: "default" };
  }
  return i.severity >= 3
    ? { label: "Very large change", tone: "danger" }
    : i.severity === 2
      ? { label: "Large change", tone: "warning" }
      : { label: "Notable", tone: "default" };
}

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const sameDay = (a: Date, b: Date) => a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);

/** "Found today", "Found Oct 9 · seen again today". */
export function foundLine(i: Pick<InsightView, "firstSeenAt" | "lastSeenAt" | "occurrences">, now: number): string {
  const today = new Date(now);
  const day = (iso: string) => (sameDay(new Date(iso), today) ? "today" : DAY.format(new Date(iso)));
  const first = `Found ${day(i.firstSeenAt)}`;
  return i.occurrences > 1 && !sameDay(new Date(i.firstSeenAt), new Date(i.lastSeenAt))
    ? `${first} · seen again ${day(i.lastSeenAt)}`
    : first;
}

/** Why a closed insight closed on its own, by what it was. */
export function resolvedLine(kind: InsightView["kind"]): string {
  if (kind === "data_quality") return "Resolved: the data landed";
  if (kind === "threshold") return "Resolved: back on the right side of the line";
  if (kind === "goal_risk") return "Resolved: back on course";
  if (kind === "trend") return "Resolved: the shift didn't hold, or is now the usual";
  return "Resolved";
}

export const DISMISS_LABELS = {
  not_a_problem: "Not a problem",
  known_issue: "A known issue",
  wrong_data: "The data is wrong",
  not_my_area: "Not our area",
} as const;

const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const WEEK = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "September 2026", or "Week of Oct 5, 2026": the period a figure is for. */
export function periodLabel(period: string, grain: "week" | "month" = "month"): string {
  const d = new Date(`${period.slice(0, 10)}T00:00:00Z`);
  return grain === "week" ? `Week of ${WEEK.format(d)}` : MONTH.format(d);
}
