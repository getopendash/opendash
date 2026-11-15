"use client";

import { type ReactNode, useLayoutEffect, useRef } from "react";

/**
 * Scales a fixed-size composition down (never up) so it fits whatever width and height its parent gives it, instead
 * of clipping it. For decorative pieces such as the auth hero cards. Below `minScale` the content is hidden rather
 * than shrunk past legibility. The scale is runtime geometry, so it's set here as a CSS variable.
 *
 * `center` is for a whole screen's content rather than a decoration: it stays in the page's flow at its parent's
 * width, centred, and shrinks only when it's taller than the room it has, so the screen never scrolls. Give it
 * `minScale={0}`: content is never hidden.
 */
export function FitScale({
  children,
  className = "",
  minScale = 0.6,
  center = false,
}: {
  children: ReactNode;
  className?: string;
  minScale?: number;
  center?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const outer = box.current;
    const inner = content.current;
    if (!outer || !inner) return;
    const rescale = () => {
      // offsetWidth/offsetHeight ignore transforms, so this is always the unscaled size.
      const scale = Math.min(1, outer.clientWidth / inner.offsetWidth, outer.clientHeight / inner.offsetHeight);
      outer.style.setProperty("--fit-scale", String(scale));
      outer.dataset.fit = scale >= minScale ? "shown" : "hidden";
    };
    rescale();
    const observer = new ResizeObserver(rescale);
    observer.observe(outer);
    // Centred content changes height as it works (a step's checks appearing): it's measured again.
    if (center) observer.observe(inner);
    return () => observer.disconnect();
  }, [minScale, center]);

  return (
    <div ref={box} className={`fit-scale ${center ? "fit-scale--center" : ""} ${className}`}>
      <div ref={content} className="fit-scale__content">
        {children}
      </div>
    </div>
  );
}
