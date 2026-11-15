/**
 * How a chart looks: ECharts options from the theme tokens, one drawing for every place a chart shows. The
 * page draws them in the browser (packages/ui's Chart); a PDF and Slack's chart images draw them on the server
 * (@opendash/pdf). No React and no Node here, so client files import it too.
 */
import { tokens } from "@opendash/tokens";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { LabelLayout } from "echarts/features";
import { SVGRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  LineChart,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  LabelLayout,
  SVGRenderer,
]);

/** ECharts, with what these charts use registered (bars, lines, hiding labels that overlap, the SVG renderer). */
export { echarts };

export interface ChartData {
  type: "bar" | "line";
  horizontal: boolean;
  /** How the value axis shows numbers (currency, percent), compact by default. */
  axis?: { currency?: string; percent?: boolean; compact?: boolean };
  /** A trend: one series in a light tone with its latest point in the accent, and no value labels. */
  emphasizeLast?: boolean;
  categories: string[];
  series: { name: string; points: ({ value: number; display: string } | null)[] }[];
  /** A line across the values (a routine's threshold), in the danger tone, its value written at its start. */
  line?: { value: number; display: string };
}

export type ChartMode = "light" | "dark";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** For text that goes into ECharts' HTML tooltip. */
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);

/**
 * How wide a horizontal chart's names may be: 40% of the chart's width, at most 240 px. Past it they wrap (off the
 * page) or end in "…" (on it).
 */
export const NAME_WIDTH = 240;
const nameWidth = (width?: number) => (width ? Math.min(NAME_WIDTH, Math.round(width * 0.4)) : NAME_WIDTH);
/** About how many characters two lines of NAME_WIDTH hold. */
const NAME_CHARS = 64;
/** About how wide a value's characters are at 12 px, to keep room for it beside a bar or a line's end. */
const CHAR = 7;

/**
 * A chart's ECharts options, in the theme's light or dark tokens. `fontFamily` is a real family, not "inherit":
 * ECharts measures text with it to lay out labels and the legend. A drawing no one presses (a PDF's, an image's) is
 * `interactive: false`: no tooltip, no pointer, and its values written where the page would show them on a hover.
 * `width` is the chart's, when it's known.
 */
export function chartOptions(
  chart: ChartData,
  {
    mode,
    fontFamily,
    interactive = true,
    width,
  }: {
    mode: ChartMode;
    fontFamily: string;
    interactive?: boolean;
    /** The chart's width in px, for how wide its names may be. */
    width?: number;
  },
): echarts.EChartsCoreOption {
  const t = tokens[mode] as Record<string, string>;
  const palette = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "chart-6"].map((k) => t[k] as string);
  const n = chart.categories.length;
  const line = chart.type === "line";
  // Which values are written by their bar or point: bars up to 12 (20 laid out horizontally where nothing can be
  // pointed at, each value on its own row), and there, lines up to 12 points; at most two series either way.
  const labels =
    !chart.emphasizeLast &&
    chart.series.length <= 2 &&
    (line ? !interactive && n <= 12 : n <= (chart.horizontal && !interactive ? 20 : 12));
  // A longer line, or more of them, where nothing can be pointed at: each line's latest value at its end.
  const endLabels = line && !interactive && !labels && !chart.emphasizeLast;
  const last = n - 1;
  const font = { fontFamily, fontSize: 12, color: t.muted };
  // A legend leaves out a series with no name, so one has a mark (charts stored before groups were named).
  const names = chart.series.map((s) => s.name.trim() || "—");
  const latest = (s: ChartData["series"][number]) => [...s.points].reverse().find((p) => p)?.display ?? "";
  const widest = Math.max(0, ...chart.series.flatMap((s) => s.points.map((p) => p?.display.length ?? 0)));
  const widestLatest = Math.max(0, ...chart.series.map((s) => latest(s).length));
  const categoryAxis = {
    type: "category" as const,
    data: chart.categories,
    axisLine: { lineStyle: { color: t.border } },
    axisTick: { show: false },
    axisLabel: {
      ...font,
      color: t.muted,
      // Long names would take the plot's width (ECharts keeps the plot to a quarter of it at least, then overflows):
      // capped, on one line ending in "…" where a tooltip has the rest, else wrapping onto a second.
      ...(chart.horizontal
        ? {
            width: nameWidth(width),
            ellipsis: "…",
            ...(interactive
              ? { overflow: "truncate" }
              : {
                  overflow: "break",
                  lineHeight: 15,
                  height: 30,
                  lineOverflow: "truncate",
                  // ECharts drops a third line without a mark: a name past about two lines ends in "…" first.
                  formatter: (name: string) =>
                    name.length > NAME_CHARS ? `${name.slice(0, NAME_CHARS - 1).trimEnd()}…` : name,
                }),
          }
        : {}),
    },
  };
  const axisNumber = new Intl.NumberFormat("en-US", {
    ...(chart.axis?.currency ? { style: "currency", currency: chart.axis.currency } : {}),
    ...(chart.axis?.percent ? { style: "percent" } : {}),
    ...(chart.axis?.compact !== false ? { notation: "compact", maximumFractionDigits: 1 } : {}),
  });
  const across = chart.line;
  const valueAxis = {
    type: "value" as const,
    // A line beyond the values still shows: the axis reaches it (bars still start at zero).
    ...(across
      ? {
          min: (e: { min: number }) => Math.min(chart.type === "bar" ? 0 : e.min, e.min, across.value),
          max: (e: { max: number }) => Math.max(chart.type === "bar" ? 0 : e.max, e.max, across.value),
        }
      : {}),
    splitLine: { lineStyle: { color: t.border } },
    axisLabel: {
      ...font,
      color: t["muted-tertiary"] ?? t.muted,
      formatter: (v: number) => axisNumber.format(v).replace(/K$/, "k"),
    },
  };
  return {
    color: palette,
    animation: false,
    textStyle: { fontFamily },
    grid: {
      left: 8,
      right:
        labels && chart.horizontal
          ? Math.max(48, widest * CHAR + 12)
          : endLabels
            ? Math.max(48, widestLatest * CHAR + 16)
            : 16,
      top: chart.series.length > 1 ? 36 : 12,
      bottom: 8,
      // ECharts 6 keeps axis labels inside the box by default (outerBounds); containLabel is the legacy option.
    },
    legend:
      chart.series.length > 1
        ? { top: 0, left: 0, icon: "roundRect", itemWidth: 10, itemHeight: 10, itemGap: 16, textStyle: font }
        : undefined,
    tooltip: interactive
      ? {
          trigger: "axis",
          backgroundColor: t.overlay ?? t.surface,
          borderColor: t.border,
          textStyle: { ...font, color: t.foreground },
          valueFormatter: () => "",
          // ECharts renders this string as HTML, and categories and series names come from the data: every text in
          // it is escaped, and read from our own chart data rather than ECharts' copies of it. The marker is ECharts'
          // swatch.
          formatter: (items: unknown) =>
            (items as { seriesIndex: number; dataIndex: number; marker: string }[])
              .map((p, i) => {
                const s = chart.series[p.seriesIndex];
                const shown = s?.points[p.dataIndex]?.display ?? "—";
                const head = i === 0 ? `${escapeHtml(chart.categories[p.dataIndex] ?? "")}<br/>` : "";
                return `${head}${p.marker}${escapeHtml(names[p.seriesIndex] ?? "")}: <b>${escapeHtml(shown)}</b>`;
              })
              .join("<br/>"),
        }
      : undefined,
    xAxis: chart.horizontal ? valueAxis : categoryAxis,
    yAxis: chart.horizontal ? { ...categoryAxis, inverse: true } : valueAxis,
    series: chart.series.map((s, si) => ({
      name: names[si],
      type: chart.type,
      data: s.points.map((p) => p?.value ?? null),
      barMaxWidth: 28,
      barGap: "30%",
      itemStyle: {
        borderRadius: chart.horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0],
        ...(chart.emphasizeLast
          ? { color: (p: { dataIndex: number }) => (p.dataIndex === last ? t.accent : t["accent-soft"]) }
          : {}),
      },
      symbolSize: 6,
      ...(interactive ? { cursor: "pointer", emphasis: { focus: "series" } } : { silent: true }),
      label: labels
        ? {
            show: true,
            // A negative bar's value sits just past the axis line, clear of the names and the bar.
            position: chart.horizontal ? "right" : "top",
            ...font,
            color: t.foreground,
            formatter: (p: { dataIndex: number }) => s.points[p.dataIndex]?.display ?? "",
          }
        : undefined,
      ...(endLabels
        ? {
            endLabel: {
              show: true,
              ...font,
              color: t.foreground,
              formatter: (p: { dataIndex: number }) => s.points[p.dataIndex]?.display ?? latest(s),
            },
          }
        : {}),
      // Values that would overlap another are left out rather than drawn over each other.
      ...(labels || endLabels ? { labelLayout: { hideOverlap: true } } : {}),
      ...(across && si === 0
        ? {
            markLine: {
              silent: true,
              symbol: "none",
              data: [chart.horizontal ? { xAxis: across.value } : { yAxis: across.value }],
              lineStyle: { color: t.danger, type: "solid", width: 1 },
              label: { ...font, color: t.danger, position: "insideStartTop", formatter: () => across.display },
            },
          }
        : {}),
    })),
  };
}
