/**
 * A sparkline of bars (Home's key metric tiles): each bar's height is its share of the largest value, the last one in
 * the accent. Heights are runtime geometry, set here as a CSS variable. Decorative: the tile states the
 * value and the change in text. It needs two values to show a change: with fewer (a metric's value now) it draws
 * nothing, rather than one bar filling its box.
 */
export function Sparkline({
  values,
  className = "",
  tone = "accent",
}: {
  values: (number | null)[];
  className?: string;
  /** The last bar's colour: the accent, or good or bad news (an insight). */
  tone?: "accent" | "danger" | "success";
}) {
  if (values.length < 2) return null;
  const max = Math.max(0, ...values.map((v) => v ?? 0));
  return (
    <div aria-hidden className={`sparkline ${className}`} data-tone={tone === "accent" ? undefined : tone}>
      {values.map((v, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: bars are positions in time
          key={i}
          className="sparkline__bar"
          data-last={i === values.length - 1 ? "" : undefined}
          style={{ "--spark": max > 0 && v !== null ? Math.max(v / max, 0.04) : 0 } as React.CSSProperties}
        />
      ))}
    </div>
  );
}
