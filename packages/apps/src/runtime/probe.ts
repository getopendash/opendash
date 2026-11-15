/**
 * The render check, measured in the frame (an App once drew overlapping pieces with the analyst
 * open): once the App's answers have settled, what a person would see go wrong at this width, in words the analyst
 * can fix: the page scrolling sideways (and what's too wide), pieces overlapping their neighbours, text cut off, a
 * query that came back empty or failed, an error. Heuristics, so each finding names what it measured; an overlay the
 * App meant (a popover, a sticky panel) is positioned, and positioned elements are left out.
 */

import type { OpenSpeed } from "../protocol";

export interface ProbeFinding {
  kind: "overflow" | "overlap" | "clipped" | "empty" | "failed" | "error" | "speed";
  message: string;
}

/** A query slower than this in the warehouse is said: a person waits that long each time its answer isn't kept. */
export const SLOW_QUERY_MS = 2_000;

/**
 * What makes the App slow to show its numbers, from how its answers came in (one App asked in
 * three rounds, each waiting for the one before, and took ten seconds for queries that would have taken two together;
 * another's two queries took ten seconds each in the warehouse). A query's time is the warehouse's own, kept with its
 * answer, so it says the same whether the answer was just run or read again.
 */
export function speedFindings(speed: OpenSpeed | null): ProbeFinding[] {
  if (!speed) return [];
  const out: ProbeFinding[] = [];
  if (speed.rounds > 1) {
    out.push({
      kind: "speed",
      message: `Its queries were asked for in ${speed.rounds} rounds, each waiting for the one before, so it opens as slowly as their times added up. Ask for everything a screen needs when it mounts: a piece that needs only the record's key or a filter's value takes it as a prop and asks at once, never after another query's rows arrive. (A record picked from a list's first row is the one round that has to wait.)`,
    });
  }
  for (const { query, ms } of speed.slowest.filter((q) => q.ms >= SLOW_QUERY_MS).slice(0, 5)) {
    out.push({
      kind: "speed",
      message: `${query} took ${(ms / 1000).toFixed(1)} s in the warehouse: everyone who opens the App waits that long when its answer isn't kept. Make it cheaper (a narrower period, fewer joins, a dataset that already groups it).`,
    });
  }
  return out;
}

/** A piece of the page in words: its tag, its first class names, the start of its text. */
function describe(el: Element): string {
  const cls = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).slice(0, 3).join(".");
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  return `<${el.tagName.toLowerCase()}${cls ? ` class="${cls}"` : ""}>${text ? ` “${text}${text.length >= 40 ? "…" : ""}”` : ""}`;
}

const positioned = (el: Element) => {
  const p = getComputedStyle(el).position;
  return p === "absolute" || p === "fixed" || p === "sticky";
};
const visible = (r: DOMRect) => r.width > 1 && r.height > 1;

/**
 * What's wrong on this page at its width. `states` is each query's last state (from the App's readiness), so an empty
 * or failed one is named too.
 */
export function probe(
  root: Element,
  states: Record<string, { state: string; error?: string }>,
  width: number,
): ProbeFinding[] {
  const out: ProbeFinding[] = [];
  const at = `at ${width}px`;
  const doc = document.documentElement;
  const elements = [...root.querySelectorAll("*")].slice(0, 2500);

  // Sideways: the page wider than the window, and the outermost things that make it so.
  if (doc.scrollWidth > window.innerWidth + 1) {
    const wide = elements
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return visible(r) && r.right > window.innerWidth + 1 && !positioned(el);
      })
      .filter((el, _i, all) => !all.some((o) => o !== el && o.contains(el)))
      .slice(0, 3);
    out.push({
      kind: "overflow",
      message: `The page scrolls sideways ${at} (${doc.scrollWidth}px wide): ${wide.map(describe).join("; ") || "something"} reaches past its edge.`,
    });
  }

  // Overlaps: neighbours in the same parent whose boxes cross (laid out, not positioned on purpose).
  const seen = new Set<string>();
  for (const parent of [root, ...elements]) {
    const kids = [...parent.children].filter((k) => !positioned(k));
    if (kids.length < 2 || kids.length > 60) continue;
    const boxes = kids.map((k) => ({ k, r: k.getBoundingClientRect() })).filter((b) => visible(b.r));
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        if (!a || !b) continue;
        const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (w > 4 && h > 4) {
          const key = `${describe(a.k)}|${describe(b.k)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            kind: "overlap",
            message: `${describe(a.k)} and ${describe(b.k)} overlap ${at} (${Math.round(w)}×${Math.round(h)}px).`,
          });
        }
      }
    }
    if (out.filter((f) => f.kind === "overlap").length >= 5) break;
  }

  // Cut off: a box that hides overflow and has more than it shows, without saying so with an ellipsis or a scroll.
  for (const el of elements) {
    if (out.filter((f) => f.kind === "clipped").length >= 5) break;
    const s = getComputedStyle(el);
    const hides = (v: string) => v === "hidden" || v === "clip";
    if (!(hides(s.overflowX) || hides(s.overflowY)) || s.textOverflow === "ellipsis") continue;
    // Text hidden on purpose for a screen reader (a 1px clipped box) is never "cut off".
    if (
      el.clientWidth <= 1 ||
      el.clientHeight <= 1 ||
      s.clip === "rect(0px, 0px, 0px, 0px)" ||
      s.clipPath === "inset(50%)"
    )
      continue;
    if (!(el.textContent ?? "").trim()) continue;
    const cutX = hides(s.overflowX) && el.scrollWidth > el.clientWidth + 2;
    const cutY = hides(s.overflowY) && el.scrollHeight > el.clientHeight + 2;
    if (cutX || cutY) {
      out.push({ kind: "clipped", message: `${describe(el)} is cut off ${at}: its content is bigger than its box.` });
    }
  }

  // Answers: an App query that came back empty or failed, and the App's own errors.
  for (const [id, s] of Object.entries(states)) {
    const query = id.startsWith("query:") ? id.slice("query:".length) : id;
    if (s.state === "empty") out.push({ kind: "empty", message: `${query} returned no rows ${at}.` });
    else if (s.state === "error")
      out.push({
        kind: id === "app" ? "error" : "failed",
        message:
          id === "app" ? `The App hit an error: ${s.error ?? "unknown"}.` : `${query} failed: ${s.error ?? "unknown"}.`,
      });
  }
  return out;
}
