import { redirect } from "next/navigation";

/** Watching moved to Insights → Watching. */
export default function MonitorsPage() {
  redirect("/insights/watching");
}
