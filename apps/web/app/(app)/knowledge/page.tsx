import { redirect } from "next/navigation";

/** Knowledge opens on its metrics: what most people come to read. */
export default function KnowledgePage() {
  redirect("/knowledge/metrics");
}
