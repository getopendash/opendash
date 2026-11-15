// A page lays out by the room its sheet has, not the window's width: with the analyst's panel open the
// sheet is 420 narrower, so a window breakpoint (lg:flex-row) lays out a page for room it doesn't have. Inside the
// sheet, layouts use its container's variants (@5xl/page:flex-row). The shell, the panel, the auth and public screens,
// and the dev gallery are the window's, and keep its breakpoints.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..", "..");
const SCANNED = ["apps/web/components", "apps/web/app", "packages/ui/src/components"];
const WINDOWS = [
  "apps/web/components/shell/",
  "apps/web/components/auth/",
  "apps/web/app/(auth)/",
  // The guided setup (/get-started) fills the window too.
  "apps/web/components/onboarding/",
  "apps/web/app/(onboarding)/",
  "apps/web/app/(public)/",
  "apps/web/app/dev/",
  "packages/ui/src/components/side-panel.tsx",
];
/** A window breakpoint on a utility, as Tailwind reads one in a class list: `lg:flex-row`, `md:table-cell`. */
const BREAKPOINT = /(?<=[\s"'`{(])(?:sm|md|lg|xl|2xl):[A-Za-z0-9_\-/.[\]]+/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(tsx|ts)$/.test(name) ? [path] : [];
  });
}

describe("page layouts", () => {
  it("use the page sheet's container variants, not the window's breakpoints", () => {
    const found = SCANNED.flatMap((dir) => files(join(root, dir)))
      .map((path) => relative(root, path))
      .filter((path) => !WINDOWS.some((w) => path.startsWith(w)))
      .flatMap((path) =>
        readFileSync(join(root, path), "utf8")
          .split("\n")
          .flatMap((line, i) => (line.match(BREAKPOINT) ?? []).map((cls) => `${path}:${i + 1} ${cls}`)),
      );
    expect(found).toEqual([]);
  });
});
