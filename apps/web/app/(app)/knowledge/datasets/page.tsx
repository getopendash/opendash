import type { Metadata } from "next";
import { KnowledgeList } from "@/components/knowledge/knowledge-list";

export const metadata: Metadata = { title: "Datasets · OpenDash" };

export default function DatasetsPage() {
  return <KnowledgeList kind="dataset" />;
}
