// Tailwind writes only the classes it finds in the folders the stylesheet names. When components move to another
// package while the stylesheet still names their old folder, their classes are never written: a dashboard's rows once
// lost their grid that way, and every tile took a whole row. Every folder named must exist, and every workspace package
// the web app renders components from must be named.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const web = path.resolve(import.meta.dirname, "..");
const root = path.resolve(web, "../..");
const stylesheet = path.join(web, "app/globals.css");
const sources = [...readFileSync(stylesheet, "utf8").matchAll(/^@source "([^"]+)";$/gm)].map((m) =>
  path.resolve(path.dirname(stylesheet), m[1] ?? ""),
);

const hasComponents = (dir: string): boolean =>
  existsSync(dir) &&
  readdirSync(dir).some((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? name !== "node_modules" && hasComponents(full) : name.endsWith(".tsx");
  });

describe("the stylesheet's sources", () => {
  it("are folders that exist", () => {
    expect(sources.length).toBeGreaterThan(0);
    for (const dir of sources) expect(existsSync(dir) && statSync(dir).isDirectory(), dir).toBe(true);
  });

  it("include every workspace package the web app takes components from", () => {
    const deps = Object.keys(
      (JSON.parse(readFileSync(path.join(web, "package.json"), "utf8")) as { dependencies: Record<string, string> })
        .dependencies,
    ).filter((d) => d.startsWith("@opendash/"));
    const packages = readdirSync(path.join(root, "packages")).flatMap((dir) => {
      const file = path.join(root, "packages", dir, "package.json");
      return existsSync(file) ? [{ name: (JSON.parse(readFileSync(file, "utf8")) as { name: string }).name, dir }] : [];
    });
    // An App's runtime renders only inside its frame, styled by its own kit.css: the web app takes its protocol only.
    const frameOnly = new Set(["@opendash/apps"]);
    const rendered = packages.filter(
      (p) =>
        deps.includes(p.name) && !frameOnly.has(p.name) && hasComponents(path.join(root, "packages", p.dir, "src")),
    );
    expect(rendered.map((p) => p.name)).toContain("@opendash/ui");
    for (const p of rendered) {
      const src = path.join(root, "packages", p.dir, "src");
      expect(
        sources.some((s) => src === s || src.startsWith(`${s}${path.sep}`)),
        `${p.name} isn't in globals.css's @source`,
      ).toBe(true);
    }
  });
});
