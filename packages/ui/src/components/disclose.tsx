import type { ReactNode } from "react";

/**
 * A section that opens and closes smoothly (motion): always mounted, it grows from nothing to its content's
 * height and fades in, and shrinks away again. While closed it's inert, so nothing in it can be focused or read out.
 * The button that opens it keeps its own `aria-expanded`.
 */
export function Disclose({
  open,
  className = "",
  children,
}: {
  open: boolean;
  /** On the inner block (its gap, padding): the outer one is the animated grid. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="disclose" data-open={open ? "" : undefined} inert={!open}>
      {/* The clipped row has no padding of its own, so it can close to nothing; the padding goes inside it. */}
      <div>
        <div className={className}>{children}</div>
      </div>
    </div>
  );
}
