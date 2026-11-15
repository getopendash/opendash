/**
 * A routine as the composer holds it: what's picked, as a form holds it, and the spec it
 * makes. The web's composer and Describe it's proposals (the composer agent's) share it. Pure, imports only the spec:
 * the store checks everything again on save.
 */

import type { MetricFormat } from "../answer/format";
import {
  ROUTINE_SPEC_VERSION,
  type RoutineSpec,
  type ScheduleRule,
  type Sensitivity,
  type SlackDestination,
  type Weekday,
} from "./spec";

export type Repeats = "day" | "weekday" | "week" | "month";
const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri"];

export interface RoutineDraft {
  trigger: "schedule" | "found" | null;
  repeats: Repeats;
  days: Weekday[];
  on: "first" | "last";
  at: string;
  action: "ask" | "digest";
  connectionId: string | null;
  question: string;
  metricIds: string[];
  condition: "unusual" | "crosses" | "goal_risk" | "missing";
  sensitivity: Sensitivity;
  direction: "below" | "above";
  /** The line as typed ("400k", "$1.2m", "38%"). */
  line: string;
  tell: "at_once" | "roundup";
  investigate: boolean;
  userIds: string[];
  /** The Slack channels it posts to, as Slack named them when they were picked. */
  slack: SlackDestination[];
}

export function emptyDraft(me: string): RoutineDraft {
  return {
    trigger: null,
    repeats: "week",
    days: ["mon"],
    on: "first",
    at: "07:00",
    action: "ask",
    connectionId: null,
    question: "",
    metricIds: [],
    condition: "unusual",
    sensitivity: "medium",
    direction: "below",
    line: "",
    tell: "at_once",
    investigate: false,
    userIds: [me],
    slack: [],
  };
}

/** A line as typed, in the metric's own units: "400k" is 400000, "38%" of a percent metric is 0.38. */
export function parseLine(text: string, format: MetricFormat): number | null {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[$,\s]/g, "");
  const m = /^(-?\d+(?:\.\d+)?)(k|m|b|%)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  const scaled = unit === "k" ? n * 1e3 : unit === "m" ? n * 1e6 : unit === "b" ? n * 1e9 : n;
  // A percent metric's values are fractions; people type 38 or 38% for 38%.
  if (format === "percent") return unit === "%" || Math.abs(n) > 1 ? scaled / 100 : scaled;
  return unit === "%" ? null : scaled;
}

/** A line as the composer shows it again, for a spec that has one. */
export function lineText(value: number, format: MetricFormat): string {
  if (format === "percent") return `${Number((value * 100).toFixed(4))}%`;
  if (Math.abs(value) >= 1e6 && value % 1e5 === 0) return `${value / 1e6}m`;
  if (Math.abs(value) >= 1e3 && value % 100 === 0) return `${value / 1e3}k`;
  return String(value);
}

function ruleOf(d: RoutineDraft): ScheduleRule {
  if (d.repeats === "day") return { every: "day", at: d.at };
  if (d.repeats === "weekday") return { every: "week", days: [...WEEKDAYS], at: d.at };
  if (d.repeats === "month") return { every: "month", on: d.on, at: d.at };
  return { every: "week", days: d.days, at: d.at };
}

/** The spec the draft makes, unchecked (the composer shows `specProblem` of it, the store refuses an invalid one). */
export function specOf(d: RoutineDraft, format: MetricFormat | null): unknown {
  if (d.trigger === "schedule") {
    const action =
      d.action === "ask" ? { kind: "ask", connectionId: d.connectionId, question: d.question } : { kind: "digest" };
    return { version: ROUTINE_SPEC_VERSION, trigger: "schedule", rule: ruleOf(d), action };
  }
  if (d.trigger === "found") {
    const condition =
      d.condition === "unusual"
        ? { kind: "unusual", sensitivity: d.sensitivity }
        : d.condition === "crosses"
          ? { kind: "crosses", direction: d.direction, value: parseLine(d.line, format ?? "number") }
          : { kind: d.condition };
    return {
      version: ROUTINE_SPEC_VERSION,
      trigger: "found",
      metricIds: d.metricIds,
      condition,
      tell: d.tell,
      investigate: d.investigate,
    };
  }
  return null;
}

/** What's still to pick, in the composer's words, before the spec's own checks (null when nothing is). */
export function draftProblem(d: RoutineDraft, format: MetricFormat | null): string | null {
  if (!d.trigger) return "Pick what starts it.";
  if (d.trigger === "schedule") {
    if (d.repeats === "week" && !d.days.length) return "Pick at least one day.";
    if (d.action === "ask" && d.question.trim().length < 3) return "Write the question.";
    if (d.action === "ask" && !d.connectionId) return "Pick a source.";
    return null;
  }
  if (!d.metricIds.length) return d.condition === "crosses" ? "Pick the metric." : "Pick at least one metric.";
  if (d.condition === "crosses" && parseLine(d.line, format ?? "number") === null) return "Write the line, like 400k.";
  return null;
}

/** A saved routine as the composer holds it. */
export function draftOf(
  spec: RoutineSpec,
  userIds: string[],
  me: string,
  format: MetricFormat | null,
  slack: SlackDestination[] = [],
): RoutineDraft {
  const d = { ...emptyDraft(me), userIds, slack };
  if (spec.trigger === "schedule") {
    const r = spec.rule;
    const weekdays = r.every === "week" && r.days.length === 5 && WEEKDAYS.every((x) => r.days.includes(x));
    const a = spec.action;
    return {
      ...d,
      trigger: "schedule",
      repeats: r.every === "week" ? (weekdays ? "weekday" : "week") : r.every,
      days: r.every === "week" ? r.days : d.days,
      on: r.every === "month" ? r.on : d.on,
      at: r.at,
      action: a.kind,
      connectionId: a.kind === "ask" ? a.connectionId : null,
      question: a.kind === "ask" ? a.question : "",
    };
  }
  const c = spec.condition;
  return {
    ...d,
    trigger: "found",
    metricIds: spec.metricIds,
    condition: c.kind,
    sensitivity: c.kind === "unusual" ? c.sensitivity : d.sensitivity,
    direction: c.kind === "crosses" ? c.direction : d.direction,
    line: c.kind === "crosses" ? lineText(c.value, format ?? "number") : "",
    tell: spec.tell,
    investigate: spec.investigate,
  };
}
