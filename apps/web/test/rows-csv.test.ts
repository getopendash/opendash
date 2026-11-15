// The rows sheet's CSV: quoted when a cell needs it, and never a formula a spreadsheet would run.
import { describe, expect, it } from "vitest";
import { csvCell } from "@/components/dashboards/dashboard-host";

describe("a rows CSV cell", () => {
  it("quotes what needs it and keeps numbers as they are", () => {
    expect(csvCell("Acme, Inc.")).toBe('"Acme, Inc."');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell(-12.5)).toBe("-12.5");
    expect(csvCell(null)).toBe("");
  });

  it("never lets a cell start a formula", () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("\n=1")).toBe('"\'\n=1"');
    expect(csvCell("\uFF1D1+1")).toBe("'\uFF1D1+1");
  });
});
