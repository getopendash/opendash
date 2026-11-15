import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { EvalRunView } from "@/components/evals/eval-run-view";
import { requireTenant } from "@/lib/auth";
import { canVerify } from "@/lib/knowledge";

export const metadata: Metadata = { title: "Eval run · OpenDash" };

/** Q2: one run of the evals, for owners and admins. */
export default async function EvalRunPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, viewer] = await Promise.all([params, requireTenant()]);
  if (!canVerify(viewer.role)) redirect("/knowledge/metrics");
  return <EvalRunView evalRunId={id} />;
}
