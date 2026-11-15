// Sharing an App with specific people: the owner finds members by a part of their name or address, never someone
// it's shared with already, a workspace viewer only ever to view; and the sharing button says who sees it, the people
// it's shared with when its visibility keeps it to its owner.
import { describe, expect, it } from "vitest";
import { peopleToAdd, seenByWords } from "@/components/dashboards/share-people";

const members = [
  { userId: "u-sam", name: "Sam Ortiz", email: "sam@acme.test", viewer: false },
  { userId: "u-priya", name: "Priya Shah", email: "priya@acme.test", viewer: false },
  { userId: "u-vic", name: "Vic Lee", email: "vic@acme.test", viewer: true },
];

describe("the people to add", () => {
  it("are found by a part of their name or address, any case, never before anything is typed", () => {
    expect(peopleToAdd(members, new Set(), "", "view")).toEqual([]);
    expect(peopleToAdd(members, new Set(), "  ", "view")).toEqual([]);
    expect(peopleToAdd(members, new Set(), "SHAH", "view").map((m) => m.userId)).toEqual(["u-priya"]);
    expect(peopleToAdd(members, new Set(), "acme.test", "view").map((m) => m.userId)).toEqual([
      "u-sam",
      "u-priya",
      "u-vic",
    ]);
  });

  it("leave out whoever it's shared with already, and add a workspace viewer only to view", () => {
    const found = peopleToAdd(members, new Set(["u-sam"]), "acme", "edit");
    expect(found.map((m) => [m.userId, m.as])).toEqual([
      ["u-priya", "edit"],
      ["u-vic", "view"],
    ]);
  });

  it("are a few at most: a longer search narrows them", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      userId: `u-${i}`,
      name: `Analyst ${i}`,
      email: `analyst${i}@acme.test`,
      viewer: false,
    }));
    expect(peopleToAdd(many, new Set(), "analyst", "view")).toHaveLength(6);
  });
});

describe("who sees it, on the sharing button", () => {
  it("is its visibility, or the people it's shared with while it's otherwise its owner's alone", () => {
    expect(seenByWords("private", 0)).toBe("Only you");
    expect(seenByWords("private", 1)).toBe("1 person");
    expect(seenByWords("private", 3)).toBe("3 people");
    expect(seenByWords("org", 3)).toBe("Everyone");
    expect(seenByWords("project", 0)).toBe("Its project");
  });
});
