// Routines in words and the composer's draft: what a check and a run did, what happens each time, a line
// as typed, and a spec read back into the form.
import { describe, expect, it } from "vitest";
import {
  type ComposerSlack,
  crossings,
  draftOf,
  emptyDraft,
  lineText,
  parseLine,
  placeNames,
  specOf,
  withPatch,
} from "../lib/routine-draft";
import { checkLine, runLine, whatHappens, whenLine } from "../lib/routine-words";

const ME = "0190a000-0000-7000-8000-000000000001";
const SOURCE = "0190a000-0000-7000-8000-0000000000c1";
const MRR = "0190a000-0000-7000-8000-0000000000a1";

describe("routine words", () => {
  it("says when, where the workspace is", () => {
    expect(whenLine("2026-10-19T05:00:00.000Z", "Europe/Berlin")).toBe("Mon Oct 19, 07:00");
  });

  it("says what a check did", () => {
    const at = "2026-10-12T06:00:00.000Z";
    expect(checkLine({ grain: "month", state: {} }, "UTC")).toEqual({
      text: "First check within a minute",
      problem: false,
    });
    expect(
      checkLine({ grain: "week", state: { lastRunAt: at, lastStatus: "ok", lastPeriod: "2026-10-05" } }, "UTC").text,
    ).toBe("Mon Oct 12, 06:00 · the week of Oct 5 judged");
    expect(
      checkLine({ grain: "month", state: { lastRunAt: at, lastStatus: "waiting", lastPeriod: "2026-09-01" } }, "UTC")
        .text,
    ).toBe("Mon Oct 12, 06:00 · waiting for September 2026");
    expect(
      checkLine(
        { grain: "month", state: { lastRunAt: at, lastStatus: "error", lastError: "Its source is off." } },
        "UTC",
      ),
    ).toEqual({ text: "Mon Oct 12, 06:00 · couldn't check: Its source is off.", problem: true });
    expect(checkLine({ grain: null, state: {} }, "UTC").problem).toBe(true);
  });

  it("says what a run did", () => {
    const base = { error: null, answer: null };
    const answer = { threadId: "t", runId: "r" };
    expect(runLine({ ...base, triggerKey: "at:2026-10-19", status: "delivered", answer })).toEqual({
      text: "Answered and sent",
      tone: "ok",
    });
    expect(
      runLine({
        ...base,
        triggerKey: "found:i",
        status: "delivered",
        insights: [{ id: "i", title: "MRR fell below $400k" }],
      }).text,
    ).toBe("Told: MRR fell below $400k");
    expect(runLine({ ...base, triggerKey: "roundup:2026-10-19", status: "waiting" }).text).toBe("Waiting for 07:00");
    expect(runLine({ ...base, triggerKey: "at:x", status: "failed", error: "No one to send it to." })).toEqual({
      text: "Failed: No one to send it to.",
      tone: "bad",
    });
  });

  it("says what happens each time, and whether it keeps anything", () => {
    const names = {
      metrics: [],
      line: null,
      source: "Warehouse",
      where: "me and Ines",
      team: true,
      first: null,
    };
    const asked = whatHappens(
      {
        version: 1,
        trigger: "schedule",
        rule: { every: "week", days: ["mon"], at: "07:00" },
        action: { kind: "ask", connectionId: SOURCE, question: "How did MRR move last week?" },
      },
      names,
    );
    expect(asked.items[0]).toBe(
      "Every Monday at 07:00, the analyst answers “How did MRR move last week?” from Warehouse, checked like any answer.",
    );
    expect(asked.keeps.kept).toBe(true);
    expect(asked.who).toMatch(/^A team routine/);
    const line = whatHappens(
      {
        version: 1,
        trigger: "found",
        metricIds: [MRR],
        condition: { kind: "crosses", direction: "below", value: 400_000 },
        tell: "at_once",
        investigate: false,
      },
      { ...names, metrics: [{ title: "MRR", others: 2, grain: "week" }], line: "$400k", team: false },
    );
    expect(line.items).toContain("If MRR is below $400k, it tells me and Ines at once.");
    expect(line.items).toContain("It tells once, and again only after MRR has come back above $400k.");
    expect(line.items[0]).toMatch(/MRR is watched by other routines too/);
    expect(line.keeps.kept).toBe(false);
    expect(line.who).toBe("Only you get it.");
  });
});

describe("the composer's draft", () => {
  it("reads a line as typed, in the metric's units", () => {
    expect(parseLine("400k", "usd")).toBe(400_000);
    expect(parseLine("$1.2m", "usd")).toBe(1_200_000);
    expect(parseLine("1,250", "number")).toBe(1250);
    expect(parseLine("38%", "percent")).toBe(0.38);
    expect(parseLine("38", "percent")).toBe(0.38);
    expect(parseLine("0.4", "percent")).toBe(0.4);
    expect(parseLine("38%", "number")).toBeNull();
    expect(parseLine("lots", "usd")).toBeNull();
    expect(lineText(400_000, "usd")).toBe("400k");
    expect(lineText(0.38, "percent")).toBe("38%");
  });

  it("counts how often a line would have told: once a crossing, again only after coming back", () => {
    expect(crossings([410, 405, 395, 390, 402, 398], "below", 400)).toEqual({ times: 2, last: 5 });
    expect(crossings([410, 420], "below", 400)).toEqual({ times: 0, last: null });
    // A series that starts below the line didn't cross it then.
    expect(crossings([200, 300, 412], "below", 400)).toEqual({ times: 0, last: null });
  });

  it("makes the spec the store checks, and reads a saved one back", () => {
    const d = {
      ...emptyDraft(ME),
      trigger: "schedule" as const,
      repeats: "weekday" as const,
      at: "09:00",
      action: "ask" as const,
      connectionId: SOURCE,
      question: "How many accounts signed up?",
    };
    const spec = specOf(d, null);
    expect(spec).toEqual({
      version: 1,
      trigger: "schedule",
      rule: { every: "week", days: ["mon", "tue", "wed", "thu", "fri"], at: "09:00" },
      action: { kind: "ask", connectionId: SOURCE, question: "How many accounts signed up?" },
    });
    expect(draftOf(spec as never, [ME], ME, null)).toMatchObject({
      repeats: "weekday",
      connectionId: SOURCE,
      at: "09:00",
    });
    const found = {
      ...emptyDraft(ME),
      trigger: "found" as const,
      metricIds: [MRR],
      condition: "crosses" as const,
      line: "$400k",
    };
    const fspec = specOf(found, "usd");
    expect(fspec).toMatchObject({ condition: { kind: "crosses", direction: "below", value: 400_000 } });
    expect(draftOf(fspec as never, [ME], ME, "usd")).toMatchObject({ condition: "crosses", line: "400k" });
  });
});

describe("Describe it's names, placed", () => {
  const INES = "0190a000-0000-7000-8000-000000000002";
  const slack: ComposerSlack = {
    kind: "ready",
    teamId: "T0ACME",
    teamName: "Acme",
    channels: [
      { id: "C0GROWTH01", name: "growth", private: false, member: true },
      { id: "C0QUIET001", name: "quiet", private: false, member: false },
    ],
  };
  const ctx = { me: ME, members: [{ userId: INES, name: "Ines Ruiz" }], slack };

  it("places me, people by name and channels OpenDash is in; says what it can't, never guesses", () => {
    expect(placeNames({ people: ["me", "ines ruiz", "Priya"], channels: ["#growth", "quiet", "#gone"] }, ctx)).toEqual({
      userIds: [ME, INES],
      slack: [{ teamId: "T0ACME", channelId: "C0GROWTH01", name: "growth" }],
      unplaced: ["Priya", "#quiet", "#gone"],
    });
    // No Slack connected: a channel can't be placed.
    expect(placeNames({ channels: ["growth"] }, { ...ctx, slack: { kind: "off" } }).unplaced).toEqual(["#growth"]);
    // Two people with one name: neither is guessed.
    const twins = { ...ctx, members: [...ctx.members, { userId: ME, name: "Ines Ruiz" }] };
    expect(placeNames({ people: ["Ines Ruiz"] }, twins)).toEqual({
      userIds: [],
      unplaced: ["Ines Ruiz (two people have that name)"],
    });
  });

  it("an answer's choice sets its picks, and its people or channels in place of the draft's", () => {
    const d = { ...emptyDraft(ME), trigger: "found" as const, userIds: [ME] };
    const { draft, unplaced } = withPatch(d, { condition: "crosses", direction: "below", people: ["Ines Ruiz"] }, ctx);
    expect(draft).toMatchObject({ condition: "crosses", direction: "below", userIds: [INES], slack: [] });
    expect(unplaced).toEqual([]);
    // A choice that names nobody leaves who it goes to as it was.
    expect(withPatch(d, { metricIds: [MRR] }, ctx).draft).toMatchObject({ metricIds: [MRR], userIds: [ME] });
  });
});
