"use client";

import { Input, Label, ListBox, Select, Switch, TextField } from "@heroui/react";
import { CodeEditor } from "@opendash/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { saveGuideAction, saveTermAction } from "@/app/(app)/knowledge/context-actions";
import { Footer, useSave } from "./editor-parts";

const NEW_TERM = `term: Enterprise
means: Accounts with 1,000 or more employees.
synonyms: [large accounts]
maps_to:
  column: public.accounts.employee_band
  values: ["1000+"]
`;

/** A term's editor: its YAML, and the source its mapping is about. */
export function TermEditor({
  id,
  initial,
  connectionId: initialSource,
  sources,
  released,
}: {
  id?: string;
  initial?: string;
  connectionId?: string | null;
  sources: { id: string; name: string }[];
  /** The version the analyst reads now, if any. */
  released: number | null;
}) {
  const router = useRouter();
  const [body, setBody] = useState(initial ?? NEW_TERM);
  const [source, setSource] = useState<string>(initialSource ?? sources[0]?.id ?? "");
  const [note, setNote] = useState("");
  const { pending, problem, run } = useSave("glossary");
  return (
    <div className="flex flex-col gap-4">
      <Select
        selectedKey={source || "none"}
        onSelectionChange={(k) => setSource(k === "none" ? "" : String(k))}
        className="flex w-72 flex-col gap-1.5"
      >
        <Label>Source of its mapping</Label>
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            <ListBox.Item id="none" textValue="None">
              None (no mapping)
            </ListBox.Item>
            {sources.map((s) => (
              <ListBox.Item key={s.id} id={s.id} textValue={s.name}>
                {s.name}
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
      <CodeEditor
        value={body}
        onValueChange={setBody}
        label="The term, in YAML"
        header={
          <span className="font-mono text-small text-muted">
            term · means · synonyms · maps_to (column + values, or metric) · not (tables it isn't)
          </span>
        }
        onSave={() =>
          run(
            () => saveTermAction({ ...(id ? { id } : {}), body, connectionId: source || null, changeNote: note }),
            false,
          )
        }
      />
      <Footer
        note={note}
        setNote={setNote}
        pending={pending}
        problem={problem}
        draftOf={released}
        onCancel={() => router.back()}
        onSave={(approve) =>
          run(
            () => saveTermAction({ ...(id ? { id } : {}), body, connectionId: source || null, changeNote: note }),
            approve,
          )
        }
      />
    </div>
  );
}

/** What the analyst sees: the guide fenced and labelled as data (the guide editor's right panel). */
const preview = (title: string, body: string) =>
  `<context source="guide: ${title.replace(/"/g, "'")}" trust="admin">\n${body.replace(/<\/?\s*context\b[^>]*>/gi, "[context tag removed]")}\n</context>`;

/** A guide's editor: title, where it applies, pinned or not, and its markdown, with what the analyst sees. */
export function GuideEditor({
  id,
  initial,
  sources,
  tables,
  released,
  limits,
}: {
  id?: string;
  initial?: { title: string; body: string; pinned: boolean; connectionId: string | null; table: string | null };
  /** The store's limits (core's PINNED_GUIDE_MAX and GUIDE_MAX), passed in so they can't drift. */
  limits: { pinned: number; guide: number };
  sources: { id: string; name: string }[];
  tables: { connection_id: string; fq_name: string }[];
  released: number | null;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [pinned, setPinned] = useState(initial?.pinned ?? false);
  const [applies, setApplies] = useState(
    initial?.table && initial.connectionId
      ? `${initial.connectionId}|${initial.table}`
      : initial?.connectionId
        ? `${initial.connectionId}|`
        : "org",
  );
  const [note, setNote] = useState("");
  const { pending, problem, run } = useSave("guides");
  const [connectionId, table] = applies === "org" ? [null, null] : (applies.split("|") as [string, string]);
  const max = pinned ? limits.pinned : limits.guide;
  const name = (cid: string) => sources.find((s) => s.id === cid)?.name ?? "source";
  const save = (approve: boolean) =>
    run(
      () =>
        saveGuideAction({
          ...(id ? { id } : {}),
          title,
          body,
          pinned,
          connectionId,
          table: table || null,
          changeNote: note,
        }),
      approve,
    );
  return (
    <div className="flex flex-col gap-4 @5xl/page:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="flex flex-col gap-3 @2xl/page:flex-row">
          <TextField value={title} onChange={setTitle} className="flex flex-1 flex-col gap-1.5">
            <Label>Title</Label>
            <Input placeholder="Invoices: totals include tax" maxLength={120} />
          </TextField>
          <Select
            selectedKey={applies}
            onSelectionChange={(k) => setApplies(String(k))}
            className="flex flex-1 flex-col gap-1.5"
          >
            <Label>Applies to</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item id="org" textValue="Whole workspace">
                  Whole workspace
                </ListBox.Item>
                {sources.map((s) => (
                  <ListBox.Item key={s.id} id={`${s.id}|`} textValue={s.name}>
                    {s.name}
                  </ListBox.Item>
                ))}
                {tables.map((t) => (
                  <ListBox.Item
                    key={`${t.connection_id}|${t.fq_name}`}
                    id={`${t.connection_id}|${t.fq_name}`}
                    textValue={t.fq_name}
                  >
                    <span className="font-mono">{t.fq_name}</span>
                    <span className="text-small text-muted-tertiary"> · {name(t.connection_id)}</span>
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        </div>
        <Switch isSelected={pinned} onChange={setPinned} size="sm">
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <span className="flex flex-col">
              <span className="text-body">Pinned</span>
              <span className="text-small text-muted">
                Pinned guides are always in front of the analyst. Keep them short.
              </span>
            </span>
          </Switch.Content>
        </Switch>
        <CodeEditor
          value={body}
          onValueChange={setBody}
          label="The guide, in markdown"
          header={
            <span className="flex w-full justify-between font-mono text-small text-muted">
              <span>Markdown</span>
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
          disabled={!title.trim() || !body.trim() || body.length > max}
          onCancel={() => router.back()}
          onSave={save}
        />
      </div>
      <aside className="flex flex-col gap-2 @5xl/page:w-inspector">
        <h2 className="text-small font-medium text-muted">What the analyst sees</h2>
        <p className="text-small text-muted-tertiary">
          {pinned
            ? "In front of it on every question."
            : table
              ? `When a question touches ${table}.`
              : "When its search finds it."}{" "}
          Fenced and labelled as data, never instructions.
        </p>
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl border border-border bg-surface-secondary p-3 font-mono text-small">
          {preview(title || "Untitled", body || "…")}
        </pre>
      </aside>
    </div>
  );
}
