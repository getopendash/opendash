import { describe, expect, it } from "vitest";
import { findingChoice, ROUTINE_FINDING, routineBlocks } from "../src";

const base = { organization: "Acme", baseUrl: "https://app.opendash.example/" };
const footer = {
  because: "Every Monday at 07:00, ask which plans grew and send it to #growth.",
  routineUrl: "https://app.opendash.example/routines/r1",
};
const json = (v: unknown) => JSON.stringify(v);

describe("a routine's post", () => {
  it("is an answer, with its conversation", () => {
    const answer = routineBlocks({
      ...footer,
      kind: "answer",
      answer: {
        ...base,
        threadId: "t2",
        runId: "r2",
        question: "Which plans grew this week?",
        sourceName: "Warehouse",
        answeredAt: "2026-10-19T07:00:00.000Z",
        answer: "Pro grew most.",
        verified: false,
      },
    });
    expect(answer.blocks[0]).toMatchObject({ type: "header", text: { text: "Which plans grew this week?" } });
    expect(json(answer.blocks)).toContain("some of it couldn't be checked");
    expect(json(answer.blocks)).toContain('"url":"https://app.opendash.example/ask/t2"');
    expect(json(answer.blocks)).toContain(`<${footer.routineUrl}|${footer.because}>`);
  });

  it("is what was found, each finding with its menu: Investigate, or Dismiss with why", () => {
    const findings = Array.from({ length: 12 }, (_, i) => ({
      id: `i${i}`,
      title: `Finding ${i}`,
      detail: "$396.2k · the line is $400k",
      ...(i === 0 ? { verdict: "Its investigation confirmed it." } : {}),
    }));
    const { text, blocks } = routineBlocks({
      ...footer,
      kind: "findings",
      findings: { ...base, roundup: false, findings: findings.slice(0, 1) },
    });
    expect(text).toBe("Finding 0: $396.2k · the line is $400k");
    const menu = (blocks[1] as { accessory: { action_id: string; options: { value: string }[] } }).accessory;
    expect(menu.action_id).toBe(ROUTINE_FINDING);
    expect(menu.options.map((o) => JSON.parse(o.value))).toEqual([
      { a: "investigate", i: "i0" },
      { a: "dismiss", i: "i0", r: "not_a_problem" },
      { a: "dismiss", i: "i0", r: "known_issue" },
      { a: "dismiss", i: "i0", r: "wrong_data" },
      { a: "dismiss", i: "i0", r: "not_my_area" },
    ]);
    expect(json(blocks)).toContain("_Its investigation confirmed it._");
    // The day's roundup: ten at most, the rest counted.
    const roundup = routineBlocks({ ...footer, kind: "findings", findings: { ...base, roundup: true, findings } });
    expect(roundup.text).toBe("12 findings at Acme today");
    expect(roundup.blocks.filter((b) => (b as { accessory?: unknown }).accessory)).toHaveLength(10);
    expect(json(roundup.blocks)).toContain("2 more in Insights.");
  });

  it("escapes its text as its blocks are: a name that looks like a mention mentions nobody", () => {
    const { text, blocks } = routineBlocks({
      ...footer,
      kind: "findings",
      findings: {
        ...base,
        roundup: false,
        findings: [{ id: "i1", title: "<!channel> MRR & churn", detail: "<@U0BOSS> 12, @here and #growth" }],
      },
    });
    expect(text).toBe("&lt;!channel&gt; MRR &amp; churn: &lt;@U0BOSS&gt; 12, @\u2060here and #growth");
    expect(json(blocks)).not.toContain("<!channel>");
    expect(json(blocks)).not.toContain("<@U0BOSS>");
    expect(json(blocks)).not.toMatch(/@here/);
    // An address keeps its @: copied out of Slack, it still works.
    const address = routineBlocks({
      ...footer,
      kind: "findings",
      findings: {
        ...base,
        roundup: false,
        findings: [{ id: "i2", title: "Bounces", detail: "ops@channel.example, @everyone" }],
      },
    });
    expect(address.text).toBe("Bounces: ops@channel.example, @\u2060everyone");
    // Slack parses no mention or channel name in what a block says.
    const texts = JSON.stringify(blocks).match(/"type":"mrkdwn"[^}]*/g) ?? [];
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.every((t) => t.includes('"verbatim":true'))).toBe(true);
  });

  it("keeps a header within Slack's 150 characters", () => {
    const long = "A question that runs on and on ".repeat(10);
    const { blocks } = routineBlocks({
      ...footer,
      kind: "answer",
      answer: {
        ...base,
        threadId: "t3",
        runId: "r3",
        question: long,
        sourceName: "W",
        answeredAt: "2026-10-19T07:00:00Z",
        answer: "x",
        verified: true,
      },
    });
    expect((blocks[0] as { text: { text: string } }).text.text.length).toBe(150);
  });
});

describe("a finding's menu choice", () => {
  it("is read back only when it's one of the menu's", () => {
    expect(findingChoice(json({ a: "investigate", i: "i0" }))).toEqual({ action: "investigate", insightId: "i0" });
    expect(findingChoice(json({ a: "dismiss", i: "i0", r: "wrong_data" }))).toEqual({
      action: "dismiss",
      insightId: "i0",
      reason: "wrong_data",
    });
    expect(findingChoice(json({ a: "dismiss", i: "i0", r: "because" }))).toBeNull();
    expect(findingChoice(json({ a: "delete", i: "i0" }))).toBeNull();
    expect(findingChoice("not json")).toBeNull();
  });
});
