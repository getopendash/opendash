// Each agent's definition: its kind, and what its tools may change. A background or drafting agent can never
// be given a tool that changes what people see; the lists below pin every tool that changes anything, per agent.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type AgentDefinition, analyst, defineAgent, drafter, investigator, modeler } from "../src";
import { remember } from "../src/tools/actions";
import type { AgentTool } from "../src/tools/types";

const changing = (a: AgentDefinition) => a.tools.filter((t) => t.effect !== "read").map((t) => t.name);

describe("one agent, its jobs", () => {
  it("has a job for every run profile, each under its own name", async () => {
    const { JOBS, jobFor } = await import("../src");
    // app.run's run_profile_check.
    const profiles = ["analyst", "investigator", "modeler", "drafter", "curator", "composer"];
    expect(Object.keys(JOBS).sort()).toEqual([...profiles].sort());
    for (const p of profiles) expect(jobFor(p)?.name).toBe(p);
    expect(jobFor("toString")).toBeNull();
    expect(jobFor("nobody")).toBeNull();
  });
});

describe("the agents", () => {
  it("each has its kind", () => {
    expect([analyst, investigator, modeler].map((a) => [a.name, a.kind])).toEqual([
      ["analyst", "interactive"],
      ["investigator", "background"],
      ["modeler", "drafting"],
    ]);
  });

  it("changes only what its kind may", () => {
    expect(changing(analyst)).toEqual([
      "definition_draft",
      "remember",
      "dashboard_plan",
      "dashboard_start",
      "dashboard_save",
      "answer",
      "clarify",
    ]);
    expect(changing(investigator)).toEqual(["investigation"]);
    expect(changing(modeler)).toEqual(["propose_definitions", "draft_tables", "finish_drafting", "cannot_draft"]);
    // Its drafter proposes and gives its brief, nothing else.
    expect(changing(drafter)).toEqual(["propose_definitions", "brief"]);
    for (const a of [investigator, modeler, drafter]) {
      for (const t of changing(a)) expect([...a.ending.tools, ...(a.children ?? [])]).toContain(t);
    }
    // The one tool beside its endings runs a child run, whose own tools were checked so.
    expect(modeler.children).toEqual(["draft_tables"]);
  });
});

describe("defineAgent", () => {
  const base: AgentDefinition = { ...investigator, name: "probe" };
  const tool = (name: string, effect: AgentTool["effect"], time?: AgentTool["time"]): AgentTool => ({
    name,
    description: name,
    effect,
    ...(time ? { time } : {}),
    schema: z.object({}),
    execute: async () => ({ value: null }),
  });

  it("refuses a background agent a tool that changes something besides its ending, or one that runs a child", () => {
    expect(() => defineAgent({ ...base, tools: [...base.tools, remember as AgentTool] })).toThrow(
      /remember changes something/,
    );
    const runsOne = tool("runs_one", "internal", "child");
    expect(() => defineAgent({ ...base, tools: [...base.tools, runsOne] })).toThrow(/runs_one changes something/);
    expect(defineAgent({ ...base, tools: [...base.tools, runsOne], children: ["runs_one"] }).children).toEqual([
      "runs_one",
    ]);
    // A child runs to its end in the call: on a quick tool's time it would be cut off first.
    const quick = tool("runs_one", "internal");
    expect(() => defineAgent({ ...base, tools: [...base.tools, quick], children: ["runs_one"] })).toThrow(
      /needs a child's time/,
    );
    expect(() => defineAgent({ ...base, children: ["runs_two"] })).toThrow(
      /child tool runs_two isn't one of its tools/,
    );
  });

  it("refuses a tool listed twice, an ending it doesn't have, and an effect not built yet", () => {
    expect(() => defineAgent({ ...base, tools: [...base.tools, base.tools[0] as AgentTool] })).toThrow(/twice/);
    expect(() => defineAgent({ ...base, ending: { ...base.ending, tools: ["answer"] } })).toThrow(
      /ending tool answer isn't one of its tools/,
    );
    expect(() => defineAgent({ ...base, tools: [...base.tools, tool("send_email", "external")] })).toThrow(
      /no agent can have yet/,
    );
  });

  it("lets a conversation's agent change what the person asked it to", () => {
    expect(() => defineAgent({ ...analyst, name: "probe" })).not.toThrow();
  });
});
