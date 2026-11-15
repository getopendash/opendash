import { Code, Sigma } from "lucide-react";

export type AnswerPath = "metric" | "unmodelled";

/**
 * Path Label: how an answer or a query was computed. Metric: a verified definition. Unmodelled:
 * SQL written over the tables, labelled so and always cross-checked.
 */
export function PathLabel({ path }: { path: AnswerPath }) {
  const metric = path === "metric";
  return (
    <span className={`path-label rounded-md ${metric ? "path-label--metric" : "path-label--unmodelled"}`}>
      {metric ? <Sigma className="size-3" aria-hidden /> : <Code className="size-3" aria-hidden />}
      {metric ? "Metric" : "Unmodelled"}
    </span>
  );
}
