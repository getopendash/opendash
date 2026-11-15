import { encode } from "uqr";

/**
 * A QR code, drawn as one SVG path of its dark squares. Always dark on light, in either theme: that's what
 * cameras read, so it takes the light theme's tokens whatever the page's theme is.
 */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const { data, size } = encode(value, { ecc: "M", border: 2 });
  let d = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (data[y]?.[x]) d += `M${x} ${y}h1v1h-1z`;
  }
  return (
    <div data-theme="light" className={`bg-surface ${className ?? ""}`}>
      <svg
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={label}
        className="size-full"
        shapeRendering="crispEdges"
      >
        <title>{label}</title>
        <path d={d} className="fill-foreground" />
      </svg>
    </div>
  );
}
