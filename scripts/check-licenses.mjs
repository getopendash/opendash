// Checks the resolved dependency tree against the licence policy (docs/operations/LICENSING.md §5): permissive
// licences pass; anything else must be a listed exception with a reason. Run by CI as `pnpm check:licenses`.
import { execFileSync } from "node:child_process";

/** SPDX ids that pass on their own. */
const ALLOWED = new Set([
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "Zlib",
  "BlueOak-1.0.0",
  "Python-2.0",
]);

/**
 * Packages allowed with a licence that isn't in ALLOWED. A name ending in `*` matches any package that starts with it
 * (the platform packages differ between machines). Each needs a reason; a new one needs a note in the pull request.
 */
const EXCEPTIONS = [
  { name: "@resvg/resvg-js*", why: "MPL-2.0 (file-level copyleft); used unmodified to draw charts in report PDFs" },
  { name: "lightningcss*", why: "MPL-2.0 (file-level copyleft); a build tool, used unmodified" },
  {
    name: "@img/sharp-libvips-*",
    why: "LGPL-3.0; the prebuilt libvips library that Next.js installs through sharp, loaded dynamically and unmodified",
  },
  { name: "caniuse-lite", why: "CC-BY-4.0; browser data used at build time" },
  { name: "geist", why: "SIL Open Font License; font files, whose license text ships beside them" },
  {
    name: "xml-escape",
    why: 'MIT, spelled "MIT License" in its package.json (its LICENSE file is the MIT text); SAML in ee/',
  },
];

/** Whether an SPDX expression ("MIT", "(MIT OR CC0-1.0)", "(MIT AND Zlib)") is allowed. */
function allowed(expression) {
  const text = expression.replace(/[()]/g, " ").trim();
  return text
    .split(/\s+OR\s+/i)
    .some((alternative) => alternative.split(/\s+AND\s+/i).every((id) => ALLOWED.has(id.trim())));
}

const excepted = (name) =>
  EXCEPTIONS.find((e) => (e.name.endsWith("*") ? name.startsWith(e.name.slice(0, -1)) : name === e.name));

const listing = JSON.parse(
  execFileSync("pnpm", ["licenses", "list", "--json"], { encoding: "utf8", maxBuffer: 1 << 28 }),
);

const problems = [];
const used = new Set();
let count = 0;
for (const [licence, packages] of Object.entries(listing)) {
  for (const pkg of packages) {
    count += 1;
    if (allowed(licence)) continue;
    const exception = excepted(pkg.name);
    if (exception) {
      used.add(exception.name);
      continue;
    }
    problems.push(`${pkg.name}@${pkg.versions.join(",")}: ${licence}`);
  }
}

for (const e of EXCEPTIONS) {
  if (!used.has(e.name)) console.log(`note: exception "${e.name}" matched nothing on this machine (${e.why})`);
}
if (problems.length) {
  console.error(`${problems.length} of ${count} packages have a licence outside the policy:`);
  for (const line of problems) console.error(`  ${line}`);
  console.error("Allow it only with a reason in scripts/check-licenses.mjs and a note in the pull request.");
  process.exit(1);
}
console.log(`${count} packages checked: every licence is allowed or a listed exception.`);
