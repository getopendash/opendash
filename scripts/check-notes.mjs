#!/usr/bin/env node
// Keeps private working notes out of the code: a comment explains why the code is the way it is, never who asked for
// it, when, or where it was decided. Notes like "(Codex review, 2026-11-09)", "ADR-0058" or "board 26 B3" point at
// people, reviews and documents an outside contributor can't see. Used by CI.
//
// Checked: every tracked text file except generated ones, vendored code and licences. A hit prints its file, line and text.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

// Anywhere in a file: names of people and reviews, and private document numbers.
const ANYWHERE = [
  [/\bfounder'?s?\b/i, "names a person: say the reason instead"],
  [/\bCodex\b/, "names a review: say the reason instead"],
  [/\b(?:security|code) review (?:of|found|said)\b|\bsecurity review,|\(security review\)/i, "names a review"],
  [/\bADR-?\s?\d{2,4}\b/, "points at a private decision record"],
  [/\b[Bb]oard \d+\b/, "points at a private design board"],
  [/\bskills audit\b/i, "names an audit: say the reason instead"],
  [/\bPen\b(?!cil)|\bpen\.dev\b|\bCrayons\b/, "names a private design tool"],
];
// In comments only: a date as provenance, and a plan code in parentheses ("(B3)", "(step 7b)", "(kit phase 1)").
const IN_COMMENTS = [
  // "(founder, 2026-11-08)", "(2026-11-09: it couldn't be typed in)": not a bare example date like "(2026-09-01)".
  [/\([^()]{0,60}, 20\d\d-\d\d-\d\d\)|\((?:[^()]{0,60}, )?20\d\d-\d\d-\d\d:/, "dates a note: say the reason instead"],
  [
    /\b(?:measured|said|asked|found|amended|production|checked|reported|fixed|broke|decided) (?:on )?20\d\d-\d\d-\d\d\b/i,
    "dates a note: say the reason instead",
  ],
  [
    /\((?:[^()]*?[\s(])?(?:[A-HJ-NPRT-Z]\d{1,2}[a-z]?|[A-Z]{2}\d[a-z]?)(?:\.\d{1,2})?(?=[,/ )])/,
    "carries a plan code: drop it",
  ],
  [/\((?:[^()]*?\b)?(?:step|slice|batch|kit phase|stage) \d+[a-z]?\b/i, "carries a plan step: drop it"],
  // A design screen's code anywhere in a comment ("G3: a conversation", "M7's Try now", "SL1"): name the screen.
  [/(?<![\w$.-])(?:SL\d[a-z]?|[A-Z]\d{1,2}[a-z]?)(?![\w-])/, "carries a screen or plan code: name the screen instead"],
  [/\((?:[^()]*?\s)?[a-z]+ v0\b|\bv0 decision \d+\b/i, "carries a plan's name: drop it"],
];
// Codes that are real names, not plan codes.
const NOT_CODES =
  /\b(?:H[1-6]|P\d{2}|S3|A[3-5]|Q[1-4]|V8|UTF8|ES20\d\d|IPv[46]|HTTP2|L[1-3]|R2|E2E|CC0|SHA\d+|MD5|X509)\b/;

const SKIP = [
  /(^|\/)(LICENSE|NOTICE|CODE_OF_CONDUCT\.md)$/,
  /^licenses\//,
  /\/vendor\//,
  /pnpm-lock\.yaml$/,
  /runtime\.generated\.ts$/,
  /migrations\/meta\//,
  /__snapshots__\//,
  /\.(ttf|woff2?|png|ico|svg)$/,
  /^scripts\/check-notes\.mjs$/,
];
const COMMENT = /^\s*(?:\/\/|\*|\/\*|\{\/\*|#|<!--|--)|\s\/\/\s/;

const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
const found = [];
for (const file of files) {
  if (SKIP.some((rx) => rx.test(file))) continue;
  let text;
  try {
    text = readFileSync(path.join(root, file), "utf8");
  } catch {
    continue;
  }
  const markdown = file.endsWith(".md");
  // A benchmark's results are dated on purpose: when each run was measured is part of the result.
  const results = file.startsWith("docs/evals/");
  text.split("\n").forEach((line, i) => {
    const rules = [...ANYWHERE, ...((markdown || COMMENT.test(line)) && !results ? IN_COMMENTS : [])];
    const hit = rules.find(([rx, why]) => {
      const all = new RegExp(rx.source, rx.flags.includes("g") ? rx.flags : `${rx.flags}g`);
      // Every match on the line: "(V8), as planned (B3)" is caught by its second.
      return [...line.matchAll(all)].some((m) => !(why.includes(" code") && NOT_CODES.test(m[0])));
    });
    if (hit) found.push(`${file}:${i + 1}: ${hit[1]}\n    ${line.trim().slice(0, 160)}`);
  });
}
if (found.length) {
  console.error(`${found.length} private note${found.length === 1 ? "" : "s"} in the code:\n\n${found.join("\n")}`);
  process.exit(1);
}
console.log(`${files.length} files checked: no private notes.`);
