import { Chip } from "@heroui/react";
import { getProposal } from "@opendash/core";
import { withTenant } from "@opendash/db";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { PROPOSAL_STATUS, ProposalBody, ProposalOrigin, proposalTitle } from "@/components/knowledge/proposal-detail";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { canVerify } from "@/lib/knowledge";

export const metadata: Metadata = { title: "Proposal · OpenDash" };

/**
 * One Modeler proposal from a tile or an answer's query (Make this a metric), on its own page: its drafts with
 * their tests, how the metric compares with the tile, why OpenDash drafted them; Approve, Edit or Reject. A source's
 * drafts are reviewed together on their source's page.
 */
export default async function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireTenant();
  const orgId = viewer.ctx.orgId;
  const p = await withTenant({ orgId }, (tx) => getProposal(tx, { orgId, userId: viewer.user.id }, id));
  if (!p) notFound();
  if (p.tables.length) redirect(`/knowledge/proposals/sources/${p.connectionId}`);
  const title = proposalTitle(p);
  const status = PROPOSAL_STATUS[p.status];
  return (
    <>
      <TopBar
        crumbs={[
          { label: "Knowledge", href: "/knowledge" },
          { label: "Proposals", href: "/knowledge/proposals" },
          { label: title },
        ]}
      />
      <div className="flex-1 overflow-y-auto px-8 pt-8 pb-16">
        <div className="flex flex-col gap-8">
          <header className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1.5">
              <h1 className="text-display">{title}</h1>
              <ProposalOrigin p={p} />
            </div>
            <Chip size="sm" variant="soft" color={status.color}>
              {status.label}
            </Chip>
          </header>
          <ProposalBody p={p} canApprove={canVerify(viewer.role)} orgId={orgId} />
        </div>
      </div>
    </>
  );
}
