// What react-pdf leaves to us: a long address is cut at its separators (no hyphen),
// a number never breaks, emoji are one glyph each, a character no font has is "□", code keeps its indentation and
// breaks at the edge; and a table's columns are laid out as the page's auto table: natural widths, then shared out,
// then the whole table smaller, never past the page.
import { describe, expect, it } from "vitest";
import { columnWidths, SMALLEST } from "../src/table";
import { breakable, codeText, drawable, MISSING, unbreakable } from "../src/text";

const shown = (text: string) => text.replaceAll("\u00A0", "_");
/** A text's pieces, a "|" where a line may break between two. */
const cut = (text: string) => breakable(text).join("|");

describe("text made ready for the layout", () => {
  it("breaks a long address at its separators, never inside '//', and a short word not at all", () => {
    expect(cut("See https://example.test/reports/q3-revenue?plan=growth&period=quarter now.")).toBe(
      "See https://|example.|test/|reports/|q3-|revenue?|plan=|growth&|period=|quarter now.",
    );
    expect(cut("An id 0123456789abcdef0123456789 and words of ordinary length.")).toBe(
      "An id 0123456789ab|cdef01234567|89 and words of ordinary length.",
    );
    // Nothing is lost or added in the cutting.
    const text = "two https://a.test/x?y=1&z=2&w=3 and https://b.test/p/q/r/s/t/u/v";
    expect(breakable(text).join("")).toBe(text);
    expect(breakable("Installation of a bookshelf")).toEqual(["Installation of a bookshelf"]);
  });

  it("keeps a number on one line", () => {
    expect(shown(unbreakable("$1.2 M"))).toBe("$1.2_M");
  });

  it("draws emoji one glyph each, and what no font has as □", () => {
    const covers = (cp: number) => cp < 0x3000 || cp >= 0x1f000;
    expect(drawable("👍🏽 1️⃣ 👨‍👩‍👧 ✅", covers)).toBe("👍 1 👨👩👧 ✅");
    expect(drawable("中文 total", covers)).toBe(`${MISSING}${MISSING} total`);
    // Whitespace and the joiners other scripts shape with stay.
    expect(drawable("a\n b\u200Cd", () => false)).toBe(`${MISSING}\n ${MISSING}\u200C${MISSING}`);
  });

  it("keeps code's indentation and breaks a long line where it meets the edge", () => {
    expect(shown(codeText("select a,\n\tb\n    from t where x_is_long", 12))).toBe(
      "select a,\n____b\n____from t w\nhere x_is_lo\nng",
    );
  });
});

describe("a table's columns", () => {
  it("are as wide as their widest cell when they all fit", () => {
    expect(
      columnWidths(
        [
          { min: 40, max: 90 },
          { min: 30, max: 50 },
        ],
        400,
        16,
      ),
    ).toEqual({
      widths: [90, 50],
      gap: 16,
      scale: 1,
    });
  });

  it("share out the room by how much more each wants, never below its unbreakable piece", () => {
    const { widths, scale } = columnWidths(
      [
        { min: 40, max: 400 },
        { min: 60, max: 60 },
      ],
      300,
      20,
    );
    expect(scale).toBe(1);
    expect(widths[1]).toBe(60);
    expect((widths[0] ?? 0) + (widths[1] ?? 0) + 20).toBeCloseTo(300);
  });

  it("set the whole table smaller when even the unbreakable pieces don't fit, ten numbers wide", () => {
    const ten = Array.from({ length: 10 }, () => ({ min: 52, max: 52 }));
    const { widths, gap, scale } = columnWidths(ten, 483, 16);
    expect(scale).toBeLessThan(1);
    expect(scale).toBeGreaterThanOrEqual(SMALLEST);
    // Each number still whole at the smaller size, and the table inside the page.
    for (const w of widths) expect(w).toBeCloseTo(52 * scale);
    expect(widths.reduce((s, w) => s + w, 0) + gap * 9).toBeCloseTo(483);
  });
});
