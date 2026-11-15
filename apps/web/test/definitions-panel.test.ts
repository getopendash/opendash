// A source's Definitions card while a batch drafts: an automatic batch and one asked for both list
// the Modeler's helpers as they go, and both read the page again while the Modeler leads it; a batch it drafts itself
// has no helpers to follow, and isn't read again. Rendered on the server, as the page is.
import type { SourceDraftState } from "@opendash/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const refreshed = vi.hoisted(() => ({ mounted: 0, followed: 0 }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("next/link", () => ({
  default: (p: { href: string; children: unknown }) => createElement("a", { href: p.href }, p.children as never),
}));
vi.mock("../components/sources/refresh-while", () => ({
  RefreshWhile: () => {
    refreshed.mounted += 1;
    return null;
  },
}));
vi.mock("../components/sources/follow-batch", () => ({
  FollowBatch: () => {
    refreshed.followed += 1;
    return null;
  },
  BatchTraceButton: () => createElement("button", { type: "button" }, "Trace"),
}));

const { DefinitionsPanel } = await import("../components/sources/definitions-panel");

const now = Date.parse("2026-10-15T12:00:00Z");
const helpers: SourceDraftState["drafting"] extends infer D ? (D extends { helpers: infer H } ? H : never) : never = [
  { tables: ["public.plans"], state: "kept", datasets: 1, metrics: 2, reason: null, startedAt: "2026-10-15T11:58:00Z" },
  {
    tables: ["billing.refunds"],
    state: "drafting",
    datasets: 0,
    metrics: 0,
    reason: null,
    startedAt: "2026-10-15T11:57:00Z",
  },
  {
    tables: ["billing.fx_rates"],
    state: "left_out",
    datasets: 0,
    metrics: 0,
    reason: "a lookup, not something people count",
    startedAt: "2026-10-15T11:57:00Z",
  },
];
const drafting = {
  proposalId: "p",
  tables: ["public.plans", "billing.refunds", "billing.fx_rates"],
  startedAt: "2026-10-15T11:56:00Z",
  leads: true,
  helpers,
  runId: null as string | null,
};
const render = (state: SourceDraftState, picker: never | null = null) => {
  refreshed.mounted = 0;
  refreshed.followed = 0;
  return renderToStaticMarkup(createElement(DefinitionsPanel, { sourceId: "s", state, picker, now }));
};
const base: SourceDraftState = {
  definitions: { verified: 0, proposed: 0 },
  drafting,
  inReview: 0,
  stopped: null,
  auto: null,
};

describe("the Definitions card while a batch drafts", () => {
  it("lists the helpers and reads the page again, for an automatic batch as for one asked for", () => {
    const auto = {
      batch: 2,
      batches: 3,
      toDraft: 4,
      held: null,
      budget: { leftUsd: 8.7, budgetUsd: 10, spentUsd: 1.3 },
    };
    for (const state of [base, { ...base, auto }]) {
      const html = render(state);
      expect(html, state.auto ? "automatic" : "asked for").toContain("public.plans");
      expect(html).toContain("1 dataset, 2 metrics kept");
      expect(html).toContain("drafting · 3 min");
      expect(html).toContain("left out: a lookup, not something people count");
      expect(refreshed.mounted).toBe(1);
    }
    expect(render({ ...base, auto })).toContain("batch 2 of 3");
  });

  it("reads the page again only while the Modeler leads the batch", () => {
    const itself = { ...drafting, tables: ["public.plans", "billing.refunds"], leads: false, helpers: [] };
    const html = render({ ...base, drafting: itself });
    expect(html).toContain("public.plans, billing.refunds");
    expect(refreshed.mounted).toBe(0);
    // Leading, before its first group is handed out: no helpers yet, and the card waits for them.
    expect(render({ ...base, drafting: { ...drafting, helpers: [] } })).not.toContain("kept");
    expect(refreshed.mounted).toBe(1);
  });

  it("follows its lead's word on each drafter once the batch has its run, its trace for whoever drafts", () => {
    const html = render({ ...base, drafting: { ...drafting, runId: "r" } });
    expect(refreshed).toMatchObject({ followed: 1, mounted: 0 });
    expect(html).not.toContain(">Trace<");
    const picker = { tables: [], budgetUsd: 0 } as never;
    expect(render({ ...base, drafting: { ...drafting, runId: "r" } }, picker)).toContain(">Trace<");
  });
});
