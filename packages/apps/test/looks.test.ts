import { describe, expect, it } from "vitest";
import { lookFindings } from "../src/check/check";
import { SUPPORT_DESK_FILES } from "../src/examples";

describe("what looks generated", () => {
  it("names each tell in the file it's in, once a kind", () => {
    const found = lookFindings({
      "/components/Row.tsx": `<li className="border-l-4 border-l-danger rounded-2xl shadow-lg bg-red-500 hover:bg-red-600">x</li>`,
      "/components/Panel.tsx": `<p className="text-xs uppercase tracking-wider">Why they're here</p>
        <svg><circle r="20" strokeDasharray="100" /></svg>`,
      "/App.tsx": `<main className="bg-linear-to-r from-accent to-surface">x</main>`,
    }).map((f) => `${f.file} ${f.message.includes(": ") ? f.message.slice(f.message.indexOf(": ") + 2) : f.message}`);
    expect(found).toHaveLength(7);
    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/components/Row.tsx a thick stripe on one edge"),
        expect.stringContaining("/components/Row.tsx big soft corners"),
        expect.stringContaining("/components/Row.tsx heavy shadow"),
        expect.stringContaining("/components/Row.tsx Tailwind's own colours"),
        expect.stringContaining("/components/Panel.tsx an eyebrow label"),
        expect.stringContaining("/components/Panel.tsx an SVG ring"),
        expect.stringContaining("/App.tsx a gradient"),
      ]),
    );
  });

  it("finds nothing in the reference App, nor in a thin hairline or a dot", () => {
    expect(lookFindings(SUPPORT_DESK_FILES)).toEqual([]);
    expect(
      lookFindings({ "/App.tsx": `<p className="border-l border-border rounded-md rounded-full size-1.5">x</p>` }),
    ).toEqual([]);
  });
});
