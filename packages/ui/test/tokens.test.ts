import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateColor, renderModule, substitute, toHex } from "../scripts/token-engine";

// The generated values live in @opendash/tokens, so packages that can't take the UI's dependencies (email) read them.
const generated = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../tokens/src/tokens.generated.ts");

describe("tokens.generated.ts", () => {
  it("is up to date with the theme CSS (run `pnpm --filter @opendash/ui tokens`)", () => {
    expect(readFileSync(generated, "utf8")).toBe(renderModule());
  });
});

describe("token engine", () => {
  it("resolves var() with fallbacks", () => {
    const env = new Map([
      ["--a", "var(--b, #ff0000)"],
      ["--c", "#00ff00"],
    ]);
    expect(substitute("var(--a)", env)).toBe("#ff0000");
    expect(substitute("var(--c)", env)).toBe("#00ff00");
  });

  it("mixes with transparent using premultiplied alpha, like CSS", () => {
    const mixed = evaluateColor("color-mix(in oklab, #6366f1 15%, transparent)");
    expect(mixed && toHex(mixed)).toBe("#6366f126");
  });
});
