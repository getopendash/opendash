import type { ReactNode } from "react";

/** Title and one line of explanation for each connect step. */
export function StepHeading({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="text-title text-balance">{title}</h1>
      <p className="text-body text-muted">{children}</p>
    </div>
  );
}
