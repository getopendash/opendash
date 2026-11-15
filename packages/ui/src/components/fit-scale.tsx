"use client";

import { type ReactNode, useLayoutEffect, useRef } from "react";

/**
 * Scales a fixed-size composition down (never up) so it fits whatever width and height its parent gives it, instead
 * of clipping it. For decorative pieces such as the auth hero cards. Below `minScale` the content is hidden rather
 * than shrunk past legibility. The scale is runtime geometry, so it's set here as a CSS variable.
 */
export function FitScale({
  children,
  className = "",
  minScale = 0.6,
}: {
  children: ReactNode;
  className?: string;
  minScale?: number;
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
    return () => observer.disconnect();
  }, [minScale]);

  return (
    <div ref={box} className={`fit-scale ${className}`}>
      <div ref={content} className="fit-scale__content">
        {children}
      </div>
    </div>
  );
}
