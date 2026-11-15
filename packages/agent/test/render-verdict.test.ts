// What app_check tells the analyst of the browser's render check: a width measured while its answers still loaded is
// unsettled, never clean, so the analyst looks again rather than call the App done.
import { describe, expect, it } from "vitest";
import { renderVerdict } from "../src/tools/dashboards";

const at = "2026-11-09T10:00:00.000Z";

describe("the render check's verdict", () => {
  it("is clean only when every width measured settled with nothing found", () => {
    const clean = renderVerdict({
      revision: "r",
      widths: { "390": { findings: [], at }, "760": { findings: [], at }, "1280": { findings: [], at } },
    });
    expect(clean).toMatchObject({ found: 0, next: "Clean at every width measured." });
    expect(clean).not.toHaveProperty("note");
  });

  it("says a width measured before its answers came in is unsettled, and asks to look again", () => {
    const slow = renderVerdict({
      revision: "r",
      widths: {
        "390": { findings: [], unsettled: true, at },
        "760": { findings: [], at },
        "1280": { findings: [], unsettled: true, at },
      },
    });
    expect(slow.widths.filter((w) => w.unsettled).map((w) => w.width)).toEqual([390, 1280]);
    expect(slow.next).not.toMatch(/Clean/);
    expect(slow.next).toMatch(/app_check again/);
    expect(slow.note).toMatch(/At 390, 1280px its answers were still loading/);
  });

  it("puts what was found first, and says too when widths are missing", () => {
    const found = renderVerdict({
      revision: "r",
      widths: { "390": { findings: [{ kind: "overflow", message: "It scrolls sideways." }], unsettled: true, at } },
    });
    expect(found).toMatchObject({ found: 1, next: expect.stringMatching(/^Fix each finding/) });
    expect(found.note).toMatch(/Not every width was measured in time/);
  });

  it("says what makes it slow once, not at every width, beside what was found", () => {
    const rounds = { kind: "speed" as const, message: "Its queries were asked for in 3 rounds." };
    const slow = { kind: "speed" as const, message: "q_book took 10.0 s in the warehouse." };
    const verdict = renderVerdict({
      revision: "r",
      widths: {
        "390": { findings: [{ kind: "clipped", message: "A heading is cut off." }, rounds, slow], at },
        "760": { findings: [rounds, slow], at },
        "1280": { findings: [rounds, slow], at },
      },
    });
    expect(verdict.speed).toEqual([rounds.message, slow.message]);
    expect(verdict.widths.map((w) => w.findings)).toEqual([["A heading is cut off."], [], []]);
    expect(verdict).toMatchObject({ found: 1, next: expect.stringMatching(/^Fix each finding.*Under speed:/) });
  });

  it("can still be clean when only its speed is remarked on: a round that must wait and a slow query may have to stay", () => {
    const rounds = { kind: "speed" as const, message: "Its queries were asked for in 2 rounds." };
    const verdict = renderVerdict({
      revision: "r",
      widths: {
        "390": { findings: [rounds], at },
        "760": { findings: [rounds], at },
        "1280": { findings: [rounds], at },
      },
    });
    expect(verdict).toMatchObject({ found: 0, speed: [rounds.message] });
    expect(verdict.next).toMatch(/^Clean at every width measured\. Under speed:/);
  });
});
