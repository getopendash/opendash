// References in Ask, with a scripted model: an image the person attached reaches the model as a
// picture with their question, a file as their fenced data, each said to be theirs and what was taken from it.
import { submitQuestion } from "@opendash/core";
import { type LearnedSource, learnedSource } from "@opendash/core/testing";
import { uuidv7 } from "@opendash/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentDeps, runAttempt } from "../src";
import { analyst } from "../src/agents/analyst";
import { call, scripted, step, systemOf } from "./helpers/scripted";

let s: LearnedSource;
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString("base64");

beforeAll(async () => {
  s = await learnedSource();
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("references in a question", () => {
  it("sends an image as a picture with the question and a file as the person's data", async () => {
    const q = await submitQuestion(
      { withTenant: s.deps.withTenant, boss: null },
      {
        orgId: s.orgId,
        userId: s.userId,
        connectionId: s.connectionId,
        text: "Build me something like this",
        channel: "web",
        model: "mock",
        attachments: [
          { kind: "image", id: uuidv7(), name: "sketch.png", mediaType: "image/png", data: png },
          { kind: "file", id: uuidv7(), name: "notes.md", text: "Keep the headline number first." },
        ],
      },
    );
    const { model, prompts } = scripted([
      step(call("answer", { status: "answered", markdown: "Noted.", interpretation: [], caveats: [] })),
    ]);
    const deps: AgentDeps = {
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
      now: () => new Date(),
    };
    expect((await runAttempt(deps, { orgId: s.orgId, runId: q.runId }, { workerId: "test" }, analyst))?.status).toBe(
      "succeeded",
    );
    const sent = JSON.stringify(prompts[0]);
    // The picture, with the question.
    expect(sent).toContain('"mediaType":"image/png"');
    expect(sent).toContain(png);
    // Both said to be the person's, and what's taken from them said.
    const system = systemOf(prompts[0]);
    expect(system).toContain("The person attached an image");
    expect(system).toContain("From your image sketch.png");
    expect(system).toContain("Keep the headline number first.");
    expect(system).toContain("From your file notes.md");
    // The recorded prompt keeps which image, never its bytes.
    const [run] = await s.t.owner<
      { prompt: string }[]
    >`select prompt::text as prompt from app.run where id = ${q.runId}`;
    expect(run?.prompt).not.toContain(png);
  });
});
