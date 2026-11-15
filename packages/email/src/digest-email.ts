import { oneLine, type RenderedEmail, renderEmail } from "./layout";

/** What OpenDash found, for one person (a routine's digest): composed by core, rendered here. */
export interface DigestData {
  organization: string;
  /** The web app's origin: every link points back into it. */
  baseUrl: string;
  counts: { insights: number; goalsAtRisk: number; tasks: number };
  insights: { title: string; detail?: string }[];
  tasks: { title: string; detail?: string }[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The digest: what's open in Insights, and the person's open tasks, each linking into the app. The figures are
 * the ones the app shows, as text: their traces are in the app, a link away. `footer`: why it came, and how to stop it.
 */
export function digestEmail(d: DigestData, footer: string): RenderedEmail {
  const base = d.baseUrl.replace(/\/$/, "");
  const parts = [
    plural(d.counts.insights, "insight is open", "insights are open"),
    ...(d.counts.goalsAtRisk ? [plural(d.counts.goalsAtRisk, "goal is at risk", "goals are at risk")] : []),
    `you have ${plural(d.counts.tasks, "open task", "open tasks")}`,
  ];
  const summary = `${parts.slice(0, -1).join(", ")}${parts.length > 1 ? ", and " : ""}${parts.at(-1)}.`;
  const sentence = summary.charAt(0).toUpperCase() + summary.slice(1);
  return renderEmail({
    subject: oneLine(`What's open at ${d.organization}: ${plural(d.counts.insights, "insight", "insights")}`),
    preheader: sentence,
    heading: oneLine(`What's open at ${d.organization}`),
    paragraphs: [sentence],
    sections: [
      ...(d.insights.length
        ? [{ title: "Insights", items: d.insights.map((i) => ({ ...i, url: `${base}/insights` })) }]
        : []),
      ...(d.tasks.length ? [{ title: "Your tasks", items: d.tasks.map((t) => ({ ...t, url: `${base}/tasks` })) }] : []),
    ],
    button: { label: "Open Insights", url: `${base}/insights` },
    note: "Every number opens the query behind it in OpenDash.",
    footer,
  });
}
