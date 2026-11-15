// Select to edit (the build and the frame): the App's JSX is compiled in development form, the runtime's adapter marks
// each DOM element with the file and line it was written at (never a component, never React's own jsxDEV), keeping
// keys and refs; the frame selects only in pick mode, the nearest marked element, and Escape leaves.
import { createElement, createRef, type ReactElement } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { checkParts } from "../src/check/check";
import { SUPPORT_DESK_FILES } from "../src/examples";
import { FRAME_METHODS } from "../src/protocol";
import { Fragment, jsxDEV, sourceMark } from "../src/runtime/jsx-dev";
import { createPicker, type PickElement, selectionOf } from "../src/runtime/pick";
import { parseSourceMark, selectionLabel } from "../src/select";
import { proof } from "./fixtures/proof";

/** A component that draws nothing, as one an App defines. */
const Queue = () => null;

const files = {
  "/App.tsx": `import { Queue } from "./components/Queue";
export default function App() {
  return <main className="p-6"><Queue items={["#4656 urgent", "#4657"]} /></main>;
}`,
  "/components/Queue.tsx": `export function Queue({ items }: { items: string[] }) {
  return (
    <ul>
      {items.map((t) => <li key={t}>{t}</li>)}
      <>tail</>
    </ul>
  );
}`,
};

/** Runs a bundle as the frame would, with the runtime's React and adapter, and draws the App it registers. */
function drawBundle(bundle: string): string {
  let App: (() => ReactElement) | null = null;
  const window = {
    __OD_APP__: {
      React: { createElement },
      jsxRuntime,
      jsxDevRuntime: { jsxDEV, Fragment },
      registerApp: (app: () => ReactElement) => {
        App = app;
      },
    },
  };
  new Function("window", bundle)(window);
  if (!App) throw new Error("the bundle registered no App");
  return renderToStaticMarkup(createElement(App));
}

describe("the build marks where each element was written", () => {
  it("stamps DOM elements with their file, line and column, and leaves components unmarked", async () => {
    const r = await checkParts({ files, definition: proof() });
    expect(r.errors).toEqual([]);
    expect(r.bundle).toContain("jsxDEV");
    const html = drawBundle(r.bundle as string);
    expect(html).toContain('<main class="p-6" data-od-src="/App.tsx:3:10">');
    expect(html).toContain('<ul data-od-src="/components/Queue.tsx:3:5">');
    expect(html).toContain('<li data-od-src="/components/Queue.tsx:4:25">#4656 urgent</li>');
    // A component (Queue) and a fragment draw no element of their own: nothing else carries a mark.
    expect(html.match(/data-od-src=/g)).toHaveLength(4);
    expect(html).toContain("tail");
  });

  it("measures what the marks cost a real App's bundle", async () => {
    const r = await checkParts({ files: SUPPORT_DESK_FILES, definition: proof() });
    expect(r.bundle).toContain('fileName:"app:/App.tsx"');
    // Under the bundle's limit with room to spare (the marks add a file name and two numbers per element).
    expect(r.bytes).toBeLessThan(200_000);
  });
});

describe("the frame's JSX adapter", () => {
  const at = { fileName: "app:/components/Queue.tsx", lineNumber: 42, columnNumber: 7 };

  it("marks a DOM element, keeping its key, ref and children, and makes it with the production jsx", () => {
    const ref = createRef<HTMLLIElement>();
    const el = jsxDEV("li", { ref, className: "row", children: "#4656" }, "k1", false, at, undefined) as ReactElement<
      Record<string, unknown>
    >;
    expect(el.type).toBe("li");
    expect(el.key).toBe("k1");
    expect(el.props).toEqual({ ref, className: "row", children: "#4656", "data-od-src": "/components/Queue.tsx:42:7" });
    // An App's own mark can't stand in for the build's.
    const forged = jsxDEV("li", { "data-od-src": "/App.tsx:1:1" }, undefined, false, at) as ReactElement<
      Record<string, unknown>
    >;
    expect(forged.props["data-od-src"]).toBe("/components/Queue.tsx:42:7");
  });

  it("leaves a component's props as written, and an element with no source unmarked", () => {
    const el = jsxDEV(Queue, { items: [] }, undefined, false, at) as ReactElement<Record<string, unknown>>;
    expect(el.props).toEqual({ items: [] });
    expect(el.key).toBeNull();
    expect(sourceMark(undefined)).toBeNull();
    const plain = jsxDEV("p", { children: ["a", "b"] }, undefined, true, undefined) as ReactElement<
      Record<string, unknown>
    >;
    expect(plain.props).toEqual({ children: ["a", "b"] });
  });
});

/** An element as the picker sees it, with a parent chain for closest(). */
function element(tag: string, attrs: Record<string, string>, text: string, parent: PickElement | null = null) {
  const el: PickElement = {
    localName: tag,
    textContent: text,
    getAttribute: (n) => attrs[n] ?? null,
    getBoundingClientRect: () => ({ left: 1, top: 2, width: 3, height: 4 }),
    // Only the one selector the picker asks for.
    closest: (selector) =>
      selector === "[data-od-src]" ? ("data-od-src" in attrs ? el : (parent?.closest(selector) ?? null)) : null,
  };
  return el;
}

const event = (target: unknown) => {
  const seen = { prevented: false, stopped: false };
  return {
    seen,
    target,
    preventDefault: () => {
      seen.prevented = true;
    },
    stopImmediatePropagation: () => {
      seen.stopped = true;
    },
  };
};

describe("the frame in pick mode", () => {
  const row = element("li", { "data-od-src": "/components/Queue.tsx:42:7" }, "  #4656\n   urgent  ");
  // Something the runtime draws inside a component (a chart's canvas): no mark of its own.
  const inside = element("span", {}, "#4656", row);

  const picker = () => {
    const posted: { method: string; params: unknown }[] = [];
    const outlined: unknown[] = [];
    const p = createPicker({
      post: (method, params) => posted.push({ method, params }),
      revision: () => "rev-1",
      outline: (box) => outlined.push(box),
      shown: () => {},
    });
    return { p, posted, outlined };
  };

  it("selects nothing while pick mode is off: the click goes to the App", () => {
    const { p, posted } = picker();
    const e = event(inside);
    expect(p.press("click", e)).toBe(false);
    expect(e.seen).toEqual({ prevented: false, stopped: false });
    expect(posted).toEqual([]);
  });

  it("outlines what's under the pointer, and a click selects the nearest marked element, kept from the App", () => {
    const { p, posted, outlined } = picker();
    p.set(true);
    p.move(inside);
    expect(outlined.at(-1)).toEqual({ left: 1, top: 2, width: 3, height: 4 });
    const down = event(inside);
    expect(p.press("pointerdown", down)).toBe(true);
    expect(down.seen).toEqual({ prevented: true, stopped: true });
    expect(posted).toEqual([]);
    p.press("click", event(inside));
    expect(posted).toEqual([
      {
        method: FRAME_METHODS.picked,
        params: { revision: "rev-1", src: "/components/Queue.tsx:42:7", tag: "li", text: "#4656 urgent" },
      },
    ]);
  });

  it("says so when nothing under the click is marked (a bundle built before marks)", () => {
    expect(selectionOf(element("div", {}, "old"), "rev-1")).toEqual({ revision: "rev-1", tag: "div", text: "old" });
    expect(selectionOf("not an element", "rev-1")).toBeNull();
  });

  it("leaves on Escape, tells the page, and lets keys through otherwise", () => {
    const { p, posted } = picker();
    expect(p.key("Escape", event(null))).toBe(false);
    p.set(true);
    expect(p.key("Enter", event(null))).toBe(false);
    expect(p.key("Escape", event(null))).toBe(true);
    expect(p.on).toBe(false);
    expect(posted).toEqual([{ method: FRAME_METHODS.pickEnd, params: {} }]);
  });
});

describe("a selection's mark and chip", () => {
  it("reads a mark's file, line and column, and refuses anything else", () => {
    expect(parseSourceMark("/components/Queue.tsx:42:7")).toEqual({
      file: "/components/Queue.tsx",
      line: 42,
      column: 7,
    });
    for (const bad of [
      "components/Queue.tsx:42:7",
      "/components/Queue.tsx:0:1",
      "/styles.css:3:1",
      "/../etc/passwd.ts:1:1",
      "/a/b/c/d.tsx:1:1",
      "/App.tsx:1",
      "/App.tsx:1:1:1",
      `/${"a".repeat(300)}.tsx:1:1`,
      42,
    ]) {
      expect(parseSourceMark(bad)).toBeNull();
    }
  });

  it("names the piece by what it shows and where, in the person's words", () => {
    expect(selectionLabel({ file: "/components/Queue.tsx", text: "#4656 urgent" })).toBe("‘#4656 urgent’ in Queue");
    expect(selectionLabel({ file: "/App.tsx", text: "", component: "App" })).toBe("App");
  });
});
