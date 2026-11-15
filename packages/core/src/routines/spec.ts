/**
 * A routine's spec: when it runs and what it does, as one value with its version inside. Where it goes
 * (people, Slack channels) is kept beside it on the routine, so "what's sent to me" is a lookup. Pure: no database,
 * so the composer, the store and the sentence share it.
 */
import { z } from "zod";

export const ROUTINE_SPEC_VERSION = 1;

/** A metric that's watched at most once per routine; a routine watches at most this many. */
export const MAX_WATCHED_METRICS = 50;

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "A time is HH:MM, from 00:00 to 23:59.");

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** When a scheduled routine runs, in the workspace's time zone. No RRULE strings: these are all it can say. */
export const ScheduleRule = z.discriminatedUnion("every", [
  z.object({ every: z.literal("day"), at: Time }),
  z.object({
    every: z.literal("week"),
    days: z
      .array(z.enum(WEEKDAYS))
      .min(1, "Pick at least one day.")
      .refine((d) => new Set(d).size === d.length, "Each day once."),
    at: Time,
  }),
  z.object({ every: z.literal("month"), on: z.enum(["first", "last"]), at: Time }),
]);
export type ScheduleRule = z.infer<typeof ScheduleRule>;

/**
 * What a scheduled routine does: ask a question, or send what was found. Sending a dashboard comes back when the new
 * dashboards are drawn on the server.
 */
export const ScheduledAction = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ask"),
    connectionId: z.uuid(),
    question: z.string().trim().min(3, "Write the question.").max(500, "Keep the question under 500 characters."),
  }),
  z.object({ kind: z.literal("digest") }),
]);
export type ScheduledAction = z.infer<typeof ScheduledAction>;

/** How wide "usual" is: the band's half-width in scaled MADs (lower sensitivity, wider band, fewer findings). */
export const SENSITIVITY = { lower: 4, medium: 3, higher: 2 } as const;
export type Sensitivity = keyof typeof SENSITIVITY;

/** What a routine that watches tells about. */
export const Condition = z.discriminatedUnion("kind", [
  /** Outside its usual range, or a trend that shifted. */
  z.object({ kind: z.literal("unusual"), sensitivity: z.enum(["lower", "medium", "higher"]) }),
  /** Beyond a line the team drew: one metric's value below or above it. */
  z.object({ kind: z.literal("crosses"), direction: z.enum(["below", "above"]), value: z.number().finite() }),
  z.object({ kind: z.literal("goal_risk") }),
  /** Its source's latest period hasn't landed. */
  z.object({ kind: z.literal("missing") }),
]);
export type Condition = z.infer<typeof Condition>;

export const ScheduleSpec = z.object({
  version: z.literal(ROUTINE_SPEC_VERSION),
  trigger: z.literal("schedule"),
  rule: ScheduleRule,
  action: ScheduledAction,
});

export const FoundSpec = z.object({
  version: z.literal(ROUTINE_SPEC_VERSION),
  trigger: z.literal("found"),
  metricIds: z
    .array(z.uuid())
    .min(1, "Pick at least one metric.")
    .max(MAX_WATCHED_METRICS, `A routine watches at most ${MAX_WATCHED_METRICS} metrics.`)
    .refine((ids) => new Set(ids).size === ids.length, "Each metric once."),
  condition: Condition,
  /** At once, one message a finding; or in the day's roundup at 07:00. */
  tell: z.enum(["at_once", "roundup"]),
  /** The Investigator rechecks each finding before it's told (within the background budget). */
  investigate: z.boolean(),
});

export const RoutineSpec = z.discriminatedUnion("trigger", [ScheduleSpec, FoundSpec]).superRefine((s, ctx) => {
  if (s.trigger === "found" && s.condition.kind === "crosses" && s.metricIds.length !== 1) {
    ctx.addIssue({ code: "custom", path: ["metricIds"], message: "A line is drawn on one metric." });
  }
});
export type RoutineSpec = z.infer<typeof RoutineSpec>;
export type FoundSpec = z.infer<typeof FoundSpec>;
export type ScheduleSpec = z.infer<typeof ScheduleSpec>;

/** A Slack channel a routine posts to. */
export const SlackDestination = z.object({
  teamId: z.string().min(1).max(40),
  channelId: z.string().min(1).max(40),
  name: z.string().min(1).max(80),
  /** A private channel: named only to whoever may know it (its routine's owner, owners and admins, the channel). */
  private: z.boolean().optional(),
});
export type SlackDestination = z.infer<typeof SlackDestination>;

/** The workspace's own routine: one-tap Watch adds metrics to it, and what it finds stays in Insights. */
export const WATCHING_KEY = "watching";

/**
 * Whether making or changing it needs an owner or admin: anything that reaches past the person themselves (other
 * people, a channel) or is the workspace's own. A routine that only tells its owner is anyone's to make.
 */
export function needsManager(r: { key: string | null; ownerId: string; userIds: string[]; slack: unknown[] }): boolean {
  return r.key !== null || r.slack.length > 0 || r.userIds.some((id) => id !== r.ownerId);
}

/**
 * Whether it has OpenDash think, at the questions' cost: a question asked, or working out why first. Viewers read
 * what's shared with them, so their routines send what's there (as everywhere else, they don't ask).
 */
export function asksOpenDash(spec: RoutineSpec): boolean {
  if (spec.trigger === "found") return spec.investigate;
  return spec.action.kind === "ask";
}

/** Why a viewer's routine can't ask, in the composer's and a paused routine's words. */
export const VIEWERS_DONT_ASK =
  "Viewers' routines send what's there: asking a question and working out why are for members.";

/** Why a routine that reaches past its owner doesn't run once they're no longer an owner or admin. */
export const OWNER_CANT_REACH = "Its owner isn't an owner or admin any more, so it can't reach other people.";

/** The first problem a spec has, in words, or null for a valid one. */
export function specProblem(input: unknown): string | null {
  const parsed = RoutineSpec.safeParse(input);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "That routine isn't complete.");
}
