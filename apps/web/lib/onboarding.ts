import "server-only";
import { deploymentKeys, hasAsked, listSourceStates, offeredModels } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { cache } from "react";
import { requireTenant } from "./auth";
import { canManageSources } from "./sources";
import { canManageTeam } from "./team";

/**
 * The guided setup (/get-started): where a new workspace stands on the two things a first answer needs, its data
 * and a model, read on each of its pages. Nothing is stored for it: each step is done when the thing itself is
 * there (a source, a model that runs), so it can be left at any point and picked up again, or never opened at all.
 */

/** The steps, in order; each is a page under /get-started. */
export const ONBOARDING_STEPS = [
  { key: "welcome", label: "Welcome", href: "/get-started" },
  { key: "data", label: "Data", href: "/get-started/data" },
  { key: "ai", label: "Model", href: "/get-started/ai" },
  { key: "ask", label: "First question", href: "/get-started/ask" },
] as const;
export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number]["key"];

/**
 * The sample data: tables of ClickHouse's public playground that make good first questions, each small enough to be
 * learned in seconds. The ones the playground has when it's connected are learned; its other tables stay known.
 */
export const SAMPLE_TABLES = ["default.uk_price_paid", "default.hackernews", "default.opensky", "default.covid"];

/** What the sample data is called once connected (its database is "default"). */
export const SAMPLE_SOURCE_NAME = "ClickHouse playground";

/** First questions for the sample data, each about one of its tables. */
const SAMPLE_QUESTIONS: { table: string; topic: string; question: string }[] = [
  {
    table: "default.uk_price_paid",
    topic: "UK house prices",
    question: "How has the average house price in the UK changed each year since 2010?",
  },
  {
    table: "default.uk_price_paid",
    topic: "UK house prices",
    question: "Which 10 towns had the highest median sale price last year?",
  },
  {
    table: "default.hackernews",
    topic: "Hacker News",
    question: "How many Hacker News stories were posted each year, and how did their average score change?",
  },
  {
    table: "default.opensky",
    topic: "Flights",
    question: "How did the number of flights per month change between 2019 and 2021?",
  },
  {
    table: "default.covid",
    topic: "COVID-19",
    question: "Which 10 countries reported the most new COVID-19 cases in 2021?",
  },
];

/** First questions for someone's own database: about whatever it holds. */
const OWN_QUESTIONS = [
  { topic: "Get oriented", question: "What can I ask about this data? Give me five useful questions." },
  { topic: "Overview", question: "Which are the largest tables, and what does each one hold?" },
  { topic: "Recent activity", question: "What changed most in the last 30 days of data?" },
];

export interface OnboardingSource {
  id: string;
  name: string;
  sample: boolean;
  /** Learned at least once: it can be asked about. */
  ready: boolean;
  /** Being learned, or waiting for its tables to be chosen. */
  working: boolean;
  failed: boolean;
}

export interface OnboardingState {
  user: { id: string; name: string; email: string };
  orgId: string;
  /** Owners and admins set a workspace up; anyone else is shown around. */
  canSetUp: boolean;
  source: OnboardingSource | null;
  /** A model can run: the deployment's own, or a provider the workspace set up. */
  model: { ready: boolean; label: string | null; through: string | null };
  asked: boolean;
}

export const onboardingState = cache(async (): Promise<OnboardingState> => {
  const viewer = await requireTenant();
  const { orgId } = viewer.ctx;
  const { states, offered, asked } = await withTenant(viewer.ctx, async (tx) => ({
    states: await listSourceStates(tx, orgId),
    offered: await offeredModels(tx, orgId, deploymentKeys()),
    asked: await hasAsked(tx, { orgId, userId: viewer.user.id }),
  }));
  // The one being set up: the newest, unless an older one is already learned.
  const picked = states.find((s) => s.learnedAt !== null) ?? states[0] ?? null;
  const group = offered.default ? offered.offered.find((g) => g.provider === offered.default?.provider) : null;
  const model = group?.models.find((m) => m.id === offered.default?.model) ?? null;
  return {
    user: viewer.user,
    orgId,
    canSetUp: canManageSources(viewer.role) && canManageTeam(viewer.role),
    source: picked
      ? {
          id: picked.id,
          name: picked.name,
          sample: picked.name === SAMPLE_SOURCE_NAME,
          ready: picked.learnedAt !== null && picked.status !== "learning",
          working: picked.status === "learning" || picked.status === "syncing",
          failed: picked.status === "failed" || picked.status === "error",
        }
      : null,
    model: { ready: Boolean(offered.default && group), label: model?.label ?? null, through: group?.label ?? null },
    asked,
  };
});

/** The questions to start with, for the source being set up. */
export function starterQuestions(
  source: OnboardingSource | null,
  learned: string[],
): { topic: string; question: string }[] {
  if (!source?.sample) return OWN_QUESTIONS;
  const has = new Set(learned);
  const mine = SAMPLE_QUESTIONS.filter((q) => has.has(q.table));
  // One per topic first, so the four cards show the range of what's there.
  const seen = new Set<string>();
  const first = mine.filter((q) => {
    if (seen.has(q.topic)) return false;
    seen.add(q.topic);
    return true;
  });
  return (first.length ? first : SAMPLE_QUESTIONS).slice(0, 4).map(({ topic, question }) => ({ topic, question }));
}
