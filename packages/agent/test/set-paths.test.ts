// A change to a saved definition by path (dashboard_save's set): made on a copy, a list's item by number, null
// removes, and never a path into an object's prototype.
import { describe, expect, it } from "vitest";
import { setPaths } from "../src/tools/dashboards";

const def = () => ({
  title: "Accounts",
  pages: [
    {
      id: "p",
      sections: [
        { id: "a", title: "A" },
        { id: "b", title: "B" },
      ],
    },
  ],
});

describe("a change by path", () => {
  it("sets a value, removes one, and leaves the original as it was", () => {
    const d = def();
    const r = setPaths(d, [
      { path: "pages.0.sections.1.title", value: "Revenue" },
      { path: "pages.0.sections.0", value: null },
    ]);
    expect("value" in r && r.value).toMatchObject({ pages: [{ sections: [{ id: "b", title: "Revenue" }] }] });
    expect(d.pages[0]?.sections).toHaveLength(2);
  });

  it("says why a path isn't there, and never reaches a prototype", () => {
    expect(setPaths(def(), [{ path: "pages.3.title", value: "x" }])).toMatchObject({
      error: expect.stringContaining("nothing at 3"),
    });
    expect(setPaths(def(), [{ path: "__proto__.polluted", value: 1 }])).toMatchObject({ error: expect.any(String) });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
