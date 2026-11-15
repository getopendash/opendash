import { describe, expect, it } from "vitest";
import { saveItemsOf } from "../src/harness/stream";

describe("saveItemsOf", () => {
  it("names the manifest, each file with its lines so far, and each edit, in order", () => {
    const partial = JSON.stringify({
      dashboard_id: "x",
      definition: { version: 2, title: "Desk" },
      files: { "/App.tsx": "a\nb\nc", "/components/Queue.tsx": "x\ny" },
      edits: [{ file: "/lib/format.ts", old: "a", new: "b" }],
    }).slice(0, -20);
    expect(saveItemsOf(partial)).toEqual([
      { kind: "manifest" },
      { kind: "write", path: "/App.tsx", lines: 3 },
      { kind: "write", path: "/components/Queue.tsx", lines: 2 },
      { kind: "edit", path: "/lib/format.ts" },
    ]);
  });
  it("names a file as soon as its key arrives", () => {
    expect(saveItemsOf('{"files": {"/components/Pulse.tsx": "import')).toEqual([
      { kind: "write", path: "/components/Pulse.tsx", lines: 1 },
    ]);
    expect(saveItemsOf('{"files": {"/comp')).toEqual([]);
  });

  it("takes any folder the App uses, a removal, and waits for a key still arriving", () => {
    const whole = JSON.stringify({
      files: { "/pages/Today.tsx": "a\nb", "/components/Old.tsx": null, "/views/deep/Panel.tsx": "x" },
    });
    expect(saveItemsOf(whole)).toEqual([
      { kind: "write", path: "/pages/Today.tsx", lines: 2 },
      { kind: "remove", path: "/components/Old.tsx" },
      { kind: "write", path: "/views/deep/Panel.tsx", lines: 1 },
    ]);
    // A string inside a file's code that looks like a path is code, not a file.
    expect(saveItemsOf(JSON.stringify({ files: { "/App.tsx": 'import "/lib/x.tsx": 1' } }))).toEqual([
      { kind: "write", path: "/App.tsx", lines: 1 },
    ]);
  });
});
