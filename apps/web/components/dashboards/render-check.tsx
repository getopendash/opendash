"use client";

import type { Probed } from "@opendash/apps/protocol";
import { useRef, useState } from "react";
import { useSettled } from "@/components/dashboards/app-settled";
import { DashboardHost } from "@/components/dashboards/dashboard-host";
import { api } from "@/lib/api";

/** The widths an App is measured at: a phone, beside the analyst, full width; each as Tailwind's spacing says it. */
export const RENDER_WIDTHS = [390, 760, 1280] as const;
const WIDTH_CLASS: Record<(typeof RENDER_WIDTHS)[number], string> = { 390: "w-97.5", 760: "w-190", 1280: "w-320" };
/**
 * Times a width is measured again while its answers are still loading: each measure waits up to twelve seconds for
 * them, so seven in all outlast a service's slowest call (70 s).
 */
const MEASURES_UNSETTLED = 7;

type HostProps = Parameters<typeof DashboardHost>[0];

/**
 * The render check: the owner's draft drawn three more times, hidden, at a phone's width,
 * beside the analyst and full width, each measuring itself once its answers settle; what each found is kept with the
 * revision for the analyst to read before it says the App is done. Only for widths not measured settled for this
 * revision yet. A width measured while its answers still loaded is kept as unsettled and measured again (the analyst
 * is told it isn't known clean meanwhile); each copy goes once it has said with its answers in, or after its last try.
 * Nothing shows: it's for the analyst.
 *
 * The copies wait for the App the person is looking at (it has drawn and nothing of it is loading, or a few seconds
 * have passed): three hidden frames no longer load beside the one they opened the page to see. Then each width is
 * measured on its own, as before: one that hangs never holds the others up.
 */
export function RenderCheck({
  dashboard,
  draw,
  frameUrl,
  measured,
}: Omit<HostProps, "probe"> & { measured: number[] }) {
  const [done, setDone] = useState<number[]>(measured);
  const tries = useRef<Record<number, number>>({});
  const settled = useSettled(draw.revision);
  const left = RENDER_WIDTHS.filter((w) => !done.includes(w));
  if (!left.length || !settled) return null;
  const onProbed = (width: number) => (p: Probed) => {
    tries.current[width] = (tries.current[width] ?? 0) + 1;
    const again = Boolean(p.unsettled) && tries.current[width] < MEASURES_UNSETTLED;
    if (!again) setDone((d) => [...d, width]);
    void api.dashboards
      .renderCheck({
        dashboardId: dashboard.id,
        revision: p.revision,
        width,
        findings: p.findings.slice(0, 40),
        ...(p.unsettled ? { unsettled: true } : {}),
      })
      .catch(() => {});
    return again;
  };
  return (
    <div aria-hidden className="pointer-events-none fixed top-0 -left-2500 opacity-0">
      {left.map((width) => (
        <div key={width} className={`flex h-225 ${WIDTH_CLASS[width]}`}>
          <DashboardHost dashboard={dashboard} draw={draw} frameUrl={frameUrl} probe={{ onProbed: onProbed(width) }} />
        </div>
      ))}
    </div>
  );
}
