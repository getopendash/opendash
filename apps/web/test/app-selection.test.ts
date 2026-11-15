// Select to edit, the page's half: what an App's frame says was clicked is taken only for the revision drawn, in a
// mark's shape and bounded; each piece once, no faster than the gate allows, up to a question's limit; and the
// composer appends it as a chip once, while the question has room.
import { describe, expect, it } from "vitest";
import { appendAttached, pickedSelection, type SelectedPiece, selectionGate } from "../lib/app-selection";

const drawn = { dashboardId: "d1", revision: "rev-1" };
const id = () => "00000000-0000-4000-8000-000000000001";

describe("a selection from an App's frame", () => {
  it("becomes a chip naming the piece, its text and where it was written", () => {
    const got = pickedSelection(
      { revision: "rev-1", src: "/components/Queue.tsx:42:7", tag: "li", text: "  ticket 4656\n urgent " },
      drawn,
      id,
    );
    expect(got).toEqual({
      ok: true,
      piece: {
        kind: "app_element",
        id: id(),
        title: "‘ticket 4656 urgent’ in Queue",
        dashboardId: "d1",
        revision: "rev-1",
        file: "/components/Queue.tsx",
        line: 42,
        column: 7,
        tag: "li",
        text: "ticket 4656 urgent",
      },
    });
  });

  it("is refused for another revision, a mark of another shape, or nothing like one", () => {
    expect(pickedSelection({ revision: "rev-0", src: "/App.tsx:1:1", tag: "p", text: "" }, drawn, id)).toEqual({
      ok: false,
      why: "stale",
    });
    expect(pickedSelection({ revision: "rev-1", src: "/App.tsx", tag: "p", text: "" }, drawn, id)).toEqual({
      ok: false,
      why: "invalid",
    });
    expect(pickedSelection("hello", drawn, id)).toEqual({ ok: false, why: "invalid" });
    // A bundle built before marks: said so, so the page can say to save it once.
    expect(pickedSelection({ revision: "rev-1", tag: "div", text: "old" }, drawn, id)).toEqual({
      ok: false,
      why: "unmarked",
    });
  });

  it("keeps the text and tag bounded", () => {
    const got = pickedSelection(
      { revision: "rev-1", src: "/App.tsx:3:1", tag: "<script>", text: "x".repeat(5000) },
      drawn,
      id,
    );
    expect(got.ok && got.piece.text.length).toBe(200);
    expect(got.ok && got.piece.tag).toBe("");
  });
});

describe("the page's gate", () => {
  const piece = (line: number): SelectedPiece => ({
    kind: "app_element",
    id: `p${line}`,
    title: "",
    dashboardId: "d1",
    revision: "rev-1",
    file: "/App.tsx",
    line,
    column: 1,
    tag: "p",
    text: "",
  });

  it("takes each piece once, no faster than its gap, up to the question's limit", () => {
    let t = 0;
    const gate = selectionGate({ max: 2, gapMs: 250, now: () => t });
    expect(gate(piece(1))).toBe("added");
    t = 100;
    expect(gate(piece(2))).toBe("too-fast");
    t = 400;
    expect(gate({ ...piece(1), id: "again" })).toBe("again");
    expect(gate(piece(2))).toBe("added");
    t = 800;
    expect(gate(piece(3))).toBe("full");
  });
});

describe("the composer's append", () => {
  const chip = (id: string, kind = "app_element", line = 1) => ({
    kind,
    id,
    dashboardId: "d1",
    revision: "r",
    file: "/App.tsx",
    line,
  });

  it("adds a chip once, while there's room", () => {
    const one = appendAttached([], chip("a"), 5);
    expect(one).toEqual({ list: [chip("a")], outcome: "added" });
    // The same piece selected again (a new selection id) isn't added twice.
    expect(appendAttached(one.list, chip("b"), 5).outcome).toBe("already");
    expect(appendAttached(one.list, chip("b", "app_element", 2), 5).list).toHaveLength(2);
    const full = [chip("m", "metric"), chip("g", "guide")];
    expect(appendAttached(full, chip("c"), 2)).toEqual({ list: full, outcome: "full" });
  });
});
