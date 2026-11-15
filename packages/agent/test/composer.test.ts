// The composer, scripted, no spend: given someone's words and what the workspace has to name, it
// proposes the routine by name with propose_routine; a name OpenDash can't place comes back and the run goes on; its
// outcome is the composer's draft, read back by the person who asked.
import {
  checkDefinitions,
  composerResult,
  demoPack,
  installDefinitions,
  listDefinitions,
  startComposer,
  verifyDefinitions,
} from "@opendash/core";
import { type LearnedSource, learnedSource } from "@opendash/core/testing";
import { uuidv7 } from "@opendash/db";
import type { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentDeps, composer, runAttempt } from "../src";
import { call, messagesOf, scripted, step, systemOf } from "./helpers/scripted";

let s: LearnedSource;
const NOW = new Date("2026-10-11T09:00:00Z");
const ids: Record<string, string> = {};
const ctx = () => ({ orgId: s.orgId, userId: s.userId });

beforeAll(async () => {
  s = await learnedSource();
  await s.tenant((tx) =>
    installDefinitions(tx, ctx(), s.connectionId, demoPack("postgres"), { status: "proposed", source: "pack" }),
  );
  await checkDefinitions(s.deps, { orgId: s.orgId, connectionId: s.connectionId }, { now: NOW });
  const list = await s.tenant((tx) => listDefinitions(tx, s.orgId, { connectionId: s.connectionId }));
  await s.tenant((tx) =>
    verifyDefinitions(
      tx,
      ctx(),
      list.map((d) => d.id),
    ),
  );
  for (const d of list) ids[d.slug] = d.id;
  await s.t.owner`insert into auth.user (id, name, email, email_verified)
    values (${s.userId}, 'Maya', 'maya@acme.example', true) on conflict (id) do update set name = excluded.name, email = excluded.email`;
  await s.t.owner`insert into auth.member (id, organization_id, user_id, role, created_at)
    values (${uuidv7()}, ${s.orgId}, ${s.userId}, 'owner', now())
      on conflict (organization_id, user_id) do update set role = excluded.role`;
}, 300_000);
afterAll(async () => {
  await s?.close();
});

const deps = (model: MockLanguageModelV4): AgentDeps => ({
  withTenant: s.deps.withTenant,
  secrets: s.secrets,
  edition: "community",
  model: async () => ({
    model,
    provider: "opendash",
    route: "anthropic",
    providerOptions: {},
    keySource: "deployment",
  }),
  now: () => NOW,
});

describe("the composer", () => {
  it("proposes the routine by name, fixes a name it can't place, and asks back what it can't tell", async () => {
    const { runId } = await s.tenant((tx) =>
      startComposer(
        tx,
        { boss: s.boss, deploymentKeys: { anthropic: true } as never },
        {
          orgId: s.orgId,
          userId: s.userId,
          text: "Tell me and Ines when revenue drops a lot",
          people: ["Maya", "Ines Ruiz"],
          channels: ["growth"],
          canManage: true,
        },
      ),
    );
    const mrr = await s.t.owner<
      { title: string }[]
    >`select title from app.context_item where id = ${ids.mrr as string}`;
    const title = mrr[0]?.title as string;
    const proposal = {
      understood: "When revenue drops a lot, tell you and Ines at once.",
      trigger: "found",
      tell: "at_once",
      people: ["me", "Ines Ruiz"],
      questions: [
        {
          part: "when",
          ask: "What counts as a lot?",
          options: [
            { label: "Unusual for it", set: { condition: "unusual" } },
            { label: "Falls below a line", set: { condition: "crosses", direction: "below" } },
          ],
        },
      ],
    };
    const model = scripted([
      (prompt) => {
        // What the workspace has, fenced as information; who may be named, with the request.
        const sent = `${systemOf(prompt)}\n${messagesOf(prompt)}`;
        expect(sent).toContain(`${title} · monthly`);
        expect(sent).toContain('People you may name: [\\"Maya\\",\\"Ines Ruiz\\"]');
        expect(sent).toContain("The workspace's time zone is UTC.");
        return step(call("propose_routine", { ...proposal, metrics: ["Revenue"] }));
      },
      (prompt) => {
        expect(messagesOf(prompt)).toContain('No verified metric is called \\"Revenue\\"');
        return step(call("propose_routine", { ...proposal, metrics: [title] }));
      },
    ]);
    const result = await runAttempt(deps(model.model), { orgId: s.orgId, runId }, { workerId: "t" }, composer);
    expect(result?.status).toBe("succeeded");
    // Only its own tool, from the first step.
    expect(model.tools[0]).toEqual(["propose_routine"]);
    const read = await s.tenant((tx) => composerResult(tx, ctx(), runId));
    expect(read?.status).toBe("done");
    if (read?.status !== "done") return;
    expect(read.outcome).toMatchObject({
      kind: "composer",
      understood: "When revenue drops a lot, tell you and Ines at once.",
      draft: { trigger: "found", metricIds: [ids.mrr], tell: "at_once", userIds: [] },
      people: ["me", "Ines Ruiz"],
      open: ["when"],
    });
    expect(read.outcome.questions[0]?.options.map((o) => o.patch)).toEqual([
      { condition: "unusual" },
      { condition: "crosses", direction: "below" },
    ]);
  });
});
