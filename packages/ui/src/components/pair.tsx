"use client";

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { OpenDashMark } from "../icons/opendash-logo";

/** What Pair is doing: one state for each moment of the agent's work. */
export type PairState = "idle" | "listening" | "thinking" | "working" | "success" | "attention" | "sleeping";

/** Pair's sizes: 24 is the smallest the fur reads at; below it, use `OpenDashMark`. */
export type PairSize = 24 | 28 | 36 | 64 | 104;

const ENGINE_STATE = {
  idle: "default",
  listening: "listening",
  thinking: "thinking",
  working: "working",
  success: "success",
  attention: "error",
  sleeping: "sleeping",
} as const;

const BOX: Record<PairSize, string> = { 24: "size-6", 28: "size-7", 36: "size-9", 64: "size-16", 104: "size-26" };
const MARK: Record<PairSize, string> = {
  24: "size-5 text-brand",
  28: "size-6 text-brand",
  36: "size-7 text-brand",
  64: "size-12 text-brand",
  104: "size-20 text-brand",
};

// The engine (packages/ui/vendor/pair, about 43 KB gzipped) loads only where a Pair is drawn, in its own chunk.
const Engine = lazy(() => import("../../vendor/pair/BotAvatar").then((m) => ({ default: m.BotAvatar })));

/**
 * The theme it's drawn on, not the system's: next-themes puts `dark` or `light` on <html> (someone can choose either,
 * whatever their system says), and a block can carry its own (the UI gallery's two panels). Pair is told explicitly,
 * or it would draw for the system's.
 */
function useThemeAround(el: HTMLElement | null): "dark" | "light" {
  const [theme, setTheme] = useState<"dark" | "light">("light");
  useEffect(() => {
    if (!el) return;
    const read = () => setTheme(el.closest(".dark, .light")?.classList.contains("dark") ? "dark" : "light");
    read();
    const watch = new MutationObserver(read);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const own = el.closest(".dark, .light");
    if (own && own !== document.documentElement) watch.observe(own, { attributes: true, attributeFilter: ["class"] });
    return () => watch.disconnect();
  }, [el]);
  return theme;
}

/**
 * Pair: the OpenDash mark as a small plush character that shows what the agent is doing. It's drawn on a
 * canvas in the browser only; until it's ready, the flat mark holds its place at the same size, so nothing moves.
 * `still` holds a pose and costs nothing a frame: only the one thing working on a screen should move. Reduced motion
 * gets still poses on its own. Decorative unless given a `label`, since the text beside it says the same.
 */
export function Pair({
  state = "idle",
  size = 28,
  still = false,
  interactive = false,
  label,
  className = "",
}: {
  state?: PairState;
  size?: PairSize;
  still?: boolean;
  /** Its eyes follow the pointer and a click makes it hop: for a big Pair on its own, never in a list or a trace. */
  interactive?: boolean;
  label?: string;
  className?: string;
}) {
  const [box, setBox] = useState<HTMLSpanElement | null>(null);
  const theme = useThemeAround(box);
  // Drawn in the browser only: the server and the first render show the mark.
  const mounted = box !== null;
  // The engine keeps its canvas transparent while its fur bakes (about half a second the first time): the mark stays
  // until the canvas shows.
  const [drawn, setDrawn] = useState(false);
  const watch = useRef<MutationObserver | null>(null);
  const canvasRef = useCallback((canvas: HTMLCanvasElement | null) => {
    watch.current?.disconnect();
    if (!canvas) return;
    const check = () => setDrawn(canvas.style.opacity === "1");
    check();
    watch.current = new MutationObserver(check);
    watch.current.observe(canvas, { attributes: true, attributeFilter: ["style"] });
  }, []);
  useEffect(() => () => watch.current?.disconnect(), []);
  const mark = <OpenDashMark className={MARK[size]} />;
  return (
    <span
      ref={setBox}
      className={`relative inline-grid shrink-0 place-items-center ${BOX[size]} ${className}`}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {mounted ? (
        <Suspense fallback={mark}>
          <Engine
            ref={canvasRef}
            type="opendash"
            state={ENGINE_STATE[state]}
            size={size}
            paused={still}
            interactive={interactive}
            theme={theme}
            seed={0.37}
            aria-hidden
          />
          {drawn ? null : <span className="absolute inset-0 grid place-items-center">{mark}</span>}
        </Suspense>
      ) : (
        mark
      )}
    </span>
  );
}
