// DashBench's held-out wordings: one per question, none a copy of the question or its other wordings, and none where
// the analyst could read it: no product code imports the set, and no wording appears in the code or context the
// analyst is given (its prompt and tools, the starter pack, the demo glossary).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DASHBENCH } from "../src";
import { HOLDOUT } from "../src/saas/holdout";

const root = path.resolve(import.meta.dirname, "../../..");
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx|md|yaml)$/.test(name) ? [p] : [];
  });
/** Where the product lives: everything but the evals package and the runner's scripts. */
const product = [
  ...readdirSync(path.join(root, "packages"))
    .filter((p) => p !== "evals")
    .map((p) => path.join(root, "packages", p, "src")),
  path.join(root, "apps/web/app"),
  path.join(root, "apps/web/components"),
  path.join(root, "apps/web/lib"),
  path.join(root, "apps/worker/src"),
].flatMap((d) => {
  try {
    return sources(d);
  } catch {
    return [];
  }
});
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

describe("held-out wordings", () => {
  it("has one for every question, each its own", () => {
    expect(Object.keys(HOLDOUT).sort()).toEqual(DASHBENCH.map((g) => g.id).sort());
    for (const g of DASHBENCH) {
      const h = HOLDOUT[g.id] as string;
      expect(h.trim().length, g.id).toBeGreaterThan(8);
      expect([g.question, ...(g.phrasings ?? [])].map(norm), g.id).not.toContain(norm(h));
    }
    expect(new Set(Object.values(HOLDOUT).map(norm)).size).toBe(DASHBENCH.length);
  });

  it("stays out of the product: nothing imports it, nothing contains a wording", () => {
    expect(product.length).toBeGreaterThan(50);
    const glossary = readFileSync(path.join(root, "packages/evals/src/saas/glossary.ts"), "utf8");
    for (const file of product) {
      const text = readFileSync(file, "utf8");
      expect(/evals\/holdout|saas\/holdout/.test(text), path.relative(root, file)).toBe(false);
      const lower = norm(text);
      for (const [id, h] of Object.entries(HOLDOUT)) expect(lower.includes(norm(h)), `${id} in ${file}`).toBe(false);
    }
    for (const [id, h] of Object.entries(HOLDOUT)) expect(norm(glossary).includes(norm(h)), id).toBe(false);
  });
});
