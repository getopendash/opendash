import { answerAbout, getQueryCard, getRun, type RunOutcome } from "@opendash/core";
import { isUuid, type TenantTx, withTenant } from "@opendash/db";
import { answerPdfBlocks, citedQueryRuns, pdfFileName, type QueryName, renderAnswerPdf } from "@/lib/answer-pdf";
import { requireTenant } from "@/lib/auth";

const deps = { withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => withTenant({ orgId }, fn) };

/**
 * An answer as a PDF, for whoever can read its conversation (the answer is what was shared): drawn from the run's
 * outcome, nothing re-runs. Its appendix names each cited query through the query card's own rule.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireTenant();
  const who = { orgId: viewer.ctx.orgId, userId: viewer.user.id };
  const run = isUuid(id) ? await getRun(deps, who, id) : null;
  const answer = run?.status === "succeeded" && run.outcome?.kind === "answer" ? run.outcome : null;
  if (answer?.status !== "answered") return new Response("Not found", { status: 404 });
  const about = await withTenant(viewer.ctx, (tx) => answerAbout(tx, who.orgId, id));
  if (!about) return new Response("Not found", { status: 404 });
  const cards = await Promise.all(citedQueryRuns(answer).map((q) => getQueryCard(deps, who, q)));
  const names = new Map<string, QueryName>(
    cards.flatMap((c) => (c ? [[c.id, { alias: c.alias, title: c.title }] as const] : [])),
  );
  const bytes = await renderAnswerPdf(
    answerPdfBlocks(answer as Extract<RunOutcome, { kind: "answer" }>, about, names),
    about.question,
  );
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${pdfFileName(about.question)}"`,
      "Cache-Control": "no-store",
    },
  });
}
