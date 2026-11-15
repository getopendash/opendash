// The answer gate on its own: references resolve and render, derived values and claims are recomputed, typed numbers
// are caught (with the exemptions the gate lists), and the headline needs an agreeing cross-check.
import { describe, expect, it } from "vitest";
import { formatNumber, parseFormat } from "../src/answer/format";
import { type AnswerInput, checkAnswer, type GateContext, repairClosers, typedNumbers } from "../src/answer/gate";

const ctx: GateContext = {
  question: "How did MRR change last month?",
  rowsShown: 50,
  results: [
    {
      alias: "q1",
      queryRunId: "run-1",
      columns: [
        { name: "month", type: "timestamp" },
        { name: "mrr", type: "number" },
      ],
      rows: [
        ["2026-09-01T00:00:00.000Z", "412600.00"],
        ["2026-08-01T00:00:00.000Z", "395969.29"],
      ],
    },
    {
      alias: "q2",
      queryRunId: "run-2",
      columns: [{ name: "mrr", type: "number" }],
      rows: [[412600.0]],
    },
    {
      alias: "q3",
      queryRunId: "run-3",
      columns: [
        { name: "plan", type: "text" },
        { name: "churned_mrr", type: "number" },
      ],
      rows: [
        ["Starter", 4100],
        ["Growth", 3600],
        ["Scale", 2100],
      ],
    },
  ],
};

const answer = (markdown: string, extra: Partial<AnswerInput> = {}): AnswerInput => ({
  status: "answered",
  markdown,
  interpretation: ["Last month = September 2026"],
  caveats: [],
  cross_checks: [{ headline: "q1:0:mrr", check: "q2:0:mrr" }],
  ...extra,
});

describe("formats", () => {
  it("formats currency, compact, percent and signed values", () => {
    const f = (spec: string) => {
      const p = parseFormat(spec);
      if (!p.ok) throw new Error(p.message);
      return p.format;
    };
    expect(formatNumber(412600, f("currency:USD,compact"))).toBe("$412.6k");
    expect(formatNumber(9800, f("currency:USD,compact"))).toBe("$9.8k");
    expect(formatNumber(1250000, f("currency:EUR,compact"))).toBe("€1.3M");
    expect(formatNumber(412600, f("currency:USD"))).toBe("$412,600.00");
    expect(formatNumber(0.042, f("percent,signed"))).toBe("+4.2%");
    expect(formatNumber(1234, f(""))).toBe("1,234");
    expect(parseFormat("dollars").ok).toBe(false);
  });
});

describe("segments, for traced numbers", () => {
  it("cuts each text into plain text and references, each with what it shows and the cells behind it", () => {
    const r = checkAnswer(
      answer("MRR was ⟦q1:0:mrr|currency:USD,compact⟧, up ⟦pct(q1:0:mrr, q1:1:mrr)⟧%.", {
        caveats: ["Starter lost ⟦q3:0:churned_mrr|currency:USD,compact⟧."],
      }),
      ctx,
    );
    expect(r.passed).toBe(true);
    expect(r.segments.markdown).toEqual([
      { text: "MRR was " },
      {
        ref: "q1:0:mrr",
        display: "$412.6k",
        kind: "number",
        citations: [{ alias: "q1", queryRunId: "run-1", row: 0, column: "mrr" }],
      },
      { text: ", up " },
      {
        ref: "pct(q1:0:mrr, q1:1:mrr)",
        display: "4.2%",
        kind: "number",
        citations: [
          { alias: "q1", queryRunId: "run-1", row: 0, column: "mrr" },
          { alias: "q1", queryRunId: "run-1", row: 1, column: "mrr" },
        ],
      },
      { text: "." },
    ]);
    // The segments put back together are the rendered text.
    const joined = r.segments.markdown.map((s) => ("text" in s ? s.text : s.display)).join("");
    expect(joined).toBe(r.rendered);
    expect(r.segments.caveats[0]?.map((s) => ("text" in s ? s.text : s.display)).join("")).toBe(r.caveats[0]);
    expect(r.segments.interpretation).toEqual([[{ text: "Last month = September 2026" }]]);
    expect(r.checked).toEqual({ numbers: 3, claims: 0, crossChecks: 1 });
  });

  it("marks a reference it couldn't resolve, with no cells", () => {
    const r = checkAnswer(answer("MRR was ⟦q9:0:mrr⟧."), ctx);
    expect(r.passed).toBe(false);
    expect(r.segments.markdown[1]).toEqual({ ref: "q9:0:mrr", display: "[?]", kind: "unresolved", citations: [] });
  });
});

describe("references", () => {
  it("renders cells and derived values computed in code, and lists what each number cites", () => {
    const r = checkAnswer(
      answer("MRR was ⟦q1:0:mrr|currency:USD,compact⟧ in ⟦q1:0:month|month⟧, up ⟦pct(q1:0:mrr, q1:1:mrr)⟧ on August."),
      ctx,
    );
    expect(r.problems).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r.rendered).toBe("MRR was $412.6k in September 2026, up 4.2% on August.");
    expect(r.values.map((v) => [v.ref, v.display])).toEqual([
      ["q1:0:mrr", "$412.6k"],
      ["q1:0:month", "September 2026"],
      ["pct(q1:0:mrr, q1:1:mrr)", "4.2%"],
    ]);
    expect(r.values[2]?.value).toBeCloseTo(0.042, 3);
    expect(r.citations.map((c) => `${c.alias}:${c.row}:${c.column}`)).toEqual([
      "q1:0:mrr",
      "q1:0:month",
      "q1:0:mrr",
      "q1:1:mrr",
    ]);
  });

  it("renders and checks references in caveats and interpretation too", () => {
    const r = checkAnswer(
      answer("MRR was ⟦q1:0:mrr|currency:USD,compact⟧.", {
        caveats: ["Without tests it would be ⟦q2:0:mrr|currency:USD,compact⟧."],
        interpretation: ["Plans: ⟦q3:0:plan⟧ and others"],
      }),
      ctx,
    );
    expect(r.caveats).toEqual(["Without tests it would be $412.6k."]);
    expect(r.interpretation).toEqual(["Plans: Starter and others"]);
    const bad = checkAnswer(answer("MRR was ⟦q1:0:mrr⟧.", { caveats: ["⟦q9:0:x⟧"] }), ctx);
    expect(bad.problems.join(" ")).toMatch(/no query q9/);
  });

  it("renders text cells as they are", () => {
    const r = checkAnswer(answer("⟦q3:0:plan⟧ lost the most: ⟦q3:0:churned_mrr|currency:USD,compact⟧."), ctx);
    expect(r.rendered).toBe("Starter lost the most: $4.1k.");
  });

  it.each([
    ["⟦q9:0:mrr⟧", /no query q9/],
    ["⟦q1:0:revenue⟧", /no column revenue; it has month, mrr/],
    ["⟦q1:7:mrr⟧", /no row 7/],
    ["⟦mrr⟧", /isn't a reference/],
    ["⟦q1:0:mrr|dollars⟧", /isn't a format/],
    ["⟦pct(q1:0:mrr)⟧", /takes two cells/],
  ])("refuses a reference that doesn't resolve: %s", (markdown, message) => {
    const r = checkAnswer(answer(`MRR: ${markdown}`), ctx);
    expect(r.passed).toBe(false);
    expect(r.problems.join(" ")).toMatch(message);
    expect(r.rendered).toContain("[?]");
  });

  it("repairs a lookalike closing bracket on a well-formed reference, and names a reference that never closes", () => {
    const r = checkAnswer(
      answer("MRR was ⟦q1:0:mrr|currency:USD,compact⟩, then ⟦q1:1:mrr|currency:USD,compact]."),
      ctx,
    );
    expect(r.problems).toEqual([]);
    expect(r.rendered).toBe("MRR was $412.6k, then $396k.");
    const broken = checkAnswer(answer("MRR was ⟦q1:0:mrr and more."), ctx);
    expect(broken.problems.join(" ")).toMatch(/end with ⟧/);
    expect(repairClosers("a ⟦not a ref⟩ b")).toBe("a ⟦not a ref⟩ b");
  });

  it("repairs a closer escaped as Markdown would, on a well-formed reference only", () => {
    const r = checkAnswer(answer("MRR was ⟦q1:0:mrr|currency:USD,compact\\⟧, then ⟦q1:1:mrr\\\\⟧."), ctx);
    expect(r.problems).toEqual([]);
    expect(r.rendered).toBe("MRR was $412.6k, then 395,969.29.");
    expect(repairClosers("a ⟦not a ref\\⟧ b")).toBe("a ⟦not a ref\\⟧ b");
  });

  it("refuses a cell the model was never shown", () => {
    const r = checkAnswer(answer("⟦q3:2:churned_mrr⟧"), { ...ctx, rowsShown: 2 });
    expect(r.problems.join(" ")).toMatch(/no row 2/);
  });

  it("shows a change as a magnitude when the words already say its direction, signed otherwise", () => {
    const words = checkAnswer(
      answer("MRR rose ⟦pct(q1:0:mrr, q1:1:mrr)⟧; churn fell ⟦pct(q3:2:churned_mrr, q3:0:churned_mrr)⟧."),
      ctx,
    );
    expect(words.rendered).toBe("MRR rose 4.2%; churn fell 48.8%.");
    const table = checkAnswer(answer("| Change | ⟦pct(q3:2:churned_mrr, q3:0:churned_mrr)⟧ |"), ctx);
    expect(table.rendered).toBe("| Change | -48.8% |");
  });

  it("doesn't double a % typed after a percent, and keeps one after a plain number", () => {
    expect(checkAnswer(answer("MRR rose ⟦pct(q1:0:mrr, q1:1:mrr)⟧%."), ctx).rendered).toBe("MRR rose 4.2%.");
    const shares = {
      ...ctx,
      results: [{ alias: "q5", queryRunId: "r5", columns: [{ name: "pct", type: "number" as const }], rows: [[12.5]] }],
    };
    expect(checkAnswer(answer("Annual plans are ⟦q5:0:pct⟧% of MRR.", { cross_checks: [] }), shares).rendered).toBe(
      "Annual plans are 12.5% of MRR.",
    );
  });

  it("catches words that contradict a change's sign", () => {
    const r = checkAnswer(answer("MRR fell ⟦pct(q1:0:mrr, q1:1:mrr)⟧."), ctx);
    expect(r.problems.join(" ")).toMatch(/is an increase, but the text before it says it went down/);
  });
});

describe("claims", () => {
  it("recomputes direction, comparison and rank claims", () => {
    const ok = checkAnswer(
      answer("⟦q3:0:plan⟧ churned most.", {
        claims: [
          { kind: "direction", inputs: ["q1:0:mrr", "q1:1:mrr"], assertion: "up" },
          { kind: "rank", inputs: ["q3:0:churned_mrr", "q3:1:churned_mrr", "q3:2:churned_mrr"], assertion: "highest" },
          { kind: "comparison", inputs: ["q3:1:churned_mrr", "q3:2:churned_mrr"], assertion: "greater" },
        ],
        cross_checks: [],
      }),
      ctx,
    );
    expect(ok.problems).toEqual([]);
    const wrong = checkAnswer(
      answer("x", { claims: [{ kind: "direction", inputs: ["q1:0:mrr", "q1:1:mrr"], assertion: "down" }] }),
      ctx,
    );
    expect(wrong.problems.join(" ")).toMatch(/Claim "direction down" doesn't hold/);
  });
});

describe("typed numbers", () => {
  it("catches numerals typed outside a reference", () => {
    const r = checkAnswer(answer("MRR was $412.6k, up 4.2%, across 3 plans: ⟦q1:0:mrr⟧."), ctx);
    expect(r.passed).toBe(false);
    expect(r.problems.join(" ")).toMatch(/never typed/);
    expect(typedNumbers("MRR was $412.6k, up 4.2%, across 3 plans.", "")).toHaveLength(3);
  });

  it("lets a ranking's size through: the top 10, the bottom 5", () => {
    expect(typedNumbers("The top 10 customers by revenue, and the bottom 5.", "")).toEqual([]);
    const found = typedNumbers("The top 10 customers pay 4820 a month.", "");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/4820/);
    // A share is a finding: "the top 10%" isn't a ranking's size.
    for (const share of ["the top 10% of accounts", "the top 10 % of accounts", "the top 10 percent", "the top 10.5"]) {
      expect(typedNumbers(`We are in ${share}.`, ""), share).toHaveLength(1);
    }
  });

  it("lets dates, times, codes, list markers, code and the user's own numbers through", () => {
    const text = [
      "1. In September 2026 (2026-09-01 to 2026-09-30, Sep 30 at 23:00 UTC), Q3 and INV-1023 and the 2nd plan.",
      "2. Run `select 1` or:",
      "```sql\nselect 42\n```",
      "Over the last 90 days you asked about.",
    ].join("\n");
    expect(typedNumbers(text, "What happened in the last 90 days?")).toEqual([]);
  });

  it("lets windows named by their length and labels through, never a finding typed in prose", () => {
    // Early dashboard answers: offering windows and naming a version cost two repair rounds.
    expect(
      typedNumbers("Pick the last 7, 30 or 90 days, or the past 12 months, in the new version 3 (grid@4).", ""),
    ).toEqual([]);
    expect(typedNumbers("Step 2 adds a filter; option 1 keeps it.", "")).toEqual([]);
    // A count or a duration that is a finding is still typed.
    expect(typedNumbers("MRR fell for 3 months and 7 accounts churned.", "")).toHaveLength(2);
  });

  // Forms that once passed as dates, codes or prose.
  it("counts a figure however it's written: a counted year, a currency code, other digits, words, a code span", () => {
    expect(typedNumbers("We have 2040 paying accounts.", "")).toHaveLength(1);
    expect(typedNumbers("In 2026, 2026 revenue grew; since 2025 it has.", "")).toEqual([]);
    expect(typedNumbers("Revenue was USD48200.", "")).toHaveLength(1);
    expect(typedNumbers("MRR was $４８２００.", "")).toHaveLength(1);
    expect(typedNumbers("It ran about forty thousand above plan.", "")).toHaveLength(1);
    expect(typedNumbers("Thousands of users signed up.", "")).toEqual([]);
    expect(typedNumbers("MRR was `$48,200`, from `plan_name`.", "")).toHaveLength(1);
    expect(typedNumbers("MRR was `4820`.", "")).toHaveLength(1);
    expect(typedNumbers("MRR was $2040.", "")).toHaveLength(1);
    expect(typedNumbers("Profit was `-4820`.", "")).toHaveLength(1);
    expect(typedNumbers("We have a total of 2040 paying accounts.", "")).toHaveLength(1);
    // The asker's "forty thousand" isn't a pass for another quantity.
    expect(typedNumbers("Revenue was ninety thousand.", "Which accounts are above forty thousand?")).toHaveLength(1);
    expect(typedNumbers("Revenue was nine hundred thousand.", "Above one hundred thousand?")).toHaveLength(1);
    expect(typedNumbers("Revenue was one hundred thousand.", "Above one hundred thousand?")).toEqual([]);
    expect(typedNumbers("Profit was `$-2040`.", "")).toHaveLength(1);
    expect(typedNumbers("We grew from 2040 accounts.", "")).toHaveLength(1);
    expect(typedNumbers("From 2024 to 2025 it grew.", "")).toEqual([]);
  });

  it("still reads a year as one, SQL in a span as code, and the asker's own figures as theirs", () => {
    expect(typedNumbers("In 2025 orders were ⟦q1:0:mrr⟧; since 2024 accounts grew.", "How did last year go?")).toEqual(
      [],
    );
    expect(typedNumbers("It ran `SELECT amount FROM orders WHERE amount > 10000`.", "")).toEqual([]);
    expect(typedNumbers("Customers under ５００ grew.", "Which customers spend under ５００?")).toEqual([]);
    expect(typedNumbers("Accounts above forty thousand grew.", "Which accounts are above forty thousand?")).toEqual([]);
  });

  it("holds a chart's title and series names, and the follow-ups, to the same rule", () => {
    const chart = { type: "line", title: "MRR hit $9.8M", query: "q1", x: "month", y: ["mrr"] };
    const shown = checkAnswer(
      answer("MRR was ⟦q2:0:mrr⟧.", { charts: [chart], next: ["Why did churn rise 12.5%?"] }),
      ctx,
    );
    expect(shown.verified).toBe(false);
    expect(shown.problems.filter((p) => p.includes("states a figure outside a reference"))).toHaveLength(2);
    const plain = checkAnswer(
      answer("MRR was ⟦q2:0:mrr⟧.", {
        charts: [{ ...chart, title: "MRR by month" }],
        next: ["How did MRR change in 2026?"],
      }),
      ctx,
    );
    expect(plain.problems.filter((p) => p.includes("states a figure outside a reference"))).toEqual([]);
    // A counted year, other digits: refused there too; the asker's own threshold, repeated, isn't.
    for (const title of ["2040 paying accounts", "MRR $４８２００"]) {
      const r = checkAnswer(answer("MRR was ⟦q2:0:mrr⟧.", { charts: [{ ...chart, title }] }), ctx);
      expect(r.verified).toBe(false);
    }
    const theirs = checkAnswer(
      answer("MRR was ⟦q2:0:mrr⟧.", { charts: [{ ...chart, title: "Customers spending under $500" }] }),
      {
        ...ctx,
        question: "Which customers spend under $500?",
      },
    );
    expect(theirs.problems.filter((p) => p.includes("states a figure outside a reference"))).toEqual([]);
    const shownAs = (title: string, question: string) =>
      checkAnswer(answer("MRR was ⟦q2:0:mrr⟧.", { charts: [{ ...chart, title }] }), {
        ...ctx,
        question,
      }).problems.filter((p) => p.includes("states a figure outside a reference"));
    // Their number, grouped or not; never a longer one that holds it.
    expect(shownAs("Customers under $1,000", "Which customers spend under $1000?")).toEqual([]);
    expect(shownAs("Revenue $500,500", "Which customers spend under $500?")).toHaveLength(1);
    expect(typedNumbers("Churn was 12 days after signup.", "")).toHaveLength(1);
  });

  it("lets the approved glossary's numbers through (definitions), but no other typed figure", () => {
    const smb = answer("You have ⟦q1:0:mrr⟧ SMB accounts.", {
      interpretation: ["SMB = fewer than 50 employees (Glossary)"],
    });
    expect(checkAnswer(smb, ctx).problems.join(" ")).toMatch(/never typed/);
    const withGlossary = { ...ctx, definitions: "- SMB: Accounts with fewer than 50 employees." };
    expect(checkAnswer(smb, withGlossary).problems.join(" ")).not.toMatch(/never typed/);
    const typed = answer("You have 214 SMB accounts: ⟦q1:0:mrr⟧.");
    expect(checkAnswer(typed, withGlossary).problems.join(" ")).toMatch(/never typed/);
  });

  it("allows durations in the interpretation, but not in the answer", () => {
    expect(typedNumbers("Last 30 days", "", { durations: true })).toEqual([]);
    expect(typedNumbers("MRR grew for 30 days", "")).toHaveLength(1);
  });
});

describe("numbers and the rows they come from", () => {
  // An early answer: bands sorted as text, so "16+ active" sits in the middle, and "the largest band" was given
  // the 6–15 band's 12. Results here are metric queries, so no cross-check is asked for.
  const bands = (rows: [string, number][]) => ({
    alias: "q5",
    queryRunId: "run-5",
    path: "metric" as const,
    columns: [
      { name: "bucket", type: "text" as const },
      { name: "customers", type: "number" as const },
    ],
    rows,
  });
  const plans = {
    alias: "q7",
    queryRunId: "run-7",
    path: "metric" as const,
    columns: [
      { name: "plan", type: "text" as const },
      { name: "price", type: "number" as const },
      { name: "customers", type: "number" as const },
    ],
    rows: [
      ["Pro", 50, 120],
      ["Pro Plus", 90, 40],
      ["Basic", 10, 300],
    ],
  };
  const g: GateContext = {
    ...ctx,
    results: [
      ...ctx.results.map((r) => ({ ...r, path: "metric" as const })),
      bands([
        ["1-5 active", 13],
        ["16+ active", 195],
        ["6-15 active", 12],
      ]),
      plans,
    ],
  };
  const problems = (markdown: string, c: GateContext = g) =>
    checkAnswer(answer(markdown, { cross_checks: [] }), c).problems;

  it("names the cell to cite when a typed number is part of a label in the results", () => {
    const [p] = problems("⟦q5:2:customers⟧ of them are in the 16+ bucket.");
    expect(p).toMatch(/never typed/);
    expect(p).toContain('"16" is part of ⟦q5:1:bucket⟧ ("16+ active"): cite that cell to name the row');
  });

  it("rejects a number from another row than the one its sentence names, cited or written out", () => {
    expect(problems("The ⟦q5:1:bucket⟧ band holds ⟦q5:2:customers⟧ customers.")).toEqual([
      '⟦q5:2:customers⟧ is q5 row 2, whose bucket is "6-15 active", but the sentence names "16+ active". Cite the row the sentence names, or name this one (⟦q5:2:bucket⟧).',
    ]);
    expect(problems("Basic has ⟦q7:0:customers⟧ customers.").join(" ")).toMatch(
      /whose plan is "Pro", but the sentence names "Basic"/,
    );
    expect(problems("Basic has ⟦q7:2:customers⟧ customers; Pro has ⟦q7:0:customers⟧.")).toEqual([]);
    expect(problems("The ⟦q5:1:bucket⟧ band holds ⟦q5:1:customers⟧ customers.")).toEqual([]);
    // A label inside a longer one the sentence names isn't a second name: "Pro Plus" isn't "Pro".
    expect(problems("Pro Plus has ⟦q7:1:customers⟧ customers.")).toEqual([]);
    expect(problems("Pro Plus has ⟦q7:0:customers⟧ customers.").join(" ")).toMatch(/names "Pro Plus"/);
  });

  it('rejects "the largest" given a row that isn\'t the largest, and says which is', () => {
    const [p] = problems("The largest band, the one with the most active metrics, holds ⟦q5:2:customers⟧ customers.");
    expect(p).toMatch(/^"largest" next to ⟦q5:2:customers⟧ \(12\), but that row isn't q5's largest in any column/);
    expect(p).toContain("its largest customers is 195, in row 1. Cite the row you mean, and name it (⟦q5:1:bucket⟧)");
    expect(problems("The largest band, ⟦q5:1:bucket⟧, holds ⟦q5:1:customers⟧ customers.")).toEqual([]);
    expect(problems("The smallest band holds ⟦q5:2:customers⟧ customers.")).toEqual([]);
    expect(problems("The smallest band holds ⟦q5:1:customers⟧ customers.").join(" ")).toMatch(
      /smallest customers is 12/,
    );
  });

  it("doesn't judge a superlative about another column, the row it names, several numbers, or a partial result", () => {
    // True of the row's price: the highest-priced plan.
    expect(problems("The highest-priced plan has ⟦q7:1:customers⟧ customers.")).toEqual([]);
    // About what names the row: the band with the most active metrics is 16+, whoever is largest.
    const top = {
      ...g,
      results: [
        ...g.results.filter((r) => r.alias !== "q5"),
        bands([
          ["1-5 active", 195],
          ["16+ active", 12],
          ["6-15 active", 13],
        ]),
      ],
    };
    expect(
      problems("The band with the most active metrics, ⟦q5:1:bucket⟧, holds ⟦q5:1:customers⟧ customers.", top),
    ).toEqual([]);
    expect(problems("Most of them, ⟦q5:2:customers⟧, renewed; at least ⟦q3:2:churned_mrr⟧ churned.")).toEqual([]);
    expect(problems("MRR in the most recent month was ⟦q1:1:mrr⟧.")).toEqual([]);
    expect(problems("The largest bands hold ⟦q5:2:customers⟧ and ⟦q5:0:customers⟧ customers.")).toEqual([]);
    expect(problems("The largest band holds ⟦q5:2:customers⟧ customers.", { ...g, rowsShown: 3 })).toEqual([]);
  });
});

describe("cross-checks", () => {
  it("aren't needed when every number comes from a metric query, and are when one doesn't", () => {
    const metric = { ...ctx, results: ctx.results.map((r) => ({ ...r, path: "metric" as const })) };
    expect(checkAnswer(answer("MRR was ⟦q1:0:mrr⟧.", { cross_checks: [] }), metric).problems).toEqual([]);
    const mixed = {
      ...ctx,
      results: ctx.results.map((r) => ({ ...r, path: r.alias === "q3" ? ("raw_sql" as const) : ("metric" as const) })),
    };
    expect(
      checkAnswer(
        answer("MRR was ⟦q1:0:mrr⟧; Starter lost ⟦q3:0:churned_mrr⟧.", { cross_checks: [] }),
        mixed,
      ).problems.join(" "),
    ).toMatch(/Add a cross-check/);
  });

  it("requires one for an answer with numbers", () => {
    const r = checkAnswer(answer("MRR was ⟦q1:0:mrr⟧.", { cross_checks: [] }), ctx);
    expect(r.problems.join(" ")).toMatch(/Add a cross-check/);
    const none = checkAnswer(answer("No plans churned.", { cross_checks: [] }), ctx);
    expect(none.passed).toBe(true);
  });

  it("needs a separate query that agrees within 0.5%, or a stated reason for the difference", () => {
    const same = checkAnswer(
      answer("⟦q1:0:mrr⟧", { cross_checks: [{ headline: "q1:0:mrr", check: "q1:0:mrr" }] }),
      ctx,
    );
    expect(same.problems.join(" ")).toMatch(/same query/);
    const off = checkAnswer(answer("⟦q1:0:mrr⟧", { cross_checks: [{ headline: "q1:0:mrr", check: "q1:1:mrr" }] }), {
      ...ctx,
      results: [...ctx.results, { ...(ctx.results[0] as (typeof ctx.results)[0]), alias: "q4", queryRunId: "run-4" }],
    });
    expect(off.problems.join(" ")).toMatch(/same query/);
    const differs = checkAnswer(
      answer("⟦q1:0:mrr⟧", { cross_checks: [{ headline: "q1:0:mrr", check: "q3:0:churned_mrr" }] }),
      ctx,
    );
    expect(differs.problems.join(" ")).toMatch(/Cross-check disagrees/);
    const explained = checkAnswer(
      answer("⟦q1:0:mrr⟧", {
        cross_checks: [{ headline: "q1:0:mrr", check: "q3:0:churned_mrr", differs_because: "different things" }],
      }),
      ctx,
    );
    expect(explained.passed).toBe(true);
  });

  it("keeps each one with both cells and values, whether they agree, and why they differ", () => {
    const r = checkAnswer(answer("MRR was ⟦q1:0:mrr⟧."), ctx);
    expect(r.crossChecks).toEqual([
      {
        headline: { alias: "q1", queryRunId: "run-1", row: 0, column: "mrr", value: 412600 },
        check: { alias: "q2", queryRunId: "run-2", row: 0, column: "mrr", value: 412600 },
        agrees: true,
      },
    ]);
    const explained = checkAnswer(
      answer("⟦q1:0:mrr⟧", {
        cross_checks: [{ headline: "q1:0:mrr", check: "q3:0:churned_mrr", differs_because: " different things " }],
      }),
      ctx,
    );
    expect(explained.crossChecks).toMatchObject([
      { check: { alias: "q3", value: 4100 }, agrees: false, differsBecause: "different things" },
    ]);
    // One that names a missing cell is a problem to fix, not a check to show.
    expect(
      checkAnswer(answer("⟦q1:0:mrr⟧", { cross_checks: [{ headline: "q1:0:mrr", check: "q9:0:mrr" }] }), ctx)
        .crossChecks,
    ).toEqual([]);
  });

  it("doesn't ask a cannot_answer reply for one", () => {
    const r = checkAnswer(
      answer("There's no sales rep data in this source; the closest is ⟦q3:0:plan⟧.", {
        status: "cannot_answer",
        cross_checks: [],
      }),
      ctx,
    );
    expect(r.passed).toBe(true);
  });
});

describe("charts", () => {
  const chart = (spec: Record<string, unknown>) =>
    checkAnswer(answer("Starter lost the most: ⟦q3:0:churned_mrr⟧.", { cross_checks: [], charts: [spec] }), {
      ...ctx,
      results: ctx.results.map((r) => ({ ...r, path: "metric" as const })),
    });

  it("draws every point from a cell of the query it names", () => {
    const r = chart({
      type: "bar",
      title: "Churned MRR by plan",
      query: "q3",
      x: "plan",
      y: ["churned_mrr"],
      format: "currency:USD,compact",
    });
    expect(r.problems).toEqual([]);
    expect(r.charts).toEqual([
      {
        type: "bar",
        title: "Churned MRR by plan",
        horizontal: false,
        // Kept so a dashboard can draw it again from a fresh run.
        spec: { x: "plan", y: ["churned_mrr"], format: "currency:USD,compact" },
        axis: { currency: "USD", compact: true },
        categories: ["Starter", "Growth", "Scale"],
        series: [
          {
            name: "Churned mrr",
            points: [
              {
                value: 4100,
                display: "$4.1k",
                cell: { alias: "q3", queryRunId: "run-3", row: 0, column: "churned_mrr" },
              },
              {
                value: 3600,
                display: "$3.6k",
                cell: { alias: "q3", queryRunId: "run-3", row: 1, column: "churned_mrr" },
              },
              {
                value: 2100,
                display: "$2.1k",
                cell: { alias: "q3", queryRunId: "run-3", row: 2, column: "churned_mrr" },
              },
            ],
          },
        ],
      },
    ]);
  });

  it("splits one column into a series per value, and labels a time axis by month", () => {
    const pivot = {
      alias: "q9",
      queryRunId: "run-9",
      path: "metric" as const,
      columns: [
        { name: "month", type: "timestamp" as const },
        { name: "plan", type: "text" as const },
        { name: "churned_mrr", type: "number" as const },
      ],
      rows: [
        ["2026-08-01T00:00:00.000Z", "Starter", 5200],
        ["2026-09-01T00:00:00.000Z", "Starter", 4100],
        ["2026-09-01T00:00:00.000Z", "Growth", 3600],
      ],
    };
    const r = checkAnswer(
      answer("Starter lost the most: ⟦q3:0:churned_mrr⟧.", {
        cross_checks: [],
        charts: [{ type: "bar", title: "By plan", query: "q9", x: "plan", y: ["churned_mrr"], series_by: "month" }],
      }),
      { ...ctx, results: [...ctx.results.map((x) => ({ ...x, path: "metric" as const })), pivot] },
    );
    expect(r.problems).toEqual([]);
    expect(r.charts[0]?.categories).toEqual(["Starter", "Growth"]);
    expect(r.charts[0]?.series.map((s) => [s.name, s.points.map((p) => p?.value ?? null)])).toEqual([
      ["August 2026", [5200, null]],
      ["September 2026", [4100, 3600]],
    ]);
  });

  it("names a series whose group has no value, so the legend shows it", () => {
    const versions = {
      alias: "q9",
      queryRunId: "run-9",
      path: "metric" as const,
      columns: [
        { name: "month", type: "text" as const },
        { name: "plan_tier", type: "text" as const },
        { name: "signups", type: "number" as const },
      ],
      rows: [
        ["Aug", "", 21000],
        ["Aug", "Pro", 900],
        ["Sep", null, 22000],
        ["Sep", "Pro", 1400],
      ],
    };
    const r = checkAnswer(
      answer("Pro grew: ⟦q3:0:churned_mrr⟧.", {
        cross_checks: [],
        charts: [
          {
            type: "line",
            title: "By tier",
            query: "q9",
            x: "month",
            y: ["signups"],
            series_by: "plan_tier",
          },
        ],
      }),
      { ...ctx, results: [...ctx.results.map((x) => ({ ...x, path: "metric" as const })), versions] },
    );
    expect(r.problems).toEqual([]);
    expect(r.charts[0]?.series.map((s) => [s.name, s.points.map((p) => p?.value ?? null)])).toEqual([
      ["No plan tier", [21000, 22000]],
      ["Pro", [900, 1400]],
    ]);
  });

  it.each([
    [{ type: "bar", title: "X", query: "q7", x: "plan", y: ["churned_mrr"] }, /there's no query q7/],
    [
      { type: "bar", title: "X", query: "q3", x: "plan", y: ["mrr"] },
      /q3 has no column mrr\. Its columns: plan, churned_mrr/,
    ],
    [{ type: "bar", title: "X", query: "q3", x: "churned_mrr", y: ["plan"] }, /plan holds values that aren't numbers/],
    [{ type: "line", title: "X", query: "q2", x: "mrr", y: ["mrr"] }, /a line needs at least two points/],
    [{ type: "pie", title: "X", query: "q3", x: "plan", y: ["churned_mrr"] }, /spec isn't valid/],
  ])("refuses a chart that doesn't fit its data: %j", (spec, problem) => {
    expect(chart(spec).problems.join(" ")).toMatch(problem);
    expect(chart(spec).charts).toEqual([]);
  });
});

describe("charts and verification", () => {
  it("sends an undrawable chart back for repair, without unverifying the numbers", () => {
    const r = checkAnswer(
      answer("Starter lost the most: ⟦q3:0:churned_mrr⟧.", {
        cross_checks: [],
        charts: [{ type: "bar", title: "X", query: "q3", x: "plan", y: ["nope"] }],
      }),
      { ...ctx, results: ctx.results.map((x) => ({ ...x, path: "metric" as const })) },
    );
    expect(r.passed).toBe(false);
    expect(r.verified).toBe(true);
    expect(r.charts).toEqual([]);
    expect(r.problems.join(" ")).toMatch(/has no column nope/);
  });
});

describe("what the cross-check and the typed-number rules can't be talked around", () => {
  const withText: GateContext = {
    ...ctx,
    results: [
      ...ctx.results,
      {
        alias: "q4",
        queryRunId: "run-4",
        columns: [
          { name: "mrr_text", type: "text" },
          { name: "zip", type: "text" },
          { name: "n", type: "number" },
        ],
        rows: [["412,600", "10115", 3]],
      },
      { alias: "q5", queryRunId: "run-5", columns: [{ name: "n", type: "number" }], rows: [[3]] },
    ],
  };

  it("needs the cross-check's headline to be a number the answer cites", () => {
    const g = checkAnswer(
      answer("MRR was ⟦q1:0:mrr|currency:USD⟧.", { cross_checks: [{ headline: "q4:0:n", check: "q5:0:n" }] }),
      withText,
    );
    expect(g.passed).toBe(false);
    expect(g.problems.join(" ")).toMatch(/Cross-check the answer's own headline/);
    expect(checkAnswer(answer("MRR was ⟦q1:0:mrr|currency:USD⟧."), withText).passed).toBe(true);
  });

  it("refuses an amount written as text in SQL, keeps codes as text", () => {
    const g = checkAnswer(answer("MRR was ⟦q4:0:mrr_text⟧.", { cross_checks: [] }), withText);
    expect(g.problems.join(" ")).toMatch(/number written as text \("412,600"\)/);
    const zip = checkAnswer(answer("The office is in ⟦q4:0:zip⟧.", { cross_checks: [] }), withText);
    expect(zip.passed).toBe(true);
  });

  it("cross-checks an unmodelled number in a cannot_answer too", () => {
    const g = checkAnswer(
      answer("The source has only ⟦q1:0:mrr⟧ of it.", { status: "cannot_answer", cross_checks: [] }),
      withText,
    );
    expect(g.problems.join(" ")).toMatch(/Add a cross-check/);
  });

  it("lets an answer repeat a number from the asker's file only where it says it's theirs", () => {
    const files: GateContext = { ...withText, askerNumbers: "target 1,200 customers" };
    const bare = checkAnswer(answer("MRR was ⟦q1:0:mrr|currency:USD⟧, and you added 1,200 customers."), files);
    expect(bare.problems.join(" ")).toMatch(/repeats a number from their file/);
    const labelled = checkAnswer(
      answer("MRR was ⟦q1:0:mrr|currency:USD⟧. Your file's target is 1,200 customers."),
      files,
    );
    expect(labelled.passed).toBe(true);
    // Not in their file: typed, as before.
    expect(checkAnswer(answer("MRR was ⟦q1:0:mrr|currency:USD⟧. Your file says 1,300."), files).passed).toBe(false);
  });
});
