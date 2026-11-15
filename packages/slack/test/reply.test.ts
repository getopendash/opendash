// A run as a Slack reply: its current step on the status line (never SQL, never past Slack's limit), the answer as
// OpenDash renders it, notifying nobody, cut to Slack's message size; under it, a quiet line of what was checked, the
// way into OpenDash, its follow-ups and 👍/👎 as blocks; a cited query's rows as CSV that a spreadsheet can't mistake
// for formulas.
import { createSlackAdapter } from "@chat-adapter/slack";
import type { RunOutcome } from "@opendash/core";
import { describe, expect, it } from "vitest";
import {
  cardCsv,
  chartAltText,
  csvCell,
  MAX_MESSAGES,
  MEMORY_UNDO,
  pdfAnswer,
  quiet,
  replyBlocks,
  replyText,
  STATUS_LIMIT,
  splitMessage,
  statusAfter,
  stepStatus,
  visibleLinks,
} from "../src";

describe("the status line", () => {
  it("says the latest step for people, never its SQL", () => {
    const events = [
      { seq: 1, type: "attempt_started", data: { attempt: 1 } },
      {
        seq: 2,
        type: "tool_started",
        data: { callId: "c1", tool: "read", input: { path: "/sources/billing/tables/public.subscriptions.md" } },
      },
      { seq: 3, type: "tool_result", data: { callId: "c1", tool: "read", status: "succeeded" } },
      {
        seq: 4,
        type: "tool_started",
        data: { callId: "c2", tool: "sql_query", input: { title: "MRR by month", sql: "select secret" } },
      },
    ];
    expect(statusAfter(events.slice(0, 3))).toBe("Reading the table public.subscriptions…");
    expect(stepStatus("read", { path: "/skills/churn/SKILL.md" })).toBe("Reading a skill…");
    expect(stepStatus("grep", { pattern: "refund" })).toBe("Searching for “refund”…");
    expect(stepStatus("read", { path: "/results/q3" })).toBe("Reading q3's rows again…");
    expect(stepStatus("mcp_find", { query: "jira" })).toBe("Looking for a connected service…");
    expect(stepStatus("mcp_call", { tool: "search_issues" })).toBe("Using “search_issues”…");
    expect(stepStatus("mcp_call", {})).toBe("Using a connected service…");
    expect(statusAfter(events)).toBe("Running “MRR by month”…");
    expect(
      statusAfter([{ seq: 5, type: "tool_result", data: { tool: "sql_query", status: "succeeded", rows: 12 } }]),
    ).toBe("Reading the results…");
    expect(
      statusAfter([{ seq: 6, type: "tool_result", data: { tool: "answer", status: "succeeded", accepted: false } }]),
    ).toBe("Fixing the answer…");
    // A follow-up sent meanwhile, read before the next step.
    expect(statusAfter([...events, { seq: 7, type: "input_joined", data: { messageId: "m" } }])).toBe(
      "Reading your follow-up…",
    );
    expect(statusAfter([{ seq: 7, type: "run_end", data: {} }])).toBeNull();
    expect(JSON.stringify(events.map((e) => statusAfter([e])))).not.toContain("select");
  });

  it("fits Slack's limit, a long name cut and kept on one line", () => {
    const line = stepStatus("sql_query", { title: `Monthly recurring revenue\nby plan and region, ${"x".repeat(80)}` });
    expect([...line].length).toBeLessThanOrEqual(STATUS_LIMIT);
    expect(line).toMatch(/^Running “Monthly recurring revenue by plan.*…”…$/);
    expect(stepStatus("value_lookup", {})).toBe("Looking up a value…");
    expect(stepStatus("metric_query", { metrics: ["mrr"] })).toBe("Asking the metric mrr…");
    expect(stepStatus("something_new")).toBe("Working on it…");
  });
});

describe("the answer as Slack text", () => {
  const url = "https://opendash.test/ask/t-1";
  const answer: RunOutcome = {
    kind: "answer",
    status: "answered",
    verified: true,
    path: "metric",
    markdown: "",
    rendered: "MRR was **$412.6k** in September 2026, up **4.2%**.",
    interpretation: ["Paid accounts", "Sep 2026 vs Aug 2026"],
    caveats: ["September closed on Oct 1."],
    citations: [{ queryRunId: "q-1" }, { queryRunId: "q-1" }, { queryRunId: "q-2" }],
    values: [],
    problems: [],
  };

  it("has the answer, how it read the question, its caveats; under it, that it's verified, and the way to where from", () => {
    expect(replyText({ ...answer, next: ["MRR by plan?", "  "] } as RunOutcome, "succeeded", url)).toEqual({
      messages: [
        [
          "MRR was **$412.6k** in September 2026, up **4.2%**.",
          "_Paid accounts · Sep 2026 vs Aug 2026_",
          "> September closed on Oct 1.",
        ].join("\n\n"),
      ],
      footer: "Verified from definitions an admin approved",
      open: { label: "See where each number comes from", url },
      next: ["MRR by plan?"],
      rate: true,
      cited: ["q-1", "q-2"],
      answered: true,
    });
    const unverified = replyText(
      { ...answer, verified: false, problems: ["A number wasn't traced."] },
      "succeeded",
      url,
    );
    expect(unverified).toMatchObject({
      footer: "Unverified: A number wasn't traced",
      open: { label: "Open in OpenDash", url },
    });
  });

  it("puts under it a quiet line, the way into OpenDash and its follow-ups, and 👍/👎 (Slack's own, or plain ones)", () => {
    const said = replyText({ ...answer, next: ["MRR by plan?"] } as RunOutcome, "succeeded", url);
    const blocks = replyBlocks(said, "run-1");
    expect(blocks).toEqual([
      {
        type: "context",
        elements: [{ type: "plain_text", text: "Verified from definitions an admin approved", emoji: false }],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "opendash:open",
            text: { type: "plain_text", text: "See where each number comes from", emoji: true },
            url,
          },
          {
            type: "button",
            action_id: "opendash:next:0",
            text: { type: "plain_text", text: "MRR by plan?", emoji: true },
            value: JSON.stringify({ r: "run-1", i: 0 }),
          },
        ],
      },
      expect.objectContaining({
        type: "context_actions",
        elements: [
          expect.objectContaining({
            type: "feedback_buttons",
            action_id: "opendash:feedback",
            positive_button: expect.objectContaining({ value: "up:run-1" }),
            negative_button: expect.objectContaining({ value: "down:run-1" }),
          }),
        ],
      }),
    ]);
    // Where Slack refuses its own feedback buttons: plain ones, with the same values.
    const plain = replyBlocks(said, "run-1", "plain").at(-1) as { elements: { action_id: string; value: string }[] };
    expect(plain.elements.map((e) => [e.action_id, e.value])).toEqual([
      ["opendash:rate:up", "up:run-1"],
      ["opendash:rate:down", "down:run-1"],
    ]);
    // A long follow-up fits Slack's button, and is said in full above the buttons, since the press asks all of it;
    // a question back has no rating.
    const long = replyBlocks({ ...said, next: ["x".repeat(100)] }, "run-1");
    expect(JSON.stringify(long)).toContain(`${"x".repeat(74)}…`);
    expect(JSON.stringify(long)).toContain(`Ask next:\\n1. ${"x".repeat(100)}`);
    expect(JSON.stringify(replyBlocks(said, "run-1"))).not.toContain("Ask next:");
    const asked = replyText({ kind: "clarify", question: "Which?", options: ["A", "B"] }, "succeeded", url);
    expect(replyBlocks(asked, "run-2").map((b) => b.type)).toEqual(["actions"]);
  });

  it("is just its text when it has no numbers, as a reply to a greeting", () => {
    const hello: RunOutcome = {
      ...answer,
      path: "unmodelled",
      rendered: "Hi! I'm the OpenDash analyst for your warehouse. What would you like to know?",
      interpretation: ["Greeting only, no data question asked yet"],
      caveats: [],
      citations: [],
      values: [],
    };
    expect(replyText(hello, "succeeded", url)).toEqual({
      messages: ["Hi! I'm the OpenDash analyst for your warehouse. What would you like to know?"],
      footer: null,
      open: { label: "Open in OpenDash", url },
      next: [],
      rate: true,
      cited: [],
      answered: true,
    });
    // Nor is it drawn as a PDF.
    expect(pdfAnswer(hello)).toBeNull();
    // One that didn't pass its checks still says so, even citing nothing.
    const unchecked = replyText(
      { ...hello, verified: false, problems: ["A number in the text isn't from a query."] },
      "succeeded",
      url,
    );
    expect(unchecked.footer).toBe("Unverified: A number in the text isn't from a query");
  });

  it("draws a PDF only of an answer that answered, with numbers in it", () => {
    expect(pdfAnswer(answer)).toBe(answer);
    const quoted = { ...answer, citations: [], values: [{ ref: "q-1:0:0" }] } as RunOutcome;
    expect(pdfAnswer(quoted)).toBe(quoted);
    expect(pdfAnswer({ ...answer, status: "cannot_answer" } as RunOutcome)).toBeNull();
    expect(pdfAnswer({ kind: "clarify", question: "Which revenue?", options: [] })).toBeNull();
    expect(pdfAnswer({ kind: "no_answer", reason: "It stopped." })).toBeNull();
    expect(pdfAnswer(null)).toBeNull();
  });

  it("asks its questions back, one or several (and a run's from before), and says a stopped or failed run", () => {
    const one = { question: "Which revenue?", options: ["MRR", "Bookings"] };
    // A run from before several questions reads as one.
    for (const outcome of [
      { kind: "clarify" as const, ...one },
      { kind: "clarify" as const, questions: [one] },
    ]) {
      expect(replyText(outcome, "succeeded", url)).toEqual({
        messages: ["Which revenue?"],
        footer: null,
        open: { label: "Open in OpenDash", url },
        next: [],
        rate: false,
        questions: [one],
        cited: [],
        answered: true,
      });
    }
    const two = [one, { question: "Which window?", options: ["Last year", "This year"], multiple: true }];
    expect(replyText({ kind: "clarify", questions: two }, "succeeded", url)).toMatchObject({
      messages: ["A few questions before I answer:"],
      questions: two,
    });
    expect(replyText(null, "cancelled", url)).toMatchObject({ messages: ["Stopped."], answered: false });
    expect(replyText(null, "failed", url).messages).toEqual(["Something went wrong answering this. Ask again."]);
  });

  it("shows where an answer's own links go, so none hides an address behind its text", () => {
    expect(
      visibleLinks(
        "See [the report](https://elsewhere.test/?q=secret), [https://a.test](https://a.test/), " +
          "<https://b.test/x|click> and ![chart](https://c.test/c.png). Plain https://d.test stays.",
      ),
    ).toBe(
      "See the report (https://elsewhere.test/?q=secret), https://a.test, click (https://b.test/x) and " +
        "chart (https://c.test/c.png). Plain https://d.test stays.",
    );
    // In the reply: the answer's link in sight, the footer's own link as it is.
    const [message] = replyText(
      { kind: "no_answer", reason: "See [details](https://elsewhere.test/?q=1)." },
      "succeeded",
      url,
    ).messages;
    expect(message).toContain("details (https://elsewhere.test/?q=1)");
  });

  it("notifies nobody, whatever the data says, as the Slack adapter itself would post it", () => {
    // Code used to be left alone, but what counts as code differs between parsers.
    const loud = [
      "Top account: <!channel> Acme <@U123|priya> <!subteam^S9|@finance> in <#C1|general>, cc @here and @U0BOT.",
      "Escaped: \\`<!channel>\\` and `<!here>` and ``<!everyone>``.",
      "```\n<!here> @U0BOT\n```",
      "Encoded: &lt;!channel&gt; &#60;!here&gt; &#x3c;@U0BOT&gt;. Write to ops@acme.test.",
    ].join("\n\n");
    const said = quiet(loud);
    // What the adapter sends Slack for it (markdown_text, after it links bare @names as mentions).
    const slack = createSlackAdapter({ botToken: "xoxb-test", signingSecret: "test" }) as unknown as {
      formatConverter: { toSlackPayload(m: { markdown: string }): { markdown_text?: string } };
    };
    const posted = slack.formatConverter.toSlackPayload({ markdown: said }).markdown_text ?? "";
    expect(posted).not.toMatch(/<[!@#]/);
    for (const entity of ["&lt;!", "&#60;!", "&#x3c;@"]) expect(posted).not.toContain(entity);
    // Read without the invisible joiners, it says what it said.
    expect(said.replaceAll("\u2060", "")).toContain("Top account: @channel Acme @priya @finance in #general, cc @here");
    expect(said.replaceAll("\u2060", "")).toContain("ops@acme.test");
    const reply = replyText({ ...answer, rendered: "Ask <!here> about it, @channel." }, "succeeded", url);
    expect(reply.messages.join("")).not.toMatch(/<!|@\w/);
  });

  it("is cut to Slack's size at paragraphs, and an answer too long for Slack ends with the link to the rest", () => {
    const paragraph = `${"word ".repeat(399)}word`;
    const parts = splitMessage(Array.from({ length: 12 }, () => paragraph).join("\n\n"), 5_000);
    expect(parts.every((p) => p.length <= 5_000)).toBe(true);
    expect(parts.join("\n\n")).toBe(Array.from({ length: 12 }, () => paragraph).join("\n\n"));
    expect(splitMessage("🙂".repeat(6), 5).every((p) => !/[\uD800-\uDBFF]$/.test(p))).toBe(true);
    const long = replyText(
      { ...answer, rendered: Array.from({ length: 40 }, () => "x".repeat(3_000)).join("\n\n") },
      "succeeded",
      url,
    );
    expect(long.messages).toHaveLength(MAX_MESSAGES);
    expect(long.messages.at(-1)).toContain(`_(The rest is in OpenDash: [read it all](${url}).)_`);
    expect(long.open.label).toBe("See where each number comes from");
  });
});

describe("a cited query's rows as CSV", () => {
  it("quotes what needs quoting and defuses what looks like a formula", () => {
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell("-5")).toBe("-5");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(null)).toBe("");
  });

  it("is the card's rows, and a cut one says so in its name", () => {
    const card = {
      title: "MRR by month",
      alias: "q1",
      columns: [
        { name: "month", type: "date" },
        { name: "mrr", type: "number" },
      ],
      preview: [
        ["2026-08-01", "396000.00"],
        ["2026-09-01", "412600.00"],
      ],
      rows: 2,
      truncated: false,
    };
    const whole = cardCsv(card);
    expect(whole.filename).toBe("mrr-by-month.csv");
    expect(whole.data.toString("utf8")).toBe("month,mrr\r\n2026-08-01,396000.00\r\n2026-09-01,412600.00\r\n");
    expect(cardCsv({ ...card, rows: 1240, truncated: true }).filename).toBe("mrr-by-month-first-2-of-1240-rows.csv");
  });
});

describe("a chart's image in Slack", () => {
  it("is described by its title and each series' values, as the chart shows them, within Slack's limit", () => {
    const point = (display: string) => ({
      value: 0,
      display,
      cell: { alias: "q1", queryRunId: "q", row: 0, column: "c" },
    });
    expect(
      chartAltText({
        title: "MRR by plan",
        categories: ["Starter", "Growth"],
        series: [
          { name: "August", points: [point("$41.0k"), point("$88.4k")] },
          { name: "September", points: [point("$41.1k"), null] },
        ],
      }),
    ).toBe("MRR by plan. August: Starter $41.0k, Growth $88.4k; September: Starter $41.1k, Growth —.");
    const many = chartAltText({
      title: "Daily users",
      categories: Array.from({ length: 400 }, (_, i) => `Day ${i}`),
      series: [{ name: "Users", points: Array.from({ length: 400 }, () => point("1,234")) }],
    });
    expect(many.length).toBeLessThanOrEqual(1_000);
    expect(many.endsWith("…")).toBe(true);
  });
});

describe("what an answer remembered, in Slack", () => {
  const said = replyText(null, "succeeded", "https://opendash.example/ask/t1");
  it("says it under the answer with Undo: for you in a DM, for its asker in a channel", () => {
    const memory = {
      id: "0198f1b0-0000-7000-8000-000000000001",
      fact: "Paying accounts means the active subscriptions",
    };
    const [dm] = replyBlocks(said, "run-1", "native", [memory], true) as {
      text: { text: string };
      accessory: { action_id: string; value: string };
    }[];
    expect(dm?.text.text).toBe("Remembered for you: “Paying accounts means the active subscriptions”");
    expect(dm?.accessory.action_id).toBe(MEMORY_UNDO);
    expect(JSON.parse(dm?.accessory.value ?? "{}")).toEqual({ m: memory.id });
    const [channel] = replyBlocks(said, "run-1", "native", [memory], false) as { text: { text: string } }[];
    expect(channel?.text.text).toBe("Remembered for its asker: “Paying accounts means the active subscriptions”");
    // Nothing remembered: nothing said.
    expect(replyBlocks(said, "run-1").some((b) => b.type === "section")).toBe(false);
    // A correction can be shared with the team's learning; a preference can't.
    const shared = replyBlocks(said, "run-1", "native", [{ ...memory, why: "correction" }], true);
    expect(JSON.stringify(shared)).toContain('"action_id":"opendash:learning:suggest"');
    const kept = replyBlocks(said, "run-1", "native", [{ ...memory, why: "preference" }], true);
    expect(JSON.stringify(kept)).not.toContain("opendash:learning:suggest");
  });
});
