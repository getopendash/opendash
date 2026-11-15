import { buttonVariants } from "@heroui/react";
import Link from "next/link";

/**
 * An App that isn't there for this person: deleted, never theirs, or no longer shared with them (its owner took them
 * off). Said plainly, with the way back, instead of the bare 404.
 */
export default function DashboardNotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <h1 className="text-title">This App isn't here for you</h1>
      <p className="max-w-sm text-body text-muted">
        It was deleted, or it isn't shared with you any more. Its owner can share it with you again.
      </p>
      <Link href="/dashboards" className={buttonVariants({ size: "sm", variant: "outline" })}>
        Back to dashboards
      </Link>
    </div>
  );
}
