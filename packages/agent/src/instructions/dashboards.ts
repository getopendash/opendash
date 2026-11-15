import type { Catalog } from "@opendash/apps/protocol";
import { inert } from "./context";

/**
 * What a dashboard on a source can read, given with the dashboard tools: the source's verified datasets,
 * each with its key, its columns and their kinds (personal ones marked), and the measures it defines. A dataset still in
 * draft isn't here: a dashboard's numbers come from definitions someone approved.
 */
export function dashboardDatasetsBlock(
  source: { name: string; connectionId: string },
  catalog: Catalog | null,
  /** The person's other sources an App may read too: each named by its connection id. */
  others: { id: string; name: string }[] = [],
): string {
  const elsewhere = others.length
    ? `\n\nAn App may read the person's other sources too: ${others.map((o) => `${inert(o.name)} as {"connection": "${o.id}", …}`).join("; ")}. Read what one holds first (ls and read its folder, /sources/<name>/), and name its datasets as they are there.`
    : "";
  const head = `## What an App on ${source.name} can read\n\nIts queries name this source as {"connection": "${source.connectionId}", "dataset": "<name>"}.${elsewhere}`;
  const names = Object.keys(catalog ?? {});
  if (!catalog || !names.length) {
    return `${head}\n\n${source.name} has no datasets yet. An App can still read it: its tables through the App's own datasets (\`datasets: t_…\`, build-an-app), or a connected service. Never refuse to build because nothing is verified; its numbers say they're unverified.`;
  }
  const lines = names.sort().map((name) => {
    const d = catalog[name];
    if (!d) return "";
    const columns = Object.entries(d.columns)
      .map(
        ([c, col]) =>
          `${c} (${col.kind}${col.personal ? ", personal" : ""}${col.values?.length ? `: ${col.values.slice(0, 12).join(", ")}` : ""})`,
      )
      .join("; ");
    const measures = Object.keys(d.measures ?? {});
    return [
      `- ${name}${d.key ? ` (key: ${d.key})` : ""}${d.description ? `: ${d.description}` : ""}`,
      `  columns: ${columns}`,
      ...(measures.length ? [`  measures: ${measures.join(", ")}`] : []),
    ].join("\n");
  });
  // The datasets' names and descriptions are data (an admin approved them, people wrote them): fenced, never instructions.
  return `${head} A personal column's values are never returned: an App counts or filters on one, and never selects it.\n\n<context source="catalog" trust="data">\n${inert(lines.filter(Boolean).join("\n"))}\n</context>`;
}
