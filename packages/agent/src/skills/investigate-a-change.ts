import type { BuiltinSkill } from "./index";

/**
 * How to explain a change in a number, for the analyst asked why and for the Investigator checking a change OpenDash
 * flagged: one method, written once. The Investigator's prompt carries this body and only
 * says how its write-up's fields map to it.
 */
export const investigateAChange: BuiltinSkill = {
  name: "investigate-a-change",
  title: "Investigate a change",
  version: 2,
  description: "Asked why a number changed, or what drove it (why did MRR drop in September, what's behind the churn)",
  body: `1. Check the change is real. Ask for that month and the twelve before it, by month: the verified metric with metric_query, or your own SQL when no metric covers it, and check the month's data is complete (its latest date). Count the month again another way (your own SQL, read the way the metric's definition reads) and list the two as a cross-check; only a verified metric's number, when a person asks, needs no recount. If the change isn't there (the month is in line with the months before, or its data isn't complete), say so: that's the answer.
2. Explain it: drill down one or two levels, the month and the month before grouped by the fields that split it (plan, country, channel…). Which segments moved most? A reason says what moved, by how much, and how much of the whole change that is: compute that share with share() or delta(), never estimate it.
3. Write it up with your ending tool: what moved, at most three reasons (most likely first, each saying whether it explains most of the change or part of it), and what you couldn't check (data the source doesn't have that could explain it).`,
};
