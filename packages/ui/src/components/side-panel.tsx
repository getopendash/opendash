"use client";

import { Button } from "@heroui/react";
import { ArrowLeft, X } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/** How narrow and how wide its person may drag it. */
const PANEL_MIN = 360;
const PANEL_MAX = 720;

/**
 * The second sheet (an inspector): beside the page on a wide screen, on the app background with
 * its own hairline and radius, and over the page below lg, where there's no room for two. Its header names what it
 * holds; what opens from it stacks one level, with a back arrow.
 *
 * Opening and closing (motion): with `animate`, it eases open beside the page (its width from nothing) or
 * slides in over it, and back; its content keeps its own width, so nothing inside reflows. Closed, it leaves the page
 * (display: none) once it has finished closing, and stays mounted, so a conversation in it goes on following its run.
 */
export function SidePanel({
  title,
  subtitle,
  icon,
  back,
  actions,
  onClose,
  closeLabel = "Close",
  wide = false,
  hidden = false,
  animate = false,
  resizeKey,
  children,
}: {
  title: string;
  /** What it's about, after the title ("· A plan filter on Customer usage"). */
  subtitle?: string | null;
  icon?: ReactNode;
  /** Stacked one level: back to what it came from ("Ask /"). */
  back?: { crumb: string; onPress: () => void } | null;
  /** Buttons before Close. */
  actions?: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  /** 640 rather than 420 (on a screen of 1536px or more): SQL, a trace, History. */
  wide?: boolean;
  /** Closed, though what it holds stays mounted (a conversation still following its run). */
  hidden?: boolean;
  /** Opens, closes and widens smoothly: once someone has opened or closed it (not when a reload brings it back). */
  animate?: boolean;
  /**
   * Its person may drag its edge to widen it (360–720 px, on a wide screen), remembered under this key in their
   * browser. Without it, it keeps its sizes.
   */
  resizeKey?: string;
  children: ReactNode;
}) {
  // In the page at all (not display: none), and open (its full width, or slid in): opening shows it closed for a frame
  // so it has somewhere to ease from; closing waits for the close to finish before it leaves the page.
  const [present, setPresent] = useState(!hidden);
  const [open, setOpen] = useState(!hidden);
  const self = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!hidden) {
      setPresent(true);
      return;
    }
    setOpen(false);
    const leave = setTimeout(() => setPresent(false), animate ? 320 : 0);
    return () => clearTimeout(leave);
  }, [hidden, animate]);
  // Once it's in the page, closed: its closed size is measured (so the browser has it to ease from), then it opens.
  useLayoutEffect(() => {
    if (!present || hidden || open) return;
    self.current?.getBoundingClientRect();
    setOpen(true);
  }, [present, hidden, open]);
  // The width its person dragged it to, if they did (wide screens only): read once, kept as they drag.
  const [dragged, setDragged] = useState<number | null>(null);
  const [roomy, setRoomy] = useState(false);
  useEffect(() => {
    if (!resizeKey) return;
    const lg = matchMedia("(min-width: 1024px)");
    const update = () => setRoomy(lg.matches);
    update();
    lg.addEventListener("change", update);
    try {
      const saved = Number(localStorage.getItem(resizeKey));
      if (saved >= PANEL_MIN && saved <= PANEL_MAX) setDragged(saved);
    } catch {
      // Storage off: its default width.
    }
    return () => lg.removeEventListener("change", update);
  }, [resizeKey]);
  const custom = resizeKey && roomy && dragged !== null && !wide ? dragged : null;
  // A drag in progress: the pointer is captured by the separator (so moving over the dashboard's frame beside it never
  // loses it), and ended on release, cancel or unmount.
  const drag = useRef<{ startX: number; startW: number; last: number } | null>(null);
  const endDrag = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || !resizeKey) return;
    try {
      localStorage.setItem(resizeKey, String(d.last));
    } catch {
      // Kept for this visit only.
    }
  };
  useEffect(
    () => () => {
      drag.current = null;
    },
    [],
  );
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeKey) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const startW = self.current?.getBoundingClientRect().width ?? 420;
    drag.current = { startX: e.clientX, startW, last: startW };
  };
  const moveDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.last = Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, d.startW + (d.startX - e.clientX))));
    setDragged(d.last);
  };
  const nudge = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!resizeKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const now = dragged ?? self.current?.getBoundingClientRect().width ?? 420;
    const next = Math.min(PANEL_MAX, Math.max(PANEL_MIN, now + (e.key === "ArrowLeft" ? 24 : -24)));
    setDragged(next);
    try {
      localStorage.setItem(resizeKey, String(next));
    } catch {
      // Kept for this visit only.
    }
  };
  // Wide only where the page beside it keeps its room (from 1536px): below, the page would be squeezed under its own
  // layout, so it stays at 420.
  // A width its person chose is theirs (no token holds it): carried as a variable the width class reads.
  const width = custom ? "lg:w-(--panel-width)" : wide ? "lg:w-inspector 2xl:w-inspector-wide" : "lg:w-inspector";
  const style = custom ? ({ "--panel-width": `${custom}px` } as CSSProperties) : undefined;
  return (
    <aside
      ref={self}
      hidden={!present}
      inert={!open}
      aria-label={title}
      data-animate={animate ? "" : undefined}
      style={open ? style : undefined}
      className={`side-panel fixed inset-0 z-40 flex flex-col bg-surface lg:static lg:z-auto lg:shrink-0 lg:overflow-hidden lg:rounded-sheet lg:border-border ${
        open
          ? `lg:ml-sheet-inset lg:border ${width} ${resizeKey ? "lg:relative" : ""}`
          : "invisible translate-x-full opacity-0 lg:ml-0 lg:w-0 lg:translate-x-0 lg:border-0"
      }`}
    >
      {resizeKey && open && !wide ? (
        // biome-ignore lint/a11y/useSemanticElements: a separator that moves (a window splitter), not a rule
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Drag to widen the panel; arrow keys too"
          aria-valuemin={PANEL_MIN}
          aria-valuemax={PANEL_MAX}
          aria-valuenow={Math.round(custom ?? 420)}
          tabIndex={0}
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onKeyDown={nudge}
          className="absolute inset-y-0 left-0 z-10 hidden w-1.5 cursor-col-resize hover:bg-accent/30 focus-visible:bg-accent/40 focus-visible:outline-none lg:block"
        />
      ) : null}
      <div className={`flex min-h-0 w-full flex-1 flex-col lg:shrink-0 ${width}`} style={style}>
        <header className="flex h-12 shrink-0 items-center gap-1 border-b border-separator pr-2 pl-3">
          {back ? (
            <>
              <Button isIconOnly size="sm" variant="ghost" aria-label={`Back to ${back.crumb}`} onPress={back.onPress}>
                <ArrowLeft className="size-4 text-muted" aria-hidden />
              </Button>
              <span className="text-body text-muted-tertiary">{back.crumb} /</span>
            </>
          ) : null}
          {icon ? <span className="flex shrink-0 items-center ps-1 text-muted">{icon}</span> : null}
          <h2 className="shrink-0 ps-1 text-body font-semibold">{title}</h2>
          <span className="min-w-0 flex-1 truncate text-body text-muted-tertiary">
            {subtitle ? `· ${subtitle}` : ""}
          </span>
          {actions}
          <Button isIconOnly size="sm" variant="ghost" aria-label={closeLabel} onPress={onClose}>
            <X className="size-4 text-muted" aria-hidden />
          </Button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </aside>
  );
}
