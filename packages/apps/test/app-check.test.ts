// An App's files checked as one (apps as code): /App.tsx its entry, its components and stylesheet, Tailwind compiled
// from the classes it uses into the bundle, imports closed to its own files, react and @opendash/app.
import { describe, expect, it } from "vitest";
import { checkParts } from "../src/check/check";
import { candidatesOf, stylesProblems } from "../src/check/css";
import { SUPPORT_DESK_FILES, supportDeskManifest } from "../src/examples";
import { proof } from "./fixtures/proof";

const definition = proof;

const files = {
  "/App.tsx": `import { Queue } from "./components/Queue";
export default function App() {
  return <main className="grid gap-4 p-6 @container bg-surface text-foreground"><Queue /></main>;
}`,
  "/components/Queue.tsx": `export function Queue() {
  return <ul className="divide-y divide-border rounded-xl border border-border @lg:grid-cols-[280px_1fr]"><li className="px-3 py-2 text-sm">One</li></ul>;
}`,
  "/styles.css": ".queue { scrollbar-gutter: stable; }",
};

describe("an App's check", () => {
  it("bundles its page with Tailwind for the classes it uses and its own stylesheet inside", async () => {
    const r = await checkParts({ files, definition: definition() });
    expect(r.errors).toEqual([]);
    expect(r.bundle).toContain("registerApp");
    // The classes it uses, in its theme's colours, and its own rule.
    expect(r.bundle).toContain("280px 1fr");
    expect(r.bundle).toContain("var(--surface)");
    expect(r.bundle).toContain("scrollbar-gutter");
    expect(r.bundle).not.toContain(".grid-cols-12");
  });

  it("refuses files an App doesn't have, imports from elsewhere, and a stylesheet that loads things", async () => {
    const odd = await checkParts({
      files: { ...files, "/notes.md": "x", "/my page/Home.tsx": "export default 1;" },
      definition: definition(),
    });
    const said = odd.errors.map((e) => `${e.file} ${e.message}`).join("\n");
    expect(said).toMatch(/\/notes\.md A file is \.tsx, \.ts, \.css/);
    expect(said).toMatch(/\/my page\/Home\.tsx Folder and file names are letters/);
    const imported = await checkParts({
      files: {
        ...files,
        "/App.tsx": `import x from "lodash";\nexport default function App() { return <p>{String(x)}</p>; }`,
      },
      definition: definition(),
    });
    expect(imported.errors.map((e) => e.message).join("\n")).toMatch(/imports its own files, react and @opendash\/app/);
    expect(stylesProblems('@import "https://x.test/a.css";')).toEqual([expect.stringMatching(/imports nothing/)]);
    expect(stylesProblems(".a { background: url(https://x.test/i.png) }")).toEqual([
      expect.stringMatching(/loads nothing from outside/),
    ]);
    expect(stylesProblems(".a { background: url(data:image/png;base64,AAA) }")).toEqual([]);
  });

  it("finds class names in its code", () => {
    expect(candidatesOf({ "/App.tsx": 'className="p-4 @md:flex hover:bg-accent/10"' })).toEqual(
      expect.arrayContaining(["p-4", "@md:flex", "hover:bg-accent/10"]),
    );
    // Arbitrary values with commas, and classes built from strings joined in code.
    const built = candidatesOf({
      "/App.tsx":
        'const c = "grid grid-cols-[minmax(0,1fr)_auto] " + (on ? "bg-accent-soft" : "");\n<b className="@3xl:grid-cols-[minmax(280px,1fr)_minmax(0,2fr)]" />',
    });
    expect(built).toEqual(
      expect.arrayContaining([
        "grid-cols-[minmax(0,1fr)_auto]",
        "bg-accent-soft",
        "@3xl:grid-cols-[minmax(280px,1fr)_minmax(0,2fr)]",
      ]),
    );
  });

  it("passes the reference App whole: its bundle, its types against its own queries, and the rules", async () => {
    const r = await checkParts({
      files: SUPPORT_DESK_FILES,
      definition: supportDeskManifest("01a126d7-d169-7342-b819-0382f3cb5bff"),
    });
    expect([
      ...r.errors.map((e) => `${e.file}:${e.line} ${e.message}`),
      ...r.rules.map((x) => `${x.file}:${x.line} [${x.rule}] ${x.message}`),
    ]).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
