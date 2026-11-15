import type { ReactNode } from "react";
import { SectionNav } from "@/components/shell/section-nav";
import { currentWorkspace } from "@/lib/workspace";

/** Knowledge: its pages listed inside the sheet beside the page. Feedback and Evals are for owners and admins. */
export default async function KnowledgeLayout({ children }: { children: ReactNode }) {
  const ws = await currentWorkspace();
  const admin = ws.role === "owner" || ws.role === "admin";
  return (
    <SectionNav
      title="Knowledge"
      groups={[
        {
          items: [
            { label: "Glossary", href: "/knowledge/glossary" },
            { label: "Guides", href: "/knowledge/guides" },
            { label: "Datasets", href: "/knowledge/datasets" },
            { label: "Metrics", href: "/knowledge/metrics" },
            { label: "Verified queries", href: "/knowledge/verified" },
            { label: "Skills", href: "/knowledge/skills" },
            { label: "Memory", href: "/knowledge/memory" },
          ],
        },
        {
          title: "Review",
          items: [
            { label: "Learnings", href: "/knowledge/learnings" },
            { label: "Proposals", href: "/knowledge/proposals" },
            ...(admin
              ? [
                  { label: "Feedback", href: "/knowledge/feedback" },
                  { label: "Evals", href: "/knowledge/evals" },
                ]
              : []),
          ],
        },
      ]}
    >
      {children}
    </SectionNav>
  );
}
