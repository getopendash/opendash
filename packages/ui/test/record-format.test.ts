// How a list of records writes its cells and its CSV.
import { describe, expect, it } from "vitest";
import { formatRecordCell, recordsCsv, recordsPages, recordsRange, recordTone } from "../src/record-format";

const col = (name: string, type: "string" | "number" | "boolean" | "time", format?: "number" | "usd" | "percent") => ({
  name,
  label: name,
  type,
  ...(format ? { format } : {}),
});

describe("formatRecordCell", () => {
  it("writes dates for midnight and a time with its zone otherwise", () => {
    expect(formatRecordCell("2026-09-26T00:00:00Z", col("d", "time"))).toBe("Sep 26, 2026");
    expect(formatRecordCell("2026-09-28", col("d", "time"))).toBe("Sep 28, 2026");
    expect(formatRecordCell("2026-09-28T14:03:11Z", col("d", "time"))).toBe("Sep 28, 2026, 14:03 UTC");
    expect(formatRecordCell("not a date", col("d", "time"))).toBe("not a date");
  });
  it("writes money, numbers and identifiers", () => {
    expect(formatRecordCell(18250.4, col("mrr_usd", "number", "usd"))).toBe("$18,250.40");
    expect(formatRecordCell("1240", col("n", "number"))).toBe("1,240");
    expect(formatRecordCell(1234.5678, col("n", "number"))).toBe("1,234.57");
    expect(formatRecordCell(4112, col("id", "number"))).toBe("4112");
    expect(formatRecordCell(4112, col("account_id", "number"))).toBe("4112");
    expect(formatRecordCell(12.5, col("rate", "number", "percent"))).toBe("12.5%");
  });
  it("writes empty cells, booleans and text", () => {
    expect(formatRecordCell(null, col("x", "string"))).toBe("—");
    expect(formatRecordCell("", col("x", "string"))).toBe("—");
    expect(formatRecordCell(true, col("x", "boolean"))).toBe("Yes");
    expect(formatRecordCell("false", col("x", "boolean"))).toBe("No");
    expect(formatRecordCell("urgent", col("priority", "string"))).toBe("urgent");
  });
});

describe("recordTone", () => {
  it("tones only status-like columns", () => {
    expect(recordTone("status", "solved")).toBe("good");
    expect(recordTone("status", "Failed")).toBe("bad");
    expect(recordTone("status", "trialing")).toBe("wait");
    expect(recordTone("priority", "urgent")).toBe("bad");
    expect(recordTone("priority", "high")).toBe("high");
    expect(recordTone("priority", "normal")).toBeNull();
    expect(recordTone("channel", "failed")).toBeNull();
    expect(recordTone("status", 3)).toBeNull();
  });
});

describe("recordsCsv", () => {
  const columns = [col("id", "number"), col("subject", "string"), col("amount", "number")];
  it("writes a header and the raw values, quoting what needs it", () => {
    expect(recordsCsv(columns, [[1, 'He said "hi", twice', 12.5]])).toBe(
      'id,subject,amount\r\n1,"He said ""hi"", twice",12.5\r\n',
    );
    expect(recordsCsv(columns, [[2, null, 0]])).toBe("id,subject,amount\r\n2,,0\r\n");
  });
  it("keeps a spreadsheet from running a cell as a formula", () => {
    const out = recordsCsv(columns, [
      [1, '=HYPERLINK("http://x")', 1],
      [2, "+1 555", 2],
      [3, "-5 off", 3],
      [4, "@sum", 4],
    ]);
    expect(out).toContain("'=HYPERLINK");
    expect(out).toContain("'+1 555");
    expect(out).toContain("'-5 off");
    expect(out).toContain("'@sum");
    // Numbers are numbers: a negative amount isn't text.
    expect(recordsCsv(columns, [[1, "x", -4.5]])).toContain(",-4.5");
  });
});

describe("range and pages", () => {
  it("says what's shown, and what can be reached", () => {
    expect(recordsRange({ page: 0, pageSize: 25, shown: 25, total: 1402, cap: 1000, noun: "tickets" })).toBe(
      "Showing 1–25 of the first 1,000 of 1,402 tickets",
    );
    expect(recordsRange({ page: 1, pageSize: 25, shown: 7, total: 32, cap: 1000, noun: "tickets" })).toBe(
      "Showing 26–32 of 32 tickets",
    );
    expect(recordsRange({ page: 0, pageSize: 25, shown: 0, total: 0, cap: 1000, noun: "tickets" })).toBe(
      "Showing 0–0 of 0 tickets",
    );
    expect(recordsPages({ page: 0, pageSize: 25, total: 1402, cap: 1000 })).toEqual({ prev: false, next: true });
    expect(recordsPages({ page: 39, pageSize: 25, total: 1402, cap: 1000 })).toEqual({ prev: true, next: false });
    expect(recordsPages({ page: 0, pageSize: 25, total: 25, cap: 1000 })).toEqual({ prev: false, next: false });
  });
});
