"use client";

import { type ChartData, type ChartMode, chartOptions, echarts } from "@opendash/charts";
import { useEffect, useRef } from "react";

export type { ChartData };

/** The page's theme: an explicit choice on <html>, else the system's. */
function currentMode(): ChartMode {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "dark" || explicit === "light") return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * A chart in an answer or an artifact (ECharts, SVG), laid out by @opendash/charts, as a PDF's is. Colours
 * come from the theme tokens for the page's light or dark mode and follow it when it changes. Pressing a point calls
 * onPoint with its series and index, which an answer uses to open the point's trace.
 */
export function Chart({
  chart,
  label,
  onPoint,
  className = "h-64",
}: {
  chart: ChartData;
  /** What it shows, for screen readers. */
  label: string;
  onPoint?: (series: number, index: number) => void;
  className?: string;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const handler = useRef(onPoint);
  handler.current = onPoint;

  useEffect(() => {
    const el = box.current;
    const outer = frame.current;
    if (!el || !outer) return;
    const instance = echarts.init(el, null, { renderer: "svg" });
    const draw = () =>
      instance.setOption(
        chartOptions(chart, {
          mode: currentMode(),
          fontFamily: getComputedStyle(el).fontFamily,
          width: el.clientWidth,
        }),
        true,
      );
    draw();
    instance.on("click", (p) => handler.current?.(p.seriesIndex ?? 0, p.dataIndex));
    // The frame follows its card (the chart is drawn inside it, absolutely, so its SVG's pixel width never holds the
    // card wide): when the page narrows, the chart is drawn again at the card's new size, a horizontal one's names
    // capped for it.
    const resize = new ResizeObserver(() => {
      instance.resize();
      if (chart.horizontal) draw();
    });
    resize.observe(outer);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", draw);
    const theme = new MutationObserver(draw);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => {
      resize.disconnect();
      media.removeEventListener("change", draw);
      theme.disconnect();
      instance.dispose();
    };
  }, [chart]);

  return (
    <div ref={frame} className={`relative w-full min-w-0 ${className}`}>
      <div ref={box} role="img" aria-label={label} className="absolute inset-0" />
    </div>
  );
}
