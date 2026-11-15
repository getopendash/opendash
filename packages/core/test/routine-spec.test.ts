// A routine's spec, its sentence, and which routines tell which findings. Pure: no database.
import { uuidv7 } from "@opendash/db";
import { describe, expect, it } from "vitest";
import { crossed, lineKey } from "../src/checks/crossing";
import { routineSentence, ruleWords, sentenceText } from "../src/routines/sentence";
import { type FoundSpec, needsManager, RoutineSpec, specProblem } from "../src/routines/spec";
import { audienceKey, type Filed, filingK, tellsAbout, type WatchingRoutine } from "../src/routines/tell";

const mrr = uuidv7();
const signups = uuidv7();
const conn = uuidv7();

const weekly: RoutineSpec = {
  version: 1,
  trigger: "schedule",
  rule: { every: "week", days: ["mon"], at: "08:00" },
  action: { kind: "ask", connectionId: conn, question: "How did sign-ups do?" },
};

const found = (condition: FoundSpec["condition"], extra: Partial<FoundSpec> = {}): FoundSpec => ({
  version: 1,
  trigger: "found",
  metricIds: [mrr],
  condition,
  tell: "at_once",
  investigate: false,
  ...extra,
});

describe("the spec", () => {
  it("takes the routines people make", () => {
    expect(specProblem(weekly)).toBeNull();
    expect(specProblem({ ...weekly, action: { kind: "digest" } })).toBeNull();
    expect(specProblem(found({ kind: "unusual", sensitivity: "higher" }))).toBeNull();
    expect(specProblem(found({ kind: "crosses", direction: "below", value: 400_000 }))).toBeNull();
  });

  it("says what's wrong, in words", () => {
    expect(specProblem({ ...weekly, rule: { every: "week", days: [], at: "08:00" } })).toBe("Pick at least one day.");
    expect(specProblem({ ...weekly, rule: { every: "day", at: "25:00" } })).toMatch(/HH:MM/);
    expect(specProblem(found({ kind: "crosses", direction: "above", value: 1 }, { metricIds: [mrr, signups] }))).toBe(
      "A line is drawn on one metric.",
    );
    expect(specProblem(found({ kind: "unusual", sensitivity: "medium" }, { metricIds: [] }))).toBe(
      "Pick at least one metric.",
    );
    expect(specProblem({ ...weekly, version: 2 })).not.toBeNull();
    // Only its own keys: an inherited name isn't a sensitivity.
    expect(RoutineSpec.safeParse(found({ kind: "unusual", sensitivity: "__proto__" as "medium" })).success).toBe(false);
  });

  it("needs an owner or admin for anything that reaches past its owner", () => {
    const me = uuidv7();
    expect(needsManager({ key: null, ownerId: me, userIds: [me], slack: [] })).toBe(false);
    expect(needsManager({ key: null, ownerId: me, userIds: [me, uuidv7()], slack: [] })).toBe(true);
    expect(needsManager({ key: null, ownerId: me, userIds: [], slack: [{}] })).toBe(true);
    expect(needsManager({ key: "watching", ownerId: me, userIds: [], slack: [] })).toBe(true);
  });
});

describe("the sentence", () => {
  const people = [{ name: "Priya", isViewer: false }];
  it("reads as one sentence, its parts marked", () => {
    const parts = routineSentence(weekly, { people, channels: ["#leadership"] });
    expect(sentenceText(parts)).toBe(
      "Every Monday at 08:00, ask “How did sign-ups do?” and send the answer to Priya and #leadership.",
    );
    expect(parts.filter((p) => p.role).map((p) => p.role)).toEqual(["when", "what", "where"]);
    expect(
      sentenceText(
        routineSentence(found({ kind: "crosses", direction: "below", value: 400_000 }, { investigate: true }), {
          metrics: ["MRR"],
          line: "$400k",
          people: [{ name: "Sam", isViewer: true }],
          channels: [],
        }),
      ),
    ).toBe("When MRR falls below $400k, investigate, then tell me at once.");
    expect(
      sentenceText(
        routineSentence(
          found({ kind: "unusual", sensitivity: "medium" }, { metricIds: [mrr, signups], tell: "roundup" }),
          {
            metrics: ["MRR", "Sign-ups"],
            people,
            channels: [],
          },
        ),
      ),
    ).toBe("When MRR or Sign-ups is unusual, tell Priya in the day's roundup.");
    expect(
      sentenceText(
        routineSentence(found({ kind: "unusual", sensitivity: "medium" }), {
          metrics: ["MRR"],
          people: [],
          channels: [],
        }),
      ),
    ).toBe("When MRR is unusual, keep it in Insights.");
  });

  it("names its days the way people do", () => {
    expect(ruleWords({ every: "week", days: ["fri", "mon", "tue", "wed", "thu"], at: "09:00" })).toBe(
      "Every weekday at 09:00",
    );
    expect(ruleWords({ every: "week", days: ["thu", "mon"], at: "09:00" })).toBe("Every Monday and Thursday at 09:00");
    expect(ruleWords({ every: "month", on: "last", at: "18:00" })).toBe("On the last day of each month at 18:00");
  });
});

describe("a line crossed", () => {
  const pts = (values: number[], from = "2026-07-06") =>
    values.map((value, row) => ({
      period: new Date(Date.parse(`${from}T00:00:00Z`) + row * 7 * 86_400_000).toISOString().slice(0, 10),
      value,
      row,
    }));

  it("is the run beyond the line that ends at the latest period, keyed where it began", () => {
    const line = { direction: "below" as const, value: 50 };
    expect(crossed(pts([60, 55, 48, 45]), line, "week")).toMatchObject({ since: "2026-07-20", periods: 2 });
    expect(crossed(pts([60, 55, 48, 52]), line, "week")).toBeNull();
    // Back over the line and below again: a new run, so a new finding (and a new key).
    expect(crossed(pts([40, 60, 45]), line, "week")).toMatchObject({ since: "2026-07-20", periods: 1 });
    expect(lineKey(mrr, line)).toBe(`threshold:${mrr}:below:50:`);
  });
});

describe("who tells what", () => {
  const routine = (spec: FoundSpec, extra: Partial<WatchingRoutine> = {}): WatchingRoutine => ({
    id: uuidv7(),
    spec,
    userIds: [uuidv7()],
    slack: [],
    connectionIds: [conn],
    ownerViewer: false,
    privateTo: null,
    ...extra,
  });
  // 2.5 spreads from its centre: unusual at Higher (k 2), not at Medium (3) or Lower (4).
  const anomaly: Filed = {
    id: uuidv7(),
    kind: "anomaly",
    metricId: mrr,
    connectionId: conn,
    band: { value: 125, expected: 100, spread: 10 },
  };

  it("judges an unusual value at each routine's own sensitivity", () => {
    const f = anomaly;
    expect(tellsAbout(routine(found({ kind: "unusual", sensitivity: "higher" })), f)).toBe(true);
    expect(tellsAbout(routine(found({ kind: "unusual", sensitivity: "medium" })), f)).toBe(false);
    expect(tellsAbout(routine(found({ kind: "unusual", sensitivity: "lower" })), f)).toBe(false);
    // The check files at the most sensitive routine's k (Medium when nobody asks).
    expect(
      filingK([
        routine(found({ kind: "unusual", sensitivity: "lower" })),
        routine(found({ kind: "unusual", sensitivity: "higher" })),
      ]),
    ).toBe(2);
    expect(filingK([])).toBe(3);
  });

  it("tells a finding only to routines that watch its metric, ask for its kind, and reach someone", () => {
    const line = { direction: "below" as const, value: 400_000 };
    const crossing: Filed = { id: uuidv7(), kind: "threshold", metricId: mrr, connectionId: conn, line };
    expect(tellsAbout(routine(found({ kind: "crosses", ...line })), crossing)).toBe(true);
    expect(tellsAbout(routine(found({ kind: "crosses", direction: "below", value: 300_000 })), crossing)).toBe(false);
    expect(tellsAbout(routine(found({ kind: "crosses", ...line }, { metricIds: [signups] })), crossing)).toBe(false);
    expect(tellsAbout(routine(found({ kind: "unusual", sensitivity: "higher" })), crossing)).toBe(false);
    // Watching keeps it in Insights: it tells nobody.
    expect(tellsAbout(routine(found({ kind: "crosses", ...line }), { userIds: [] }), crossing)).toBe(false);
    const late: Filed = { id: uuidv7(), kind: "data_quality", metricId: null, connectionId: conn };
    expect(tellsAbout(routine(found({ kind: "missing" }, { metricIds: [signups] })), late)).toBe(true);
    expect(tellsAbout(routine(found({ kind: "missing" }), { connectionIds: [uuidv7()] }), late)).toBe(false);
    const trend: Filed = { id: uuidv7(), kind: "trend", metricId: mrr, connectionId: conn };
    expect(tellsAbout(routine(found({ kind: "unusual", sensitivity: "lower" })), trend)).toBe(true);
  });

  it("tells a person's own finding only through their own private routines", () => {
    const maya = uuidv7();
    const line = { direction: "below" as const, value: 400_000 };
    const hers: Filed = { id: uuidv7(), kind: "threshold", metricId: mrr, connectionId: conn, line, ownerId: maya };
    const watches = found({ kind: "crosses", ...line });
    expect(tellsAbout(routine(watches, { privateTo: maya }), hers)).toBe(true);
    expect(tellsAbout(routine(watches, { privateTo: uuidv7() }), hers)).toBe(false);
    // A routine that reaches the team never tells it: the line is hers.
    expect(tellsAbout(routine(watches), hers)).toBe(false);
    // The workspace's own findings are told to private routines as to any.
    expect(tellsAbout(routine(watches, { privateTo: maya }), { ...hers, ownerId: null })).toBe(true);
    expect(audienceKey(maya, "threshold:m:below:5:")).toBe(`private:${maya}:threshold:m:below:5:`);
    expect(audienceKey(null, "threshold:m:below:5:")).toBe("threshold:m:below:5:");
  });
});
