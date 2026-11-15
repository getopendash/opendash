// How a chart looks, on the page and in a PDF: each bar's value written by it from the point's display
// (up to 12 categories and 2 series); where no one can point at it, a line's values too, by its points or at its end;
// long names capped so the plot keeps its width; room for long values and a name for every series; the value axis in
// the answer's format, a horizontal chart's axes swapped, the theme's palette, and a drawing no one presses with no
// tooltip.
import { tokens } from "@opendash/tokens";
import { describe, expect, it } from "vitest";
import { type ChartData, chartOptions, NAME_WIDTH } from "../src";

const pt = (value: number, display = String(value)) => ({ value, display });
const bars: ChartData = {
  type: "bar",
  horizontal: false,
  categories: ["2026-04-01", "2026-05-01"],
  series: [
    { name: "Orders placed", points: [pt(1200, "1,200"), pt(980)] },
    { name: "Orders shipped", points: [pt(600), null] },
  ],
};

interface Axis {
  type: string;
  inverse?: boolean;
  axisLabel: { formatter?: (v: number) => string } & Record<string, unknown>;
}
type Label = { show: boolean; position: string; formatter: (p: { dataIndex: number }) => string };
interface Drawn {
  color: string[];
  tooltip?: unknown;
  legend?: unknown;
  grid: { right: number };
  xAxis: Axis;
  yAxis: Axis;
  series: {
    name: string;
    data: unknown[];
    silent?: boolean;
    cursor?: string;
    label?: Label;
    endLabel?: Label;
    labelLayout?: { hideOverlap: boolean };
  }[];
}
const draw = (chart: ChartData, interactive?: boolean) =>
  chartOptions(chart, { mode: "light", fontFamily: "Geist", interactive }) as unknown as Drawn;

describe("a chart's look", () => {
  it("writes each bar's value from its point's display, up to 12 categories and 2 series", () => {
    const drawn = draw(bars);
    expect(drawn.series[0]?.label).toMatchObject({ show: true, position: "top" });
    expect(drawn.series[0]?.label?.formatter({ dataIndex: 0 })).toBe("1,200");
    expect(drawn.series[1]?.label?.formatter({ dataIndex: 1 })).toBe("");
    expect(drawn.legend).toBeDefined();

    const many = { ...bars, categories: Array.from({ length: 13 }, (_, i) => `c${i}`) };
    const three = { ...bars, series: [...bars.series, { name: "Failed", points: [pt(1), pt(2)] }] };
    const line = { ...bars, type: "line" as const };
    for (const chart of [many, three, line]) expect(draw(chart).series[0]?.label).toBeUndefined();
  });

  it("writes a line's values where no one can point at them: each point up to 12 and two lines, else at the end", () => {
    const line = { ...bars, type: "line" as const };
    const still = draw(line, false);
    expect(still.series[0]?.label?.formatter({ dataIndex: 0 })).toBe("1,200");
    // Above their points, clear of the axis's labels; any that would overlap another are left out.
    expect(still.series.map((s) => s.label?.position)).toEqual(["top", "top"]);
    expect(still.series.every((s) => s.labelLayout?.hideOverlap)).toBe(true);
    // On the page, a tooltip shows them instead.
    expect(draw(line).series[0]?.label).toBeUndefined();

    // A month of days: the latest value at the line's end, with room for it.
    const days = Array.from({ length: 31 }, (_, i) => `Day ${i + 1}`);
    const month = {
      ...line,
      categories: days,
      series: [{ name: "Users", points: days.map((_, i) => pt(900 + i, `${900 + i}`)) }],
    };
    const ended = draw(month, false);
    expect(ended.series[0]?.label).toBeUndefined();
    expect(ended.series[0]?.endLabel?.formatter({ dataIndex: 30 })).toBe("930");
    expect(ended.grid.right).toBeGreaterThanOrEqual(48);
    expect(draw(month).series[0]?.endLabel).toBeUndefined();
  });

  it("caps a horizontal chart's long names: wrapped off the page, one line ending in … on it", () => {
    const named = { ...bars, horizontal: true };
    expect(draw(named, false).yAxis.axisLabel).toMatchObject({
      width: NAME_WIDTH,
      overflow: "break",
      height: 30,
      lineOverflow: "truncate",
    });
    expect(draw(named).yAxis.axisLabel).toMatchObject({ width: NAME_WIDTH, overflow: "truncate", ellipsis: "…" });
    // In a narrow card, 40% of its width, so the plot keeps the rest.
    const narrow = chartOptions(named, { mode: "light", fontFamily: "Geist", width: 300 }) as unknown as Drawn;
    expect(narrow.yAxis.axisLabel.width).toBe(120);
    // Each value has its own row, so a drawing writes them up to 20 bars; the page, up to 12.
    const twenty = {
      ...named,
      categories: Array.from({ length: 20 }, (_, i) => `Flow ${i}`),
      series: [{ name: "Runs", points: Array.from({ length: 20 }, (_, i) => pt(i * 10)) }],
    };
    expect(draw(twenty, false).series[0]?.label?.show).toBe(true);
    expect(draw(twenty).series[0]?.label).toBeUndefined();
  });

  it("keeps room for long values, and names a nameless series", () => {
    const money = {
      ...bars,
      horizontal: true,
      series: [{ name: "Change", points: [pt(1234567.89, "$1,234,567.89"), pt(-120, "−120")] }],
    };
    const drawn = draw(money);
    expect(drawn.grid.right).toBe(13 * 7 + 12);

    const [created, ran] = bars.series as [ChartData["series"][number], ChartData["series"][number]];
    const blank = draw({ ...bars, series: [{ ...created, name: "" }, ran] });
    expect(blank.series.map((s) => s.name)).toEqual(["—", "Orders shipped"]);
  });

  it("shows the value axis in the answer's format, compact by default", () => {
    expect(draw(bars).yAxis.axisLabel.formatter?.(1000)).toBe("1k");
    expect(draw({ ...bars, axis: { currency: "USD", compact: true } }).yAxis.axisLabel.formatter?.(1500)).toBe("$1.5k");
    expect(draw({ ...bars, axis: { percent: true, compact: false } }).yAxis.axisLabel.formatter?.(0.25)).toBe("25%");
  });

  it("swaps the axes of a horizontal chart, its values by the bars' ends", () => {
    const drawn = draw({ ...bars, horizontal: true });
    expect(drawn.xAxis.type).toBe("value");
    expect(drawn.yAxis).toMatchObject({ type: "category", inverse: true });
    expect(drawn.series[0]?.label?.position).toBe("right");
  });

  it("uses the theme's palette, and has no tooltip or pointer when no one presses it", () => {
    expect(draw(bars).color.slice(0, 2)).toEqual([tokens.light["chart-1"], tokens.light["chart-2"]]);
    expect(draw(bars)).toMatchObject({ tooltip: { trigger: "axis" }, series: [{ cursor: "pointer" }, {}] });
    const still = draw(bars, false);
    expect(still.tooltip).toBeUndefined();
    expect(still.series.every((s) => s.silent && !s.cursor)).toBe(true);
  });

  it("draws a line across the values in the danger tone, and reaches it on the axis", () => {
    const drawn = chartOptions(
      { ...bars, series: [bars.series[0] as ChartData["series"][number]], line: { value: 1500, display: "1.5k" } },
      { mode: "light", fontFamily: "Geist" },
    ) as unknown as {
      yAxis: { max: (e: { max: number }) => number; min: (e: { min: number }) => number };
      series: { markLine?: { data: unknown[]; lineStyle: { color: string }; label: { formatter: () => string } } }[];
    };
    const mark = drawn.series[0]?.markLine;
    expect(mark?.data).toEqual([{ yAxis: 1500 }]);
    expect(mark?.lineStyle.color).toBe(tokens.light.danger);
    expect(mark?.label.formatter()).toBe("1.5k");
    expect(drawn.yAxis.max({ max: 1200 })).toBe(1500);
    // Bars start at zero; a line chart's axis starts at its values, or the line below them.
    expect(drawn.yAxis.min({ min: 980 })).toBe(0);
    const lined = chartOptions(
      {
        ...bars,
        type: "line",
        series: [bars.series[0] as ChartData["series"][number]],
        line: { value: 900, display: "900" },
      },
      { mode: "light", fontFamily: "Geist" },
    ) as unknown as { yAxis: { min: (e: { min: number }) => number } };
    expect(lined.yAxis.min({ min: 980 })).toBe(900);
    expect(draw(bars).series[0]).not.toHaveProperty("markLine");
  });
});
