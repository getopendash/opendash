"use client";

import { Button } from "@heroui/react";
import type { DashboardPlanOutcome } from "@opendash/core";
import { CircleCheck, CircleX, Hammer, LayoutDashboard, Puzzle, ScanSearch, TriangleAlert } from "lucide-react";
import { useState } from "react";

type Page = DashboardPlanOutcome["pages"][number];
type PlanSection = Page["sections"][number];

/** A section's columns of twelve, as the dashboard lays it out. */
const SPAN: Record<string, string> = {
  full: "col-span-12",
  half: "col-span-6",
  third: "col-span-4",
  quarter: "col-span-3",
};
const span = (s: PlanSection) => SPAN[s.width ?? "full"] ?? "col-span-12";

/** A chart kind in words, with its article: "a stacked bar chart", "small multiples". */
const CHART_WORDS: Record<string, string> = {
  line: "a line chart",
  bar: "a bar chart",
  area: "an area chart",
  stacked_bar: "a stacked bar chart",
  stacked_area: "a stacked area chart",
  multiples: "small multiples",
  ranked: "a ranked list",
  scatter: "a scatter plot",
  bullet: "a bullet chart",
  calendar: "a calendar",
  funnel: "a funnel",
  treemap: "a treemap",
  waterfall: "a waterfall",
  heatmap: "a heatmap",
  sankey: "a flow diagram",
  timeline: "a timeline",
  boxplot: "a box plot",
};

/** What a page holds, in words: "2 numbers · a bar chart · a list". */
function pageWords(page: Page): string {
  const n = (kind: string) => page.sections.filter((s) => s.kind === kind).length;
  const charts = page.sections.filter((s) => s.kind === "chart");
  return [
    page.layout === "list" ? "a list with the record beside it" : page.layout === "record" ? "one record" : null,
    n("kpi") ? (n("kpi") === 1 ? "a number" : `${n("kpi")} numbers`) : null,
    charts.length === 1
      ? (CHART_WORDS[charts[0]?.chart ?? ""] ?? "a chart")
      : charts.length
        ? `${charts.length} charts`
        : null,
    n("grid") ? (n("grid") === 1 ? "a list" : `${n("grid")} lists`) : null,
    n("custom") ? (n("custom") === 1 ? "a piece" : `${n("custom")} pieces`) : null,
    n("text") ? (n("text") === 1 ? "a written finding" : `${n("text")} written findings`) : null,
    n("stats") ? "a strip of numbers" : null,
    n("meters") ? "meters" : null,
    n("next") ? "next actions" : null,
    n("signal") ? (n("signal") === 1 ? "a verdict" : `${n("signal")} verdicts`) : null,
    n("flow") ? "A → B cards" : null,
    n("facts") ? "facts" : null,
    n("summary") ? "an AI summary" : null,
    n("whatif") ? "a what-if" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A bar chart's glyph: bars rising gently, a picture of the kind, never of data. */
const BARS = ["h-2/5", "h-3/5", "h-1/2", "h-3/4", "h-2/3", "h-4/5", "h-3/4", "h-5/6"];
/** A stacked bar's lower parts, under BARS. */
const LOWER = ["h-1/5", "h-1/3", "h-1/4", "h-2/5", "h-1/3", "h-1/2", "h-2/5", "h-1/2"];
/** A ranked list's bars, largest first. */
const RANKED = ["w-full", "w-4/5", "w-3/5", "w-2/5", "w-1/4"];
/** A calendar's shades, by day: a picture of the kind. */
const SHADES = ["fill-accent/15", "fill-accent/35", "fill-accent/60", "fill-accent/90"];

const svg = "h-8 w-full";

/** A chart's shape in the wireframe: its kind drawn, never a number. */
function ChartGlyph({ type }: { type?: string }) {
  if (type === "line" || type === "area" || type === "stacked_area") {
    return (
      <svg viewBox="0 0 100 32" preserveAspectRatio="none" className={svg} aria-hidden>
        {type === "stacked_area" ? (
          <path d="M0 22 L20 18 L40 20 L60 13 L80 14 L100 9 L100 32 L0 32 Z" className="fill-accent/30" />
        ) : null}
        {type !== "line" ? (
          <path
            d={
              type === "stacked_area"
                ? "M0 28 L20 26 L40 27 L60 22 L80 23 L100 20 L100 32 L0 32 Z"
                : "M0 26 L20 20 L40 22 L60 13 L80 15 L100 8 L100 32 L0 32 Z"
            }
            className={type === "stacked_area" ? "fill-accent/70" : "fill-accent-soft"}
          />
        ) : null}
        {type !== "stacked_area" ? (
          <path
            d="M0 26 L20 20 L40 22 L60 13 L80 15 L100 8"
            className="fill-none stroke-accent"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
    );
  }
  if (type === "multiples") {
    return (
      <span className="grid h-8 grid-cols-3 gap-1" aria-hidden>
        {[
          "M0 9 L10 6 L20 7 L30 2",
          "M0 8 L10 8 L20 5 L30 4",
          "M0 4 L10 6 L20 5 L30 8",
          "M0 9 L10 7 L20 3 L30 3",
          "M0 7 L10 5 L20 6 L30 2",
          "M0 6 L10 7 L20 7 L30 5",
        ].map((d) => (
          <svg key={d} viewBox="0 0 30 10" preserveAspectRatio="none" className="h-3.5 w-full" aria-hidden>
            <path d={d} className="fill-none stroke-accent" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          </svg>
        ))}
      </span>
    );
  }
  if (type === "ranked") {
    return (
      <span className="flex h-8 flex-col justify-between" aria-hidden>
        {RANKED.map((w, i) => (
          <span
            key={w}
            className={`h-1 rounded-xs ${w} ${i === RANKED.length - 1 ? "bg-foreground/20" : "bg-accent/70"}`}
          />
        ))}
      </span>
    );
  }
  if (type === "scatter") {
    return (
      <svg viewBox="0 0 100 32" className={svg} aria-hidden>
        {[
          [8, 26],
          [18, 22],
          [26, 24],
          [36, 17],
          [44, 19],
          [52, 12],
          [63, 14],
          [71, 9],
          [82, 10],
          [92, 5],
        ].map(([cx, cy]) => (
          <circle key={`${cx}`} cx={cx} cy={cy} r={2.4} className="fill-accent/80" />
        ))}
      </svg>
    );
  }
  if (type === "bullet") {
    return (
      <span className="flex h-8 flex-col justify-center gap-2" aria-hidden>
        {["w-3/4", "w-1/2"].map((w) => (
          <span key={w} className="relative h-2 rounded-xs bg-foreground/10">
            <span className={`absolute inset-y-0 left-0 rounded-xs bg-accent/70 ${w}`} />
            <span className="absolute -inset-y-1 left-2/3 w-0.5 rounded-xs bg-foreground" />
          </span>
        ))}
      </span>
    );
  }
  if (type === "calendar") {
    return (
      <svg viewBox="0 0 100 32" className={svg} aria-hidden>
        {Array.from({ length: 4 * 14 }, (_, i) => (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed glyph
            key={i}
            x={(i % 14) * 7.2}
            y={Math.floor(i / 14) * 8}
            width={6}
            height={6.5}
            rx={1}
            className={SHADES[(i * 7 + Math.floor(i / 3)) % SHADES.length]}
          />
        ))}
      </svg>
    );
  }
  if (type === "funnel") {
    return (
      <svg viewBox="0 0 100 32" className={svg} aria-hidden>
        <path d="M10 1 H90 L82 10 H18 Z" className="fill-accent" />
        <path d="M19 11.5 H81 L72 20.5 H28 Z" className="fill-accent/70" />
        <path d="M29 22 H71 L64 31 H36 Z" className="fill-accent/45" />
      </svg>
    );
  }
  if (type === "treemap") {
    return (
      <span className="grid h-8 grid-cols-6 grid-rows-2 gap-0.5" aria-hidden>
        <span className="col-span-3 row-span-2 rounded-xs bg-accent/80" />
        <span className="col-span-2 rounded-xs bg-accent/55" />
        <span className="rounded-xs bg-accent/35" />
        <span className="col-span-1 rounded-xs bg-accent/45" />
        <span className="col-span-2 rounded-xs bg-foreground/15" />
      </span>
    );
  }
  if (type === "heatmap") {
    const shades = [
      "bg-accent/20",
      "bg-accent/45",
      "bg-accent/70",
      "bg-accent/35",
      "bg-accent/85",
      "bg-accent/25",
      "bg-accent/55",
      "bg-accent/40",
      "bg-accent/60",
      "bg-accent/30",
      "bg-accent/75",
      "bg-accent/50",
    ];
    return (
      <span className="grid h-8 grid-cols-6 grid-rows-2 gap-0.5" aria-hidden>
        {shades.map((o, k) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed glyph
          <span key={k} className={`rounded-xs ${o}`} />
        ))}
      </span>
    );
  }
  if (type === "sankey") {
    return (
      <svg viewBox="0 0 100 32" className={svg} aria-hidden>
        <rect x={2} y={2} width={4} height={14} rx={1} className="fill-accent" />
        <rect x={2} y={19} width={4} height={11} rx={1} className="fill-accent/50" />
        <rect x={94} y={2} width={4} height={9} rx={1} className="fill-foreground/30" />
        <rect x={94} y={14} width={4} height={16} rx={1} className="fill-foreground/30" />
        <path d="M6 9 C50 9 50 6 94 6" className="fill-none stroke-accent/40" strokeWidth={6} />
        <path d="M6 14 C50 14 50 20 94 20" className="fill-none stroke-accent/40" strokeWidth={4} />
        <path d="M6 24 C50 24 50 25 94 25" className="fill-none stroke-accent/25" strokeWidth={8} />
      </svg>
    );
  }
  if (type === "timeline") {
    return (
      <svg viewBox="0 0 100 32" className={svg} aria-hidden>
        <rect x={4} y={3} width={40} height={6} rx={2} className="fill-accent" />
        <rect x={22} y={13} width={52} height={6} rx={2} className="fill-accent/60" />
        <rect x={48} y={23} width={46} height={6} rx={2} className="fill-accent/30" />
      </svg>
    );
  }
  if (type === "boxplot") {
    return (
      <svg viewBox="0 0 100 32" className={svg} aria-hidden>
        {[12, 42, 72].map((x, k) => (
          <g key={x}>
            <line x1={x + 8} x2={x + 8} y1={2 + k * 2} y2={30 - k} className="stroke-foreground/30" strokeWidth={1.5} />
            <rect x={x} y={9 + k * 2} width={16} height={12 - k} rx={1.5} className="fill-accent/30 stroke-accent" />
            <line x1={x} x2={x + 16} y1={15 + k} y2={15 + k} className="stroke-accent" strokeWidth={1.5} />
          </g>
        ))}
      </svg>
    );
  }
  if (type === "waterfall") {
    return (
      <svg viewBox="0 0 100 32" className={svg} aria-hidden>
        <rect x={2} y={14} width={12} height={18} rx={1.5} className="fill-foreground/25" />
        <rect x={18} y={8} width={12} height={6} rx={1.5} className="fill-accent" />
        <rect x={34} y={8} width={12} height={9} rx={1.5} className="fill-accent/40" />
        <rect x={50} y={3} width={12} height={14} rx={1.5} className="fill-accent" />
        <rect x={66} y={3} width={12} height={4} rx={1.5} className="fill-accent/40" />
        <rect x={84} y={7} width={12} height={25} rx={1.5} className="fill-foreground/25" />
      </svg>
    );
  }
  return (
    <div className="flex h-8 items-end gap-0.5" aria-hidden>
      {BARS.map((h, i) =>
        type === "stacked_bar" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed glyph
          <span key={i} className={`flex flex-1 flex-col justify-end gap-px ${h}`}>
            <span className="flex-1 rounded-t-xs bg-accent/35" />
            <span className={`bg-accent/80 ${LOWER[i]}`} />
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed glyph
          <span key={i} className={`flex-1 rounded-t-xs bg-accent/70 ${h}`} />
        ),
      )}
    </div>
  );
}

/** One section drawn as the dashboard will draw it: its kind, its title, its width. */
function Tile({ section }: { section: PlanSection }) {
  const dashed = section.kind === "custom";
  // Its title and what it shows are written out (never only on hover), wrapping in a narrow tile.
  return (
    <div
      className={`${span(section)} flex min-w-0 flex-col gap-1.5 rounded-lg border bg-surface px-2 py-1.5 ${dashed ? "border-dashed border-accent/60" : "border-border"}`}
    >
      <span className="flex min-w-0 items-start gap-1 text-micro leading-tight text-muted">
        {dashed ? <Puzzle className="mt-px size-3 shrink-0 text-accent" aria-label="Custom part" /> : null}
        <span className="min-w-0 break-words">{section.title}</span>
      </span>
      {section.kind === "kpi" ? (
        <span className="flex flex-col gap-1" aria-hidden>
          <span className="h-3 w-3/5 rounded-xs bg-foreground/15" />
          <span className="h-1.5 w-2/5 rounded-xs bg-success/40" />
          {section.trend ? (
            <svg viewBox="0 0 100 10" preserveAspectRatio="none" className="h-2.5 w-full" aria-hidden>
              <path
                d="M0 8 L15 6 L30 7 L45 4 L60 5 L75 2 L100 3"
                className="fill-none stroke-accent"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          ) : null}
          {section.target ? (
            <span className="h-1 w-full rounded-xs bg-foreground/10">
              <span className="block h-1 w-2/3 rounded-xs bg-accent/70" />
            </span>
          ) : null}
        </span>
      ) : section.kind === "chart" ? (
        <ChartGlyph {...(section.chart ? { type: section.chart } : {})} />
      ) : section.kind === "text" || section.kind === "summary" ? (
        <span className="flex flex-col gap-1" aria-hidden>
          {["w-full", "w-11/12", "w-3/5"].map((w) => (
            <span
              key={w}
              className={`h-1.5 ${w} rounded-xs ${section.kind === "summary" ? "bg-accent/25" : "bg-foreground/15"}`}
            />
          ))}
        </span>
      ) : section.kind === "stats" ? (
        <span className="flex gap-1" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="h-3 flex-1 rounded-xs bg-foreground/15" />
          ))}
        </span>
      ) : section.kind === "next" ? (
        <span className="flex flex-col gap-1" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span key={i} className="flex items-center gap-1">
              <span className="size-2 rounded-full bg-foreground/15" />
              <span className="h-1.5 flex-1 rounded-xs bg-foreground/15" />
              <span className="h-1.5 w-3 rounded-xs bg-foreground/25" />
            </span>
          ))}
        </span>
      ) : section.kind === "meters" ? (
        <span className="flex flex-col gap-1" aria-hidden>
          {["w-4/5", "w-2/5", "w-3/5"].map((w) => (
            <span key={w} className="h-1.5 w-full rounded-xs bg-foreground/10">
              <span className={`block h-1.5 ${w} rounded-xs ${w === "w-4/5" ? "bg-warning/60" : "bg-accent/60"}`} />
            </span>
          ))}
        </span>
      ) : section.kind === "signal" ? (
        <span className="flex items-center gap-1.5 border-l-2 border-warning pl-1.5" aria-hidden>
          <span className="size-2 rounded-full bg-warning/70" />
          <span className="h-1.5 w-3/5 rounded-xs bg-foreground/15" />
        </span>
      ) : section.kind === "whatif" ? (
        <span className="flex flex-col gap-1" aria-hidden>
          <span className="h-1.5 w-1/2 rounded-xs bg-accent/50" />
          <span className="flex">
            <span className="w-1/2" />
            <span className="h-1.5 w-1/5 rounded-xs bg-success/60" />
          </span>
          <span className="flex">
            <span className="w-3/5" />
            <span className="h-1.5 w-1/12 rounded-xs bg-danger/60" />
          </span>
          <span className="h-1.5 w-3/5 rounded-xs bg-accent" />
        </span>
      ) : section.kind === "flow" ? (
        <span className="flex items-center gap-1 text-micro text-accent" aria-hidden>
          <span className="h-2 w-1/3 rounded-xs bg-foreground/15" />→
          <span className="h-2 w-1/3 rounded-xs bg-foreground/15" />
        </span>
      ) : section.kind === "facts" ? (
        <span className="grid grid-cols-2 gap-1" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={`h-1.5 rounded-xs ${i % 2 ? "bg-foreground/20" : "bg-foreground/10"}`} />
          ))}
        </span>
      ) : section.kind === "grid" ? (
        <span className="flex flex-col gap-1" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className={`h-1.5 rounded-xs ${i === 0 ? "w-full bg-foreground/20" : "w-full bg-foreground/10"}`}
            />
          ))}
        </span>
      ) : null}
      {section.kind === "grid" && section.changes?.length ? (
        // What each row can change in a service, said before Build it: confirmed by whoever presses it.
        <span className="flex flex-wrap gap-1">
          {section.changes.map((c) => (
            <span
              key={c}
              className="rounded-sm border border-border px-1.5 text-micro leading-4 text-foreground"
              title="Each press is confirmed, with the person's own account"
            >
              {c}
            </span>
          ))}
        </span>
      ) : null}
      {section.detail ? (
        <span className="text-micro leading-snug text-muted-tertiary break-words">{section.detail}</span>
      ) : dashed ? (
        <span className="text-micro leading-snug text-muted-tertiary">Built for this dashboard</span>
      ) : null}
    </div>
  );
}

/** A page's thumbnail: its sections as tiles in their widths, no words. */
function Thumb({ page }: { page: Page }) {
  const listed = page.layout === "list";
  return (
    <span
      className="grid h-10 w-16 shrink-0 grid-cols-12 content-start gap-0.5 overflow-hidden rounded-md border border-border bg-surface p-0.5"
      aria-hidden
    >
      {listed ? <span className="col-span-4 row-span-4 h-full rounded-xs bg-foreground/10" /> : null}
      {page.layout === "record" ? <span className="col-span-12 h-1.5 rounded-xs bg-foreground/25" /> : null}
      {page.sections.slice(0, 8).map((s, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: sections may repeat a title
          key={i}
          className={`${span(s)} h-1.5 rounded-xs ${s.kind === "kpi" ? "bg-accent/70" : s.kind === "chart" ? "bg-accent/35" : s.kind === "custom" ? "border border-dashed border-accent/60" : "bg-foreground/15"}`}
        />
      ))}
    </span>
  );
}

/** A record's head in the wireframe: a title and its tag, a line under them. */
function HeadGlyph() {
  return (
    <span className="col-span-12 flex flex-col gap-1 pb-0.5" aria-hidden>
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2/5 rounded-xs bg-foreground/25" />
        <span className="h-2 w-8 rounded-xs bg-accent/40" />
      </span>
      <span className="h-1.5 w-3/5 rounded-xs bg-foreground/10" />
    </span>
  );
}

/** A page as it will be laid out: its sections; a list with the record beside it; or one record, its head first. */
function PageLayout({ page }: { page: Page }) {
  const tiles = (
    <>
      {page.layout === "list" || page.layout === "record" ? <HeadGlyph /> : null}
      {page.sections.map((s, i) => (
        <Tile key={s.id ?? `${i}:${s.title}`} section={s} />
      ))}
    </>
  );
  if (page.layout !== "list") return <div className="grid grid-cols-12 gap-1.5">{tiles}</div>;
  return (
    <div className="grid grid-cols-12 gap-2">
      <span className="col-span-4 flex flex-col gap-1 rounded-lg border border-border bg-surface p-1.5" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={`flex flex-col gap-0.5 rounded-md px-1 py-1 ${i === 1 ? "bg-accent-soft ring-1 ring-accent/60" : ""}`}
          >
            <span className="h-1.5 w-3/4 rounded-xs bg-foreground/25" />
            <span className="h-1 w-1/2 rounded-xs bg-foreground/10" />
          </span>
        ))}
      </span>
      <div className="col-span-8 grid grid-cols-12 content-start gap-1.5">{tiles}</div>
    </div>
  );
}

/**
 * The dashboard the analyst means to build or change, drawn: what it's for, what it reads, its
 * filters, and each page as the dashboard will lay it out, so the person sees it before anything is built. Build it
 * sends "Build it" as the next question; anything typed instead changes the plan. An older plan, or a shared
 * conversation's, is shown but can't be built from here.
 */
export function DashboardPlanCard({
  plan,
  can,
  onAsk,
}: {
  plan: DashboardPlanOutcome;
  /** The latest plan, in a conversation the reader may add to. */
  can: boolean;
  onAsk?: (text: string) => void;
}) {
  const [shown, setShown] = useState(0);
  const page = plan.pages[shown] ?? plan.pages[0];
  const many = plan.pages.length > 1;
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border px-4 py-3.5">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <LayoutDashboard className="size-4 shrink-0 text-accent" aria-hidden />
          <p className="min-w-0 flex-1 truncate text-lead font-medium">{plan.title}</p>
          <span className="rounded-md border border-border px-1.5 py-0.5 text-small text-muted">
            {plan.dashboardId ? "Change" : "Plan"}
          </span>
        </div>
        <p className="text-body text-muted">{plan.purpose}</p>
        {plan.datasets?.length || plan.filters?.length ? (
          <p className="text-small text-muted-tertiary">
            {[
              plan.datasets?.length ? `Reads ${plan.datasets.join(", ")}` : null,
              plan.filters?.length ? `Filters: ${plan.filters.map((f) => f.label).join(", ")}` : null,
              plan.nav === "sidebar" ? "Pages down a sidebar" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        ) : null}
      </div>

      {plan.reference ? (
        // What it took from the person's reference, before the plan it led to.
        <section className="flex flex-col gap-2 rounded-xl border border-border px-3 py-2.5" aria-label="What I took">
          <p className="flex items-center gap-1.5 text-small font-medium">
            <ScanSearch className="size-3.5 text-accent" aria-hidden />
            What I took from {plan.reference.from.join(", ")}
          </p>
          <dl className="flex flex-col gap-1 text-small">
            <div className="flex gap-3">
              <dt className="w-14 shrink-0 text-muted">Pages</dt>
              <dd className="min-w-0">{plan.reference.pages}</dd>
            </div>
            <div className="flex gap-3">
              <dt className="w-14 shrink-0 text-muted">Pieces</dt>
              <dd className="min-w-0">{plan.reference.pieces.map((p) => `${p.piece} (${p.as})`).join(", ")}</dd>
            </div>
            {plan.reference.look ? (
              <div className="flex gap-3">
                <dt className="w-14 shrink-0 text-muted">Look</dt>
                <dd className="min-w-0">{plan.reference.look}</dd>
              </div>
            ) : null}
          </dl>
          {plan.reference.data.length ? (
            <ul className="flex flex-col gap-1 text-small">
              {plan.reference.data.map((d) => (
                <li key={d.say} className="flex items-start gap-1.5">
                  {d.state === "have" ? (
                    <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-success" aria-label="Your data has it" />
                  ) : d.state === "instead" ? (
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-label="Used instead" />
                  ) : (
                    <CircleX className="mt-0.5 size-3.5 shrink-0 text-danger" aria-label="Your data lacks it" />
                  )}
                  <span>{d.say}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-micro text-muted-tertiary">
            Its sample numbers aren't copied: thresholds become inputs you set.
          </p>
        </section>
      ) : null}

      {many ? (
        <ol className="flex flex-col gap-1">
          {plan.pages.map((p, i) => (
            <li key={p.id ?? `${i}:${p.title}`}>
              <button
                type="button"
                onClick={() => setShown(i)}
                aria-current={i === shown ? "true" : undefined}
                className={`flex w-full items-center gap-3 rounded-lg px-1.5 py-1 text-left ${i === shown ? "bg-default" : "hover:bg-default/60"}`}
              >
                <Thumb page={p} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-small font-medium">
                    <span className="me-1 text-muted-tertiary tabular-nums">{i + 1}</span>
                    {p.title}
                  </span>
                  <span className="truncate text-small text-muted">{pageWords(p)}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      ) : null}

      {page ? (
        <figure
          className="m-0 flex flex-col gap-2 rounded-xl bg-default/60 p-2.5"
          aria-label={`${page.title}, as it will be laid out`}
        >
          {!many ? (
            <figcaption className="text-small text-muted">
              <span className="font-medium text-foreground">{page.title}</span> · {pageWords(page)}
            </figcaption>
          ) : null}
          {plan.filters?.length ? (
            <div className="flex flex-wrap gap-1.5" aria-hidden>
              {plan.filters.map((f) => (
                <span
                  key={f.id}
                  className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-micro text-muted"
                >
                  {f.label}
                </span>
              ))}
            </div>
          ) : null}
          <PageLayout page={page} />
        </figure>
      ) : null}

      {plan.notes?.length ? (
        // What its data can't do yet, said before anything is built.
        <div className="flex flex-col gap-1 rounded-xl bg-warning-soft px-3 py-2 text-small text-warning-soft-foreground">
          <span className="flex items-center gap-1.5 font-medium">
            <TriangleAlert className="size-3.5" aria-hidden />
            Before you build
          </span>
          {plan.notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      ) : null}

      {onAsk ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" isDisabled={!can} onPress={() => onAsk("Build it")}>
            <Hammer className="size-3.5" aria-hidden />
            Build it
          </Button>
          <span className="text-small text-muted-tertiary">Or reply to change the plan.</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A dashboard made from its plan, before its first page lands: the plan's pages drawn as outlines,
 * full size, under its build bar; each page appears in place of its outline the moment it passes. A build that stopped
 * before any page landed says so.
 */
export function PlanOutline({ plan, building }: { plan: DashboardPlanOutcome; building: boolean }) {
  const [shown, setShown] = useState(0);
  const page = plan.pages[shown] ?? plan.pages[0];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-title font-semibold">{plan.title}</h1>
        <p className="text-body text-muted">{plan.purpose}</p>
      </div>
      <div className="flex items-end gap-5 border-b border-border" role="tablist" aria-label="Pages">
        {plan.pages.map((p, i) => (
          <button
            key={p.id ?? `${i}:${p.title}`}
            type="button"
            role="tab"
            aria-selected={i === shown}
            onClick={() => setShown(i)}
            className={`-mb-px border-b-2 pb-2 text-body ${i === shown ? "border-accent font-medium text-foreground" : "border-transparent text-muted hover:text-foreground"}`}
          >
            {p.title}
          </button>
        ))}
      </div>
      <p className="text-small text-muted" role="status">
        {building
          ? "Being built: each page appears here the moment it passes its check."
          : "The build stopped before a page was saved. Ask again in its conversation to build it."}
      </p>
      {page ? (
        <figure className="m-0 opacity-80" aria-label={`${page.title}, as it will be laid out`}>
          <div className="[&_.grid]:gap-3 [&_span]:min-h-14">
            <PageLayout page={page} />
          </div>
        </figure>
      ) : null}
    </div>
  );
}
