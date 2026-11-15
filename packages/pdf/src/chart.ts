/**
 * A chart off the page: the page's own drawing, @opendash/charts' ECharts options,
 * rendered on the server in the light theme and Geist, then made a PNG for a PDF to place (and for Slack's chart
 * images). ECharts measures its text with the PDF's own fonts (`fonts.ts`), so labels and the legend are laid out as
 * they'll draw; resvg loads only those fonts, never the machine's, and takes a character Geist lacks from the first
 * that has it. resvg is a native module, loaded when a chart is first drawn: a missing binary only ever costs a chart
 * (a PDF then lists its values), never the process.
 */
import path from "node:path";
import { type ChartData, chartOptions, echarts } from "@opendash/charts";
import { tokens } from "@opendash/tokens";
import { FONT_FILES, type Fonts, pdfFonts } from "./fonts";

/** The family a chart's text is set in: Geist-Regular.ttf's own name (Geist-Medium.ttf's is "Geist Medium"). */
const FAMILY = "Geist";

/**
 * The size a chart is drawn at, in CSS pixels: wide enough that six dates along the axis all show, and placed in a PDF
 * card at about three quarters, so its 12 px text prints at about 9 pt.
 */
export const CHART_SIZE = { width: 600, height: 280 } as const;

/**
 * The size a chart is drawn at: CHART_SIZE, taller for a horizontal chart with many bars, so each has a row for its
 * name on two lines and its value (36 px), up to about a page.
 */
export function chartSize(chart: ChartData): { width: number; height: number } {
  if (!chart.horizontal) return CHART_SIZE;
  const height = Math.min(760, Math.max(CHART_SIZE.height, 64 + 36 * chart.categories.length));
  return { width: CHART_SIZE.width, height };
}
/** How much finer than its CSS size the PNG is: enough for print. */
const ZOOM = 3;

/** The PDF's fonts, measured the way they'll draw, for ECharts' layout (it has no canvas here to measure with). */
let measuring: Fonts | null = null;
async function measureWithFonts(fontDir: string): Promise<void> {
  const fonts = await pdfFonts(fontDir);
  if (measuring === fonts) return;
  measuring = fonts;
  echarts.setPlatformAPI({
    measureText(text: string, css?: string) {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(css ?? "")?.[1] ?? 12);
      return { width: fonts.width(text, "regular", size) };
    },
  });
}

/** A chart as SVG, at `size`: what the page would draw, light, in Geist, with nothing to press. */
export async function chartSvg(
  chart: ChartData,
  fontDir: string,
  size: { width: number; height: number } = chartSize(chart),
): Promise<string> {
  await measureWithFonts(fontDir);
  const instance = echarts.init(null, null, { renderer: "svg", ssr: true, ...size });
  try {
    const options = chartOptions(chart, { mode: "light", fontFamily: FAMILY, interactive: false, width: size.width });
    // ECharts keeps the axis labels inside the box by their line height but draws them a few pixels lower (a browser
    // draws this SVG the same way): with no card below the image to hold them, they get room at the bottom.
    instance.setOption({ ...options, grid: { ...(options.grid as object), bottom: 26 } });
    return instance.renderToSVGString();
  } finally {
    instance.dispose();
  }
}

/** A drawn chart: a PNG, and its size in pixels (ZOOM times its CSS size). */
export interface ChartImage {
  png: Uint8Array;
  width: number;
  height: number;
}

/** A chart as a PNG on the page's own background, ZOOM times finer than its CSS size. */
export async function chartPng(chart: ChartData, fontDir: string): Promise<ChartImage> {
  const svg = await chartSvg(chart, fontDir);
  const { renderAsync } = await import("@resvg/resvg-js");
  const image = await renderAsync(svg, {
    background: tokens.light.surface,
    fitTo: { mode: "zoom", value: ZOOM },
    font: {
      fontFiles: FONT_FILES.map((f) => path.join(fontDir, f)),
      loadSystemFonts: false,
      defaultFontFamily: FAMILY,
    },
    logLevel: "off",
  });
  return { png: image.asPng(), width: image.width, height: image.height };
}
