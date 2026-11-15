// Select to edit, the frame's half: while the page has pick mode on, what the pointer is over is outlined (by the
// runtime, over the App, never by changing the App's own elements), and a click selects it instead of doing what it
// would: the frame tells the page the nearest marked element's mark, tag and short text. Escape leaves pick mode and
// says so. Nothing is selected while pick mode is off. Written against a small slice of the DOM so the rules can be
// tested without a browser.
import { FRAME_METHODS, type Picked } from "../protocol";
import { SELECTED_TAG_MAX, SOURCE_ATTRIBUTE, selectedText } from "../select";

/** The part of an element the picker reads. */
export interface PickElement {
  closest(selector: string): PickElement | null;
  getAttribute(name: string): string | null;
  readonly localName: string;
  readonly textContent: string | null;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

/** What a pointer event or a click is to the picker. */
export interface PickEvent {
  target: unknown;
  preventDefault(): void;
  stopImmediatePropagation(): void;
}

export interface PickEnv {
  post(method: string, params: unknown): void;
  /** The revision drawn now (a selection names it: the page takes only the one it drew). */
  revision(): string | null;
  /** Outline this box, or none. */
  outline(box: { left: number; top: number; width: number; height: number } | null): void;
  /** Pick mode is on or off: the frame shows it (a crosshair). */
  shown(on: boolean): void;
}

const MARKED = `[${SOURCE_ATTRIBUTE}]`;

const isElement = (x: unknown): x is PickElement =>
  typeof x === "object" && x !== null && typeof (x as PickElement).closest === "function";

/**
 * What a click on `target` selects: the nearest marked element around it (an App's components aren't marked, nor
 * what the runtime draws inside them, so clicking in a chart selects what the App wrapped it in). A click with no mark
 * anywhere above it (a bundle built before marks) still answers, with no `src`, so the page can say why.
 */
export function selectionOf(target: unknown, revision: string): Picked | null {
  if (!isElement(target)) return null;
  const marked = target.closest(MARKED);
  const element = marked ?? target;
  const src = marked?.getAttribute(SOURCE_ATTRIBUTE) ?? null;
  return {
    revision,
    ...(src ? { src } : {}),
    tag: String(element.localName ?? "").slice(0, SELECTED_TAG_MAX),
    text: selectedText(element.textContent ?? ""),
  };
}

/** Events a click is made of: while picking, none of them reach the App (one acting on pointerdown would still run). */
export const BLOCKED_EVENTS = [
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "click",
  "dblclick",
  "auxclick",
  "contextmenu",
  "touchstart",
  "touchend",
] as const;

export function createPicker(env: PickEnv) {
  let on = false;
  let hovered: PickElement | null = null;
  const outline = () => {
    const el = hovered?.closest(MARKED) ?? null;
    env.outline(el ? el.getBoundingClientRect() : null);
  };
  const set = (next: boolean) => {
    if (next === on) return;
    on = next;
    hovered = null;
    env.outline(null);
    env.shown(on);
  };
  return {
    get on() {
      return on;
    },
    set,
    /** The pointer moved over `target`. */
    move(target: unknown) {
      if (!on) return;
      hovered = isElement(target) ? target : null;
      outline();
    },
    /** The page scrolled or resized: the outline follows what it's on. */
    reflow() {
      if (on && hovered) outline();
    },
    /** A press, release or click: kept from the App while picking; a click selects. True when it was kept. */
    press(type: string, e: PickEvent): boolean {
      if (!on) return false;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (type !== "click") return true;
      const revision = env.revision();
      const picked = revision ? selectionOf(e.target, revision) : null;
      if (picked) env.post(FRAME_METHODS.picked, picked);
      return true;
    },
    /** A key: Escape leaves pick mode and tells the page. True when it was kept from the App. */
    key(key: string, e: PickEvent): boolean {
      if (!on || key !== "Escape") return false;
      e.preventDefault();
      e.stopImmediatePropagation();
      set(false);
      env.post(FRAME_METHODS.pickEnd, {});
      return true;
    },
  };
}
