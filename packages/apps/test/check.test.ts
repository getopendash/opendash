// An App's code, checked before a draft with it is saved: typed against the runtime and the App's own ids, and held to
// the rules that keep the frame safe. Then the runtime every frame loads, and the frame document.
import { describe, expect, it } from "vitest";
import { checkParts, describeProblems } from "../src/check/check";
import { runtime } from "../src/check/runtime";
import { frameDocument } from "../src/frame";
import { RUNTIME_HASH, RUNTIME_JS } from "../src/runtime.generated";
import { proof } from "./fixtures/proof";

const one = (source: string) => ({ files: { "/App.tsx": source }, definition: proof() });

describe("an App's code", () => {
  it("refuses a query or filter the App doesn't have, and a column its query doesn't return, as a type error", async () => {
    const src = `import { useFilter, useQuery } from "@opendash/app";
export default function App() { const r = useQuery("q_accounts"); r.cell(0, "seats"); useQuery("q_payroll"); useFilter("f_region"); return null; }`;
    const problems = describeProblems(await checkParts(one(src)));
    expect(problems).toMatch(/q_payroll/);
    expect(problems).toMatch(/f_region/);
    expect(problems).toMatch(/seats/);
  });

  it.each([
    ["fetch", `export default function App() { fetch("https://evil.test"); return null; }`, /fetch/],
    ["a link", `export default function App() { return <a href="https://evil.test">x</a>; }`, /<a>/],
    ["innerHTML", `export default function App() { document.body.innerHTML = "<b>x</b>"; return null; }`, /innerHTML/],
    ["an import", `import x from "lodash"; export default function App() { return <p>{String(x)}</p>; }`, /lodash/],
    [
      "the kit's old runtime",
      `import { useNamedQuery } from "@opendash/app-runtime"; export default function App() { useNamedQuery("q_mrr"); return null; }`,
      /app-runtime/,
    ],
    ["a typed figure", `export default function App() { return <p>Revenue was $1,200,000 last year</p>; }`, /figure/],
    [
      "numbers in an array",
      `export default function App() { const v = [120, 340, 560]; return <p>{v.length}</p>; }`,
      /useQuery/,
    ],
    ["a colour", `export default function App() { return <p style={{ color: "#ff0000" }}>x</p>; }`, /colour/],
    ["storage", `export default function App() { localStorage.setItem("a", "b"); return null; }`, /localStorage/],
    [
      "navigating away",
      `export default function App() { location.href = "https://evil.test/?d=1"; return null; }`,
      /location/,
    ],
    [
      "a computed global",
      `export default function App() { (window as any)["fe" + "tch"]("x"); return null; }`,
      /window\[/,
    ],
    ["the document", `export default function App() { document.title = "x"; return null; }`, /document/],
  ])("refuses %s", async (_name, src, why) => {
    const result = await checkParts(one(src));
    expect(result.ok).toBe(false);
    expect(describeProblems(result)).toMatch(why);
  });

  it("names the file and line of a type error", async () => {
    const result = await checkParts({
      files: {
        "/App.tsx": `import { X } from "./lib/x";\nexport default function App() { return <p>{X}</p>; }`,
        "/lib/x.ts": `export const X: number = "nope";`,
      },
      definition: proof(),
    });
    expect(result.errors.some((e) => e.file === "/lib/x.ts" && e.line === 1)).toBe(true);
  });
});

describe("the runtime and the frame", () => {
  it("builds the runtime once, with the kit's styles and both themes inside", async () => {
    const built = await runtime();
    expect(built.hash).toMatch(/^[0-9a-f]{32}$/);
    expect(built.js).toContain("__OD_APP__");
    // Apps bundled by an older runtime read React from __OD_RUNTIME__: removing it blanked every stored App.
    expect(built.js).toContain("__OD_RUNTIME__");
    expect(built.js).toContain('[data-theme="dark"]');
    expect(await runtime()).toBe(built);
  });

  it("is generated up to date (run `pnpm --filter @opendash/apps build:runtime` after changing src/runtime)", async () => {
    const built = await runtime();
    expect(RUNTIME_HASH).toBe(built.hash);
    expect(RUNTIME_JS.length).toBe(built.js.length);
  });

  it("serves a frame with no network, shown only by OpenDash, the App's bundle only when it has one", () => {
    const input = {
      framesOrigin: "http://127.0.0.1:3000",
      hostOrigin: "http://localhost:3000",
      runtimeHash: "r".repeat(32),
      bundleHash: "b".repeat(64),
      title: "<script>x</script>",
    };
    const { html, headers } = frameDocument(input);
    const csp = headers["content-security-policy"] ?? "";
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors http://localhost:3000");
    expect(csp).toContain("default-src 'none'");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain(`http://127.0.0.1:3000/app-frame/b/${"b".repeat(64)}/parts.js`);
    expect(frameDocument({ ...input, bundleHash: null }).html).not.toContain("parts.js");
    // Both scripts are deferred, the runtime written first: fetched side by side, run in that order.
    const scripts = [...html.matchAll(/<script ([^>]*)>/g)].map((m) => m[1] ?? "");
    expect(scripts).toHaveLength(2);
    expect(scripts.every((s) => s.startsWith("defer src="))).toBe(true);
    expect(scripts[0]).toContain("/runtime.js");
    expect(scripts[1]).toContain("/parts.js");
  });
});

describe("an App's file paths", () => {
  it("takes any folders of plain names, and says what's wrong with the rest", async () => {
    const { appPathProblem } = await import("../src/check/check");
    for (const ok of ["/App.tsx", "/pages/Today.tsx", "/views/customer/Panel.tsx", "/styles.css", "/lib/format.ts"])
      expect(appPathProblem(ok)).toBeNull();
    expect(appPathProblem("App.tsx")).toMatch(/starts at the App's root/);
    expect(appPathProblem("/a/b/c/D.tsx")).toMatch(/2 folders deep/);
    expect(appPathProblem("/notes.md")).toMatch(/\.tsx, \.ts, \.css/);
    expect(appPathProblem("/pages/../App.tsx")).toMatch(/plain|letters/);
    expect(appPathProblem("/my page/X.tsx")).toMatch(/letters/);
  });

  it("are at most 40, of 300,000 characters together: past that they're too big to build or keep", async () => {
    const { oversize } = await import("../src/check/limits");
    const files = (n: number, chars: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`/P${i}.tsx`, "x".repeat(chars)]));
    expect(oversize(files(40, 7_500))).toBeNull();
    expect(oversize(files(41, 1))).toMatch(/at most 40 files; this one has 41/);
    expect(oversize(files(6, 50_001))).toMatch(/at most 300,000 characters together; these have 300,006/);
  });
});
