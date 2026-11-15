// The spend limits hold room for an unfinished run up to its agent's cap (core BUDGETS.agent.runCostCapsUsd), so each
// agent's own budget must stay within its line there, or work started together could pass a limit after all.
import { BUDGETS, DRAFT_TABLES_MAX, sourceDraftBudget } from "@opendash/core";
import { describe, expect, it } from "vitest";
import { COMPOSER_BUDGET, curator, INVESTIGATOR_BUDGET, MODELER_BUDGET } from "../src";

describe("run cost caps", () => {
  it("hold every agent's own budget", () => {
    const caps = BUDGETS.agent.runCostCapsUsd;
    expect(BUDGETS.agent.analyst.maxCostUsd).toBeLessThanOrEqual(caps.analyst);
    expect(INVESTIGATOR_BUDGET.maxCostUsd).toBeLessThanOrEqual(caps.investigator);
    expect(Math.max(MODELER_BUDGET.maxCostUsd, sourceDraftBudget(DRAFT_TABLES_MAX).maxCostUsd)).toBeLessThanOrEqual(
      caps.modeler,
    );
    expect(curator.budget?.maxCostUsd ?? 0).toBeLessThanOrEqual(caps.curator);
    expect(COMPOSER_BUDGET.maxCostUsd).toBeLessThanOrEqual(caps.composer);
  });
});
