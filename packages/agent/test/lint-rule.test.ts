// The lint rule against bare model ids (tools/biome/no-bare-model.grit, AGENTS.md): a model id string handed to the AI
// SDK, or its global gateway, is flagged, since either runs on Vercel AI Gateway paid by the environment's key; a
// model built from its provider, a model id kept as data, and createGateway with its own key are not.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");

function lint(source: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "opendash-lint-"));
  writeFileSync(path.join(dir, "fixture.ts"), source);
  writeFileSync(
    path.join(dir, "biome.json"),
    JSON.stringify({
      plugins: [path.join(ROOT, "tools/biome/no-bare-model.grit")],
      linter: { enabled: true, rules: { recommended: false } },
      formatter: { enabled: false },
      assist: { enabled: false },
    }),
  );
  try {
    execFileSync(path.join(ROOT, "node_modules/.bin/biome"), ["lint", "fixture.ts"], { cwd: dir, stdio: "pipe" });
    return "";
  } catch (error) {
    const e = error as { stdout?: Buffer; stderr?: Buffer };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

describe("the bare-model lint rule", () => {
  it("flags a model id handed to the SDK, and the global gateway", () => {
    const out = lint(`import { gateway, generateText, ToolLoopAgent } from "ai";
export async function f() {
  await generateText({ model: "anthropic/claude-sonnet-5.5", prompt: "x" });
  return new ToolLoopAgent({ model: \`openai/gpt-6.1-sol\`, instructions: "x" });
}
export const g = gateway;
`);
    expect(out.match(/A bare model id runs on the AI SDK's global provider/g)).toHaveLength(2);
    expect(out).toContain("The AI SDK's global gateway reads AI_GATEWAY_API_KEY");
  });

  it("leaves a model built from its provider, and a model id kept as data, alone", () => {
    expect(
      lint(`import { createGateway, generateText, type LanguageModel } from "ai";
export async function f(model: LanguageModel) {
  await generateText({ model, prompt: "x" });
  const run = { model: "claude-sonnet-5-5" };
  return [run, createGateway({ apiKey: "k" })("anthropic/claude-sonnet-5.5")];
}
`),
    ).toBe("");
  });
});
