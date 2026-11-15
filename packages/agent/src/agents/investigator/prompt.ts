/**
 * The Investigator's instructions (the Investigator; v0): the insight it checks, how it works (the investigate-a-change
 * skill, written once for it and the analyst), and the same number and data rules as the analyst's, which the gate
 * enforces.
 */
import { tablesFolder } from "../../instructions/catalog";
import { part, type Sections } from "../../instructions/compose";
import {
  CANT_ASK,
  DATA_RULES,
  dialectSection,
  glossarySection,
  keepTo,
  metricsSection,
  NOBODY_WAITING,
  numberRules,
  sourceLine,
  sourceSection,
  todayLine,
} from "../../instructions/sections";
import { investigateAChange } from "../../skills/investigate-a-change";

export interface InvestigatorPromptInput {
  sourceName: string;
  dialectName: string;
  dialectNotes: string;
  catalog: string;
  metrics: string;
  glossary?: string;
  insight: {
    title: string;
    kind: string;
    direction: string | null;
    period: string;
    metricSlug: string;
    metricTitle: string;
  };
  now: Date;
  rowsShown: number;
  maxQueries: number;
}

const KIND: Record<string, string> = {
  anomaly: "its month is outside the range its own history expects",
  trend: "its month-to-month change shifted, and held",
  goal_risk: "on its current trend it may miss a goal",
};

export function investigatorSections(p: InvestigatorPromptInput): Sections {
  const month = p.insight.period.slice(0, 7);
  return [
    part.agent(
      `You are the Investigator in OpenDash. OpenDash's check of one of a source's verified metrics flagged a change; you check what it found and explain it, for the team's insights. ${NOBODY_WAITING}\n\n`,
    ),
    part.source(sourceLine(p.sourceName, p.dialectName)),
    part.question(todayLine(p.now)),
    part.question(`# The insight
"${p.insight.title}": ${KIND[p.insight.kind] ?? "it changed"}. Metric: ${p.insight.metricTitle} (${p.insight.metricSlug}). Month: ${month}${p.insight.direction ? `, ${p.insight.direction}` : ""}.

`),
    part.agent(`# How you work
${investigateAChange.body}
Your ending tool is investigation: confirmed false when the change isn't there; each reason "explains" (most of it) or "part"; the two counts in cross_checks.
${CANT_ASK} ${keepTo(p.maxQueries, p.rowsShown)}

${numberRules({ texts: "the investigation's texts", tool: "investigation" })}

${DATA_RULES}

`),
    part.source(metricsSection(p.metrics)),
    p.glossary && part.source(glossarySection(p.glossary)),
    part.agent(dialectSection(p.dialectName, p.dialectNotes)),
    part.source(sourceSection(p.sourceName, p.catalog, tablesFolder(p.sourceName))),
  ];
}

/** Sent when the model stops without writing up. */
export const INVESTIGATION_NUDGE =
  "(OpenDash) The investigation ends with the investigation tool. Call it now with what you found.";

/** prepareStep's wrap-up note, when its budget is nearly spent or too many queries failed. */
export const INVESTIGATION_WRAP_UP =
  "(OpenDash) Wrap up now: call investigation with what you found (confirmed false if you couldn't confirm the change), saying what you couldn't check.";
