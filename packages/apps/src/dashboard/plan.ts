/**
 * A dashboard's plan: what the plan card draws and the person approves before anything is built. An App's
 * plan (`AppPlan`) is what the analyst gives now; `Plan` is how plans are stored and read, the ones written for the
 * kit's dashboards (their pages, their sections with kinds, widths and chart types) included, so a stored thread's
 * plan card still draws.
 */
import { z } from "zod";
import { CHART_TYPES } from "./contracts";
import { LIMITS } from "./definition";

/** A plan's pages and sections, at most. */
const PLAN_LIMITS = { pages: 8, sections: 40 } as const;

const id = (prefix: "f" | "p" | "s") =>
  z.string().regex(new RegExp(`^${prefix}_[a-z0-9_]{1,40}$`), `an id like ${prefix}_revenue`);
const label = z.string().trim().min(1).max(80);

export const PLAN_KINDS = [
  "kpi",
  "chart",
  "grid",
  "custom",
  "text",
  "stats",
  "meters",
  "next",
  "signal",
  "flow",
  "facts",
  "summary",
  "whatif",
] as const;
export const PLAN_WIDTHS = ["full", "half", "third", "quarter"] as const;
/** A planned chart's look: its type, or what its options made of one. */
export const PLAN_CHARTS = [...CHART_TYPES, "stacked_bar", "stacked_area", "multiples", "ranked"] as const;

export const PlanSection = z.object({
  id: id("s"),
  kind: z.enum(PLAN_KINDS),
  title: label,
  width: z.enum(PLAN_WIDTHS).default("full"),
  /** For a chart: what it looks like (its type, or stacked, ranked, small multiples). */
  chart: z.enum(PLAN_CHARTS).optional(),
  /** For a KPI: its trend drawn under it, and a meter against its target. */
  trend: z.boolean().optional(),
  target: z.boolean().optional(),
  /** What it shows, in a line: "this month against last, by country". */
  detail: z.string().max(300).optional(),
  /**
   * For a list: the changes each row can make in a service, said before Build it ("Move to Done in Jira"): each is
   * confirmed by the person pressing it, with their own account.
   */
  changes: z.array(z.string().trim().min(1).max(60)).max(3).optional(),
});
export type PlanSection = z.infer<typeof PlanSection>;

export const PlanPage = z.object({
  id: id("p"),
  title: label,
  /** Its sections, a list with the record beside it, or one record. */
  layout: z.enum(["sections", "list", "record"]).default("sections"),
  sections: z.array(PlanSection).min(1).max(PLAN_LIMITS.sections),
});

export const Plan = z
  .object({
    title: label,
    /** Its pages as tabs, or down a sidebar with their counts. */
    nav: z.enum(["tabs", "sidebar"]).default("tabs"),
    /** Who it's for and what they decide with it, in a line. */
    purpose: z.string().trim().min(1).max(200),
    /** What it reads: datasets (released or checked), or tables the dashboard's own SQL reads (schema.table). */
    datasets: z.array(z.string().max(127)).max(12).default([]),
    filters: z
      .array(z.object({ id: id("f"), kind: z.enum(["period", "select"]), label }))
      .max(LIMITS.filters)
      .default([]),
    pages: z.array(PlanPage).min(1).max(PLAN_LIMITS.pages),
    /**
     * What its data can't do yet, said before Build it: "Usage isn't linked to accounts, so usage per
     * customer can't be drawn; it shows usage for all customers instead." At most four, each a sentence.
     */
    notes: z.array(z.string().trim().min(1).max(240)).max(4).optional(),
    /**
     * What the analyst took from a picture or file the person attached: its pages, each piece matched to
     * a section kind (or a custom part where none fits), its look, and what the data has, will use instead, or lacks.
     * Its sample numbers are never copied: thresholds and weights become inputs.
     */
    reference: z
      .object({
        from: z.array(z.string().trim().min(1).max(120)).min(1).max(4),
        pages: z.string().trim().min(1).max(200),
        pieces: z
          .array(z.object({ piece: z.string().trim().min(1).max(60), as: z.string().trim().min(1).max(60) }))
          .min(1)
          .max(20),
        look: z.string().trim().max(160).optional(),
        data: z
          .array(z.object({ state: z.enum(["have", "instead", "missing"]), say: z.string().trim().min(1).max(160) }))
          .max(6)
          .default([]),
      })
      .optional(),
  })
  .superRefine((p, ctx) => {
    const sections = p.pages.flatMap((page) => page.sections);
    // A chart is drawn as its type: the plan says which, so what's approved is what's compared.
    for (const s of sections) {
      if (s.kind === "chart" && !s.chart) {
        ctx.addIssue({
          code: "custom",
          path: ["pages"],
          message: `"${s.title}" is a chart: say what kind (${PLAN_CHARTS.join(", ")}).`,
        });
      }
    }
    if (sections.length > PLAN_LIMITS.sections) {
      ctx.addIssue({ code: "custom", path: ["pages"], message: `At most ${PLAN_LIMITS.sections} sections in all.` });
    }
    const seen = new Set<string>();
    for (const x of [...p.pages.map((page) => page.id), ...sections.map((s) => s.id), ...p.filters.map((f) => f.id)]) {
      if (seen.has(x)) ctx.addIssue({ code: "custom", path: ["pages"], message: `${x} is used twice.` });
      seen.add(x);
    }
  });
export type Plan = z.infer<typeof Plan>;

/**
 * An App's plan, as the agent gives it (a plan that still offered the kit's kinds could still be a kit
 * dashboard): each screen and the pieces on it, each described in words, its code
 * to come. No kinds, widths, chart types or layouts. What it gives is a Plan (every piece "custom"), so plans stored
 * before read as they did.
 */
const AppPiece = z.object({
  id: id("s"),
  kind: z.literal("custom").default("custom"),
  title: label,
  /** What it shows or lets the person do, in a line: "the queue, oldest and most urgent first; pick one to work it". */
  detail: z.string().max(300).optional(),
  changes: PlanSection.shape.changes,
});
export const AppPlan = z
  .object({
    title: Plan.shape.title,
    purpose: Plan.shape.purpose,
    datasets: Plan.shape.datasets,
    filters: Plan.shape.filters,
    pages: z
      .array(z.object({ id: id("p"), title: label, sections: z.array(AppPiece).min(1).max(PLAN_LIMITS.sections) }))
      .min(1)
      .max(PLAN_LIMITS.pages),
    notes: Plan.shape.notes,
    reference: Plan.shape.reference,
  })
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    const ids = [
      ...p.pages.map((x) => x.id),
      ...p.pages.flatMap((x) => x.sections.map((s) => s.id)),
      ...p.filters.map((f) => f.id),
    ];
    for (const x of ids) {
      if (seen.has(x)) ctx.addIssue({ code: "custom", path: ["pages"], message: `${x} is used twice.` });
      seen.add(x);
    }
  });
export type AppPlan = z.infer<typeof AppPlan>;
