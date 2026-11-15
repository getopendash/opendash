// The routine composer's own pieces: its Slack, a line's history, and where to start from.
// What's picked and the spec it makes are core's (@opendash/core/routines), shared with Describe it's proposals.
import type { ComposerPatch, SlackChannel } from "@opendash/core";
import type { RoutineDraft as Draft, SlackDestination } from "@opendash/core/routines";

export {
  draftOf,
  draftProblem,
  emptyDraft,
  lineText,
  parseLine,
  type Repeats,
  type RoutineDraft as Draft,
  specOf,
} from "@opendash/core/routines";

/** The composer's Slack: none connected, its channels, or why they couldn't be listed. */
export type ComposerSlack =
  | { kind: "off" }
  | { kind: "ready"; teamId: string; teamName: string; channels: SlackChannel[] }
  | { kind: "problem"; message: string };

/**
 * What a line would have done over the periods shown (it tells once on crossing, again only after coming back): how
 * many times it would have told, and the latest period it did. A first period already beyond it is where the series
 * starts, not a crossing.
 */
export function crossings(
  values: number[],
  direction: "below" | "above",
  line: number,
): { times: number; last: number | null } {
  const beyondAt = (v: number) => (direction === "below" ? v < line : v > line);
  let times = 0;
  let last: number | null = null;
  values.forEach((v, i) => {
    const prev = values[i - 1];
    if (i > 0 && prev !== undefined && beyondAt(v) && !beyondAt(prev)) {
      times += 1;
      last = i;
    }
  });
  return { times, last };
}

/** A start the composer offers (Start from): what it fills in. */
export interface Preset {
  id: string;
  title: string;
  detail: string;
  apply: (d: Draft) => Draft;
}

export const PRESETS: Preset[] = [
  {
    id: "digest",
    title: "My weekly digest",
    detail: "Schedule · what was found",
    apply: (d) => ({ ...d, trigger: "schedule", repeats: "week", days: ["mon"], at: "07:00", action: "digest" }),
  },
  {
    id: "ask",
    title: "Ask a question every Monday",
    detail: "Schedule · keeps each answer",
    apply: (d) => ({ ...d, trigger: "schedule", repeats: "week", days: ["mon"], at: "09:00", action: "ask" }),
  },
  {
    id: "unusual",
    title: "Tell me when something is unusual",
    detail: "When found",
    apply: (d) => ({ ...d, trigger: "found", condition: "unusual", tell: "roundup" }),
  },
  {
    id: "line",
    title: "Tell me when a number crosses a line",
    detail: "When found",
    apply: (d) => ({
      ...d,
      trigger: "found",
      condition: "crosses",
      tell: "at_once",
      metricIds: d.metricIds.slice(0, 1),
    }),
  },
];

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Describe it's people and channels, by name, placed against the composer's members and channels: "me" is the person,
 * others by name, channels OpenDash is in. What can't be placed is said, never guessed.
 */
export function placeNames(
  names: { people?: string[]; channels?: string[] },
  ctx: { me: string; members: { userId: string; name: string }[]; slack: ComposerSlack },
): { userIds?: string[]; slack?: SlackDestination[]; unplaced: string[] } {
  const unplaced: string[] = [];
  const out: { userIds?: string[]; slack?: SlackDestination[]; unplaced: string[] } = { unplaced };
  if (names.people) {
    const ids: string[] = [];
    for (const who of names.people) {
      if (norm(who) === "me") {
        ids.push(ctx.me);
        continue;
      }
      // Two people with the same name are never guessed between: it's said, and picked below.
      const named = ctx.members.filter((m) => norm(m.name) === norm(who));
      if (named.length === 1 && named[0]) ids.push(named[0].userId);
      else unplaced.push(named.length > 1 ? `${who} (two people have that name)` : who);
    }
    out.userIds = [...new Set(ids)];
  }
  if (names.channels) {
    const placed: SlackDestination[] = [];
    for (const name of names.channels) {
      const c =
        ctx.slack.kind === "ready"
          ? ctx.slack.channels.find((x) => x.member && norm(x.name) === norm(name.replace(/^#/, "")))
          : undefined;
      if (c && ctx.slack.kind === "ready")
        placed.push({
          teamId: ctx.slack.teamId,
          channelId: c.id,
          name: c.name,
          ...(c.private ? { private: true } : {}),
        });
      else unplaced.push(`#${name.replace(/^#/, "")}`);
    }
    out.slack = placed;
  }
  return out;
}

/** A proposal's or an answer's change to the draft: its picks, and its people and channels placed. */
export function withPatch(
  d: Draft,
  patch: ComposerPatch,
  ctx: Parameters<typeof placeNames>[1],
): { draft: Draft; unplaced: string[] } {
  const { people, channels, ...picks } = patch;
  const placed = placeNames({ ...(people ? { people } : {}), ...(channels ? { channels } : {}) }, ctx);
  return {
    draft: {
      ...d,
      ...picks,
      ...(placed.userIds ? { userIds: placed.userIds } : {}),
      ...(placed.slack ? { slack: placed.slack } : {}),
    },
    unplaced: placed.unplaced,
  };
}

/** A question with one source to ask: that source, whatever path left it unset (an edit, Clear, Describe it). */
export function withOnlySource(d: Draft, sources: { id: string }[]): Draft {
  const only = sources.length === 1 ? sources[0] : undefined;
  return only && !d.connectionId ? { ...d, connectionId: only.id } : d;
}

const WHEN_KEYS: (keyof Draft)[] = [
  "trigger",
  "repeats",
  "days",
  "on",
  "at",
  "metricIds",
  "condition",
  "sensitivity",
  "direction",
  "line",
];
const WHAT_KEYS: (keyof Draft)[] = ["action", "connectionId", "question", "tell", "investigate"];
const WHERE_KEYS: (keyof Draft)[] = ["userIds", "slack"];

/** The sentence's parts a change by hand touches: what Describe it asked about there is settled by it. */
export function partsTouched(patch: Partial<Draft>): ("when" | "what" | "where")[] {
  const keys = Object.keys(patch) as (keyof Draft)[];
  return [
    ...(keys.some((k) => WHEN_KEYS.includes(k)) ? (["when"] as const) : []),
    ...(keys.some((k) => WHAT_KEYS.includes(k)) ? (["what"] as const) : []),
    ...(keys.some((k) => WHERE_KEYS.includes(k)) ? (["where"] as const) : []),
  ];
}
