import { buttonVariants } from "@heroui/react";
import { Download } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A download of data as a zip (a workspace's, for its owners; a person's own): what's in it, and the button. A plain
 * link: the browser saves the file as the server makes it.
 */
export function ExportCard({
  id,
  title,
  href,
  children,
}: {
  id: string;
  title: string;
  href: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-border px-5 py-4"
    >
      <Download className="size-5 shrink-0 text-muted" aria-hidden />
      <div className="flex min-w-64 flex-1 flex-col gap-1">
        <h2 id={id} className="text-body font-medium">
          {title}
        </h2>
        <p className="text-small text-muted">{children}</p>
      </div>
      <a href={href} download className={buttonVariants({ size: "sm", variant: "secondary" })}>
        Download
      </a>
    </section>
  );
}
