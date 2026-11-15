import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { EvalsView } from "@/components/evals/evals-view";
import { requireTenant } from "@/lib/auth";
import { canVerify } from "@/lib/knowledge";

export const metadata: Metadata = { title: "Evals · OpenDash" };

/** Q1: the organization's evals, for its owners and admins. */
export default async function EvalsPage() {
  const viewer = await requireTenant();
  if (!canVerify(viewer.role)) redirect("/knowledge/metrics");
  return <EvalsView />;
}
