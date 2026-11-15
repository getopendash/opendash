/**
 * Every email a routine sends, composed by core and rendered here: a scheduled question's answer, what OpenDash
 * found, a finding told at once or the day's roundup, and to its owner, a routine that paused itself. Each says why it
 * came (the routine's sentence) and where to change it.
 */
import { type DigestData, digestEmail } from "./digest-email";
import { oneLine, type RenderedEmail, renderEmail } from "./layout";

/** Why the email came, and where to change or stop it. */
export interface RoutineFooter {
  /** The routine as one sentence ("Every Monday at 08:00, ask how many accounts signed up and send it to me."). */
  because: string;
  /** Its page in OpenDash. */
  routineUrl: string;
  /** The one-click unsubscribe page for this email, when there is one. */
  unsubscribeUrl?: string;
}

/** The footer's words: the routine, and how to leave it. */
export function routineFooter(f: RoutineFooter): string {
  return `You get this from a routine: ${f.because} Change it: ${f.routineUrl}${
    f.unsubscribeUrl ? ` · Unsubscribe: ${f.unsubscribeUrl}` : ""
  }`;
}

/** A scheduled question's answer, as its conversation keeps it. */
export interface AnswerEmailData {
  organization: string;
  baseUrl: string;
  /** The conversation the answer is in (the link opens it), and the run that answered. */
  threadId: string;
  runId: string;
  question: string;
  sourceName: string;
  answeredAt: string;
  /** The answer as plain text, and whether the answer gate verified it. */
  answer: string;
  verified: boolean;
}

/** One finding as an email tells it. */
export interface FindingItem {
  id: string;
  title: string;
  /** Its figure against what's usual, or the line ("77 · usually 84–94"). */
  detail: string;
  /** Its investigation's verdict, when it had one. */
  verdict?: string;
}

export interface FindingsEmailData {
  organization: string;
  baseUrl: string;
  /** The day's roundup, or one finding told at once. */
  roundup: boolean;
  findings: FindingItem[];
}

export interface PausedEmailData {
  organization: string;
  baseUrl: string;
  reason: string;
}

export type RoutineEmailData = RoutineFooter &
  (
    | { kind: "answer"; answer: AnswerEmailData }
    | { kind: "digest"; digest: DigestData }
    | { kind: "findings"; findings: FindingsEmailData }
    | { kind: "paused"; paused: PausedEmailData }
  );

const WHEN = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });

function answerEmail(d: AnswerEmailData, footer: string): RenderedEmail {
  const url = `${d.baseUrl.replace(/\/$/, "")}/ask/${encodeURIComponent(d.threadId)}`;
  return renderEmail({
    subject: oneLine(d.question),
    preheader: oneLine(d.answer),
    heading: oneLine(d.question),
    paragraphs: [
      `Answered ${WHEN.format(new Date(d.answeredAt))} from ${d.organization}'s ${d.sourceName}.${d.verified ? "" : " Some of it couldn't be checked: it's marked in OpenDash."}`,
      d.answer,
    ],
    button: { label: "Open the answer", url },
    note: "Every number opens the query behind it in OpenDash.",
    footer,
  });
}

function findingsEmail(d: FindingsEmailData, footer: string): RenderedEmail {
  const base = d.baseUrl.replace(/\/$/, "");
  const items = d.findings.map((f) => ({
    title: f.title,
    detail: f.verdict ? `${f.detail} · ${f.verdict}` : f.detail,
    url: `${base}/insights#${encodeURIComponent(f.id)}`,
  }));
  const first = d.findings[0];
  const many = d.findings.length;
  return renderEmail({
    subject: oneLine(
      d.roundup || !first ? `${many} ${many === 1 ? "finding" : "findings"} at ${d.organization} today` : first.title,
    ),
    preheader: oneLine(first ? `${first.title}: ${first.detail}` : `What OpenDash found at ${d.organization}.`),
    heading: d.roundup ? "Today's findings" : "OpenDash found something",
    paragraphs: [
      d.roundup
        ? `What OpenDash found at ${d.organization} since the last roundup, the most notable first.`
        : `From ${d.organization}'s latest figures.`,
    ],
    sections: items.length ? [{ title: d.roundup ? "Findings" : "Finding", items }] : [],
    button: { label: "Open Insights", url: `${base}/insights` },
    note: "Every number opens the query behind it in OpenDash.",
    footer,
  });
}

function pausedEmail(d: PausedEmailData, f: RoutineFooter): RenderedEmail {
  return renderEmail({
    subject: oneLine(`A routine of yours paused at ${d.organization}`),
    preheader: oneLine(d.reason),
    heading: "Your routine paused",
    paragraphs: [f.because, d.reason, "Resume it once what it needs is back; it starts again from its next time."],
    button: { label: "Open the routine", url: f.routineUrl },
    note: "Nothing more goes out from it until it's resumed.",
    footer: "You get this because you own the routine.",
  });
}

export function routineEmail(m: RoutineEmailData): RenderedEmail {
  const footer = routineFooter(m);
  switch (m.kind) {
    case "answer":
      return answerEmail(m.answer, footer);
    case "digest":
      return digestEmail(m.digest, footer);
    case "findings":
      return findingsEmail(m.findings, footer);
    case "paused":
      return pausedEmail(m.paused, m);
  }
}
