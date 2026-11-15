#!/usr/bin/env node
// Checks that every relative Markdown link (and #anchor) in the repo resolves. Used by CI.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const skip = new Set(["node_modules", ".git", ".next", ".turbo", "internal", ".claude", ".playwright-mcp"]);

function* markdown(dir) {
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* markdown(full);
    else if (entry.endsWith(".md")) yield full;
  }
}

const slug = (h) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\- ]/gu, "")
    .replaceAll(" ", "-");
const stripCode = (s) => s.replace(/```[\s\S]*?```/g, "");
const anchors = new Map();
const anchorsOf = (file) => {
  if (!anchors.has(file)) {
    const text = stripCode(readFileSync(file, "utf8"));
    anchors.set(file, new Set([...text.matchAll(/^#+\s+(.*)$/gm)].map((m) => slug(m[1]))));
  }
  return anchors.get(file);
};

let checked = 0;
const broken = [];
for (const file of markdown(root)) {
  const text = stripCode(readFileSync(file, "utf8"));
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^[a-z]+:/i.test(target)) continue;
    checked++;
    const [p, anchor] = target.split("#");
    const resolved = p ? path.resolve(path.dirname(file), p) : file;
    if (!existsSync(resolved)) broken.push(`${path.relative(root, file)} → ${target} (missing file)`);
    else if (anchor && resolved.endsWith(".md") && !anchorsOf(resolved).has(anchor))
      broken.push(`${path.relative(root, file)} → ${target} (missing anchor)`);
  }
}
console.info(`${checked} relative links checked, ${broken.length} broken`);
for (const b of broken) console.error(`  ${b}`);
process.exit(broken.length ? 1 : 0);
