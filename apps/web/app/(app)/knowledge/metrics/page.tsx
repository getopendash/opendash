import type { Metadata } from "next";
import { KnowledgeList } from "@/components/knowledge/knowledge-list";

export const metadata: Metadata = { title: "Metrics · OpenDash" };

export default function MetricsPage() {
  return <KnowledgeList kind="metric" />;
}
