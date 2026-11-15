"use client";

import { Button, buttonVariants, Input, Label, Spinner, TextField, toast } from "@heroui/react";
import { CodeEditor, type LineMark } from "@opendash/ui";
import { Check, CircleCheck, CircleMinus, CircleX, FileCode, FlaskConical, History, ShieldOff } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { checkDefinitionDraft, type DraftReport, saveDefinitionAction } from "@/app/(app)/knowledge/actions";

const REFERENCE = {
  metric: [
    ["name", "id, lower_snake_case"],
    ["label", "shown in the app"],
    ["description", "what it means"],
    ["dataset", "its dataset's ref"],
    ["measure", "a measure of that dataset"],
    ["segments", "always applied"],
    ["time_column", "another time column, or none"],
    ["default_grain", "day · week · month · quarter · year"],
    ["format", "number · usd · percent"],
    ["direction", "higher or lower is better"],
    ["synonyms", "other names people use"],
  ],
  dataset: [
    ["ref", "id, lower_snake_case"],
    ["label", "shown in the app"],
    ["sql", "one SELECT, in the source's SQL"],
    ["grain", "what one row is"],
    ["primary_key", "the columns that make a row unique"],
    ["time_column", "the default time column"],
    ["columns", "name, type, dimension, description"],
    ["measures", "name, expr (an aggregate), format"],
    ["segments", "name, where, default"],
    ["relationships", "to, type (n:1, 1:1, 1:n), on"],
  ],
} as const;

/**
 * A definition's editor. YAML on the left with line numbers, the lines changed from the current version, and the
 * line a problem is about; on the right, the checks a save runs, as you type, and what happens after saving.
 */
export function DefinitionEditor({
  kind,
  id,
  connectionId,
  sourceName,
  initial,
  version,
  path,
  cancelHref,
}: {
  kind: "metric" | "dataset";
  /** Absent for a new definition. */
  id?: string;
  connectionId: string;
  sourceName: string;
  initial: string;
  /** The version being edited (the save makes version + 1), or 0 for a new one. */
  version: number;
  path: string;
  cancelHref: string;
}) {
  const router = useRouter();
  const [body, setBody] = useState(initial);
  const [note, setNote] = useState("");
  const [report, setReport] = useState<DraftReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [saving, start] = useTransition();

  const lines = body.split("\n");
  const before = useMemo(() => initial.split("\n"), [initial]);
  const changed = new Set(lines.flatMap((l, i) => (version > 0 && l !== before[i] ? [i + 1] : [])));
  const marks: Record<number, LineMark> = Object.fromEntries([...changed].map((n) => [n, "changed" as const]));
  if (report?.line) marks[report.line] = "error";

  // The checks run a moment after typing stops; the latest answer wins.
  useEffect(() => {
    let live = true;
    setChecking(true);
    const timer = setTimeout(async () => {
      const r = await checkDefinitionDraft({
        kind,
        connectionId,
        body,
        ...(id ? { id, expectedVersion: version } : {}),
      }).catch(() => null);
      if (live) {
        setReport(r);
        setChecking(false);
      }
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [body, kind, connectionId, id, version]);

  const blocked = !report || report.checks.some((c) => c.status !== "passed") || (version > 0 && body === initial);
  const save = () =>
    start(async () => {
      const r = await saveDefinitionAction({
        kind,
        connectionId,
        body,
        ...(id ? { id, expectedVersion: version } : {}),
        ...(note.trim() ? { changeNote: note.trim() } : {}),
      });
      if (!r.ok) {
        toast.danger(r.message);
        return;
      }
      toast.success(`Saved version ${r.version}. OpenDash is testing it against ${sourceName}.`);
      router.push(r.href);
      router.refresh();
    });
  return (
    <div className="flex flex-col gap-10 @5xl/page:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-5">
        <CodeEditor
          label={`The ${kind}'s YAML`}
          value={body}
          onValueChange={setBody}
          marks={marks}
          onCursor={setCursor}
          onSave={() => {
            if (!blocked && !saving) save();
          }}
          header={
            <>
              <span className="flex min-w-0 items-center gap-2 font-mono text-small text-muted">
                <FileCode className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{path}</span>
              </span>
              <span className="shrink-0 text-small text-muted-tertiary">YAML · Ossie {kind}</span>
            </>
          }
          footer={
            <>
              {report?.problem ? (
                <span className="flex min-w-0 items-center gap-1.5 text-danger">
                  <CircleX className="size-3.5 shrink-0" aria-hidden />
                  <span className="truncate">
                    {report.line ? `Line ${report.line}: ` : ""}
                    {report.problem}
                  </span>
                </span>
              ) : (
                <span className="text-muted-tertiary">
                  {version > 0
                    ? changed.size
                      ? `${changed.size} ${changed.size === 1 ? "line" : "lines"} changed from version ${version}`
                      : `Version ${version}, unchanged`
                    : "A new definition"}
                </span>
              )}
              <span className="shrink-0 font-mono text-muted-tertiary">
                Ln {cursor.line}, Col {cursor.col}
              </span>
            </>
          }
        />
        <TextField value={note} onChange={setNote} className="flex flex-col gap-1.5">
          <Label>Change note</Label>
          <Input placeholder="What changed and why (shown in Versions)" />
          <span className="text-small text-muted-tertiary">Optional. Saved with version {version + 1}.</span>
        </TextField>
        <div className="flex items-center gap-2">
          <Button isPending={saving} isDisabled={blocked} onPress={save}>
            <Check className="size-3.5" aria-hidden />
            {version > 0 ? `Save version ${version + 1}` : `Create ${kind}`}
          </Button>
          <Link href={cancelHref} className={buttonVariants({ variant: "outline" })}>
            Cancel
          </Link>
        </div>
      </div>
      <aside className="flex shrink-0 flex-col gap-7 @5xl/page:w-80">
        <section className="flex flex-col gap-2">
          <h2 className="flex items-center gap-2 text-small font-medium text-muted">
            Checks before saving
            {checking ? <Spinner size="sm" aria-label="Checking" /> : null}
          </h2>
          <ul className="flex flex-col">
            {(report?.checks ?? []).map((c) => (
              <li key={c.name} className="flex items-start gap-2.5 py-1.75 text-body">
                {c.status === "passed" ? (
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                ) : c.status === "failed" ? (
                  <CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
                ) : (
                  <CircleMinus className="mt-0.5 size-4 shrink-0 text-muted-tertiary" aria-hidden />
                )}
                <span className={`flex-1 ${c.status === "pending" ? "text-muted" : ""}`}>
                  {c.name}
                  {c.status === "failed" && c.detail ? (
                    <span className="mt-0.5 block text-small text-danger">{c.detail}</span>
                  ) : null}
                </span>
                {c.status === "passed" && c.detail ? (
                  <span className="shrink-0 text-small text-muted-tertiary">{c.detail}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
        <section className="flex flex-col gap-2">
          <h2 className="text-small font-medium text-muted">After saving</h2>
          <ul className="flex flex-col gap-2 text-body">
            <li className="flex items-start gap-2.5">
              <FlaskConical className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
              OpenDash tests it against {sourceName}
            </li>
            <li className="flex items-start gap-2.5">
              <ShieldOff className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
              {version > 0
                ? "The Verified badge clears until it's approved again; Ask keeps the approved version meanwhile"
                : "Ask uses it once an owner or admin approves it"}
            </li>
            <li className="flex items-start gap-2.5">
              <History className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
              Answers keep the version they used
            </li>
          </ul>
        </section>
        <section className="flex flex-col gap-2">
          <h2 className="text-small font-medium text-muted">Reference</h2>
          <dl className="flex flex-col gap-1 rounded-xl border border-border bg-surface-secondary p-3 text-small">
            {REFERENCE[kind].map(([name, hint]) => (
              <div key={name} className="flex gap-3">
                <dt className="w-28 shrink-0 font-mono">{name}</dt>
                <dd className="text-muted">{hint}</dd>
              </div>
            ))}
          </dl>
        </section>
      </aside>
    </div>
  );
}
