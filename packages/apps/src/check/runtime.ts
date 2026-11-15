/**
 * The runtime every App frame loads, built once per process: React, ECharts, the kit and the bridge as one bundle,
 * with the kit's styles and OpenDash's tokens for light and dark inside it. Its hash names its path, so a frame always
 * asks for the runtime it was given, and a new one never reaches a page cached with the old.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tokens } from "@opendash/tokens";
import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.join(HERE, "../runtime");

export interface BuiltRuntime {
  js: string;
  hash: string;
  bytes: number;
}

const vars = (t: Record<string, string>) =>
  Object.entries(t)
    .map(([k, v]) => `--${k}:${v};`)
    .join("");

/** The kit's styles with the theme: OpenDash's choice wins (data-theme), the system's otherwise. */
export function runtimeCss(): string {
  return [
    `:root{color-scheme:light;${vars(tokens.light)}}`,
    `:root[data-theme="dark"]{color-scheme:dark;${vars(tokens.dark)}}`,
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){color-scheme:dark;${vars(tokens.dark)}}}`,
    readFileSync(path.join(RUNTIME_DIR, "kit.css"), "utf8"),
  ].join("\n");
}

let built: Promise<BuiltRuntime> | null = null;

/** The runtime, built on first use and kept for the life of the process. */
export function runtime(): Promise<BuiltRuntime> {
  built ??= buildRuntime().catch((error) => {
    built = null;
    throw error;
  });
  return built;
}

export async function buildRuntime(): Promise<BuiltRuntime> {
  const res = await esbuild.build({
    entryPoints: [path.join(RUNTIME_DIR, "index.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    minify: true,
    jsx: "automatic",
    target: "es2022",
    charset: "utf8",
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"', __OD_CSS__: JSON.stringify(runtimeCss()) },
    logLevel: "silent",
  });
  const js = res.outputFiles[0]?.text ?? "";
  return { js, hash: createHash("sha256").update(js).digest("hex").slice(0, 32), bytes: Buffer.byteLength(js) };
}
