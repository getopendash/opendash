// CSV for every export: RFC 4180, and never a formula a spreadsheet would run; a number stays a number.
import { describe, expect, it } from "vitest";
import { csvCell, csvText, queryCsv } from "../src/csv";

describe("a CSV cell", () => {
  it("quotes what needs it and keeps numbers, dates and objects readable", () => {
    expect(csvCell("Acme, Inc.")).toBe('"Acme, Inc."');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell(-12.5)).toBe("-12.5");
    expect(csvCell(null)).toBe("");
    expect(csvCell(new Date("2026-11-16T00:00:00Z"))).toBe("2026-11-16T00:00:00.000Z");
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });

  it("never lets a text cell start a formula, in any of its forms", () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell("+1 555")).toBe("'+1 555");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("-1+1")).toBe("'-1+1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("\rx")).toBe('"\'\rx"');
    expect(csvCell("\n=1")).toBe('"\'\n=1"');
    expect(csvCell("＝1+1")).toBe("'＝1+1");
    expect(csvCell("＋1")).toBe("'＋1");
    expect(csvCell("＠x")).toBe("'＠x");
  });
});

describe("rows as a file", () => {
  const columns = [
    { name: "plan", type: "string" },
    { name: "change", type: "number" },
  ];

  it("writes a header and each row, CRLF-ended", () => {
    expect(
      csvText(columns, [
        ["Starter", 12.5],
        ["Growth, annual", null],
      ]),
    ).toBe('plan,change\r\nStarter,12.5\r\n"Growth, annual",\r\n');
  });

  it("keeps a plain number written as text a number in a number column, and nothing else", () => {
    // A warehouse's bigint or numeric arrives as text.
    expect(
      csvText(columns, [
        ["Scale", "-71"],
        ["Starter", "772"],
      ]),
    ).toBe("plan,change\r\nScale,-71\r\nStarter,772\r\n");
    // Text that only starts like a number is still guarded, in any column.
    expect(csvText(columns, [["-5 off", "-1+cmd"]])).toBe("plan,change\r\n'-5 off,'-1+cmd\r\n");
  });
});

describe("a query's rows as CSV", () => {
  const card = {
    title: "Active subscriptions by plan",
    alias: "q1",
    columns: [
      { name: "plan", type: "string" },
      { name: "active", type: "number" },
    ],
    preview: [
      ["Starter", "772"],
      ["Growth", "354"],
    ],
    rows: 2,
    truncated: false,
  };

  it("is named for its query, and a cut one says so", () => {
    expect(queryCsv(card)).toEqual({
      filename: "active-subscriptions-by-plan.csv",
      text: "plan,active\r\nStarter,772\r\nGrowth,354\r\n",
    });
    expect(queryCsv({ ...card, rows: 1240, truncated: true }).filename).toBe(
      "active-subscriptions-by-plan-first-2-of-1240-rows.csv",
    );
    expect(queryCsv({ ...card, title: null }).filename).toBe("q1.csv");
  });
});
