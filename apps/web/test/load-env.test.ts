import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRootEnv } from "../../../scripts/load-env.mjs";

function root(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "opendash-env-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return dir;
}

describe("loadRootEnv", () => {
  it("an empty value in .env.local doesn't hide the real one in .env", () => {
    const env: Record<string, string | undefined> = {};
    loadRootEnv(
      root({
        ".env.local": "OPENDASH_KEK=\nRESEND_API_KEY=re_local\n",
        ".env": "OPENDASH_KEK=real-key\nRESEND_API_KEY=\n",
      }),
      env,
    );
    expect(env).toEqual({ OPENDASH_KEK: "real-key", RESEND_API_KEY: "re_local" });
  });

  it("precedence: the real environment, then .env.local, then .env", () => {
    const env: Record<string, string | undefined> = { A: "process", B: "" };
    const found = loadRootEnv(
      root({ ".env.local": "A=local\nB=local\nC=local\n", ".env": "A=file\nC=file\nD=file\n" }),
      env,
    );
    expect(env).toEqual({ A: "process", B: "local", C: "local", D: "file" });
    expect(found).toEqual([".env.local", ".env"]);
  });

  it("missing files are fine", () => {
    const env: Record<string, string | undefined> = {};
    expect(loadRootEnv(root({}), env)).toEqual([]);
    expect(env).toEqual({});
  });
});
