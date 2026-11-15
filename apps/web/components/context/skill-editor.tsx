"use client";

import { Input, Label, TextArea, TextField } from "@heroui/react";
import { CodeEditor } from "@opendash/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { saveSkillAction } from "@/app/(app)/knowledge/skill-actions";
import { Footer, useSave } from "./editor-parts";

const NEW_SKILL = `# Board pack MRR bridge

1. Use the verified metrics: MRR for the opening and the closing month, then new, expansion, contraction and
   churned MRR for the month between.
2. Show it as a table, opening to closing, and say if the parts don't add up to the change.
`;

/** "Use it when" fits on one line: what the analyst matches a question against. */
const USE_WHEN_MAX = 300;

/** A skill's editor. Its name, when the analyst should use it, and its steps in Markdown. */
export function SkillEditor({
  id,
  initial,
  released,
  max,
}: {
  id?: string;
  initial?: { title: string; useWhen: string; body: string };
  released: number | null;
  /** The store's limit (core's SKILL_MAX), passed in so it can't drift. */
  max: number;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [useWhen, setUseWhen] = useState(initial?.useWhen ?? "");
  const [body, setBody] = useState(initial?.body ?? NEW_SKILL);
  const [note, setNote] = useState("");
  const { pending, problem, run } = useSave("skills");
  const save = (approve: boolean) =>
    run(
      () =>
        saveSkillAction({
          ...(id ? { id } : {}),
          title,
          description: useWhen,
          body,
          ...(note ? { changeNote: note } : {}),
        }),
      approve,
    );
  const fits = title.trim() && useWhen.trim() && useWhen.length <= USE_WHEN_MAX && body.trim() && body.length <= max;
  return (
    <div className="flex flex-col gap-4 @5xl/page:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="flex flex-col gap-3 @2xl/page:flex-row">
          <TextField value={title} onChange={setTitle} className="flex flex-1 flex-col gap-1.5">
            <Label>Name</Label>
            <Input placeholder="Board pack MRR bridge" maxLength={120} />
          </TextField>
          <TextField value={useWhen} onChange={setUseWhen} className="flex flex-2 flex-col gap-1.5">
            <Label>Use it when</Label>
            <TextArea
              placeholder="Asked for an MRR bridge, or what moved MRR in a month"
              rows={1}
              maxLength={USE_WHEN_MAX}
            />
          </TextField>
        </div>
        <CodeEditor
          value={body}
          onValueChange={setBody}
          label="What to do, in markdown"
          header={
            <span className="flex w-full justify-between font-mono text-small text-muted">
              <span>/skills/{(title || "new-skill").toLowerCase().replace(/[^a-z0-9]+/g, "_")}/SKILL.md</span>
              <span className={body.length > max ? "text-danger" : ""}>
                {body.length.toLocaleString("en-US")} of {max.toLocaleString("en-US")} characters
              </span>
            </span>
          }
          onSave={() => save(false)}
        />
        <Footer
          note={note}
          setNote={setNote}
          pending={pending}
          problem={problem}
          draftOf={released}
          disabled={!fits}
          onCancel={() => router.back()}
          onSave={save}
        />
      </div>
      <aside className="flex flex-col gap-2 @5xl/page:w-inspector">
        <h2 className="text-small font-medium text-muted">How the analyst uses it</h2>
        <p className="text-small text-muted-tertiary">
          Its name and “use it when” are in front of the analyst on every question. When a question fits, it reads the
          steps and follows them within its rules: numbers still come from queries, and a verified metric still comes
          first. The answer says it followed this skill.
        </p>
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl border border-border bg-surface-secondary p-3 font-mono text-small">
          {`<skill name="${title || "Untitled"}" use_when="${useWhen || "…"}">\n${body.split("\n").slice(0, 6).join("\n") || "…"}${body.split("\n").length > 6 ? "\n…" : ""}\n</skill>`}
        </pre>
      </aside>
    </div>
  );
}
