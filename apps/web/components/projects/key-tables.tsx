"use client";

import { Button, Checkbox, Label, ListBox, Modal, SearchField, Select, toast } from "@heroui/react";
import type { KeyTable, KeyTableView } from "@opendash/core";
import { CircleDashed, ShieldCheck, Table2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { keyTableChoicesAction, setKeyTablesAction } from "@/app/(app)/projects/key-table-actions";

type Choice = { table: string; rows: number | null; covered: { id: string; title: string } | null };
const MAX = 20;
const n = (v: number | null) => (v === null ? "" : `${v.toLocaleString("en-US")} rows`);

/** The tables a project's work rests on, and which have a verified dataset; its managers edit them. */
export function KeyTables({
  projectId,
  projectName,
  tables,
  sources,
  manages,
}: {
  projectId: string;
  projectName: string;
  tables: KeyTableView[];
  sources: { id: string; name: string }[];
  manages: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const covered = tables.filter((t) => t.covered).length;
  if (!tables.length && !manages) return null;
  return (
    <section aria-labelledby="key-tables-title" className="flex flex-col gap-1 pt-6">
      <div className="flex items-baseline justify-between pb-1">
        <h2 id="key-tables-title" className="text-body font-medium">
          Key tables
        </h2>
        {manages && sources.length ? (
          <button
            type="button"
            className="text-small font-medium text-link hover:underline"
            onClick={() => setEditing(true)}
          >
            {tables.length ? "Edit" : "Choose"}
          </button>
        ) : null}
      </div>
      <p className="text-small text-muted-tertiary">
        {tables.length
          ? `The tables this project's work rests on. ${covered} of ${tables.length} ${tables.length === 1 ? "has" : "have"} a verified dataset.`
          : "Choose the tables this project's work rests on, to see which have a verified dataset."}
      </p>
      <ul className="flex flex-col">
        {tables.map((t) => (
          <li key={`${t.connectionId}:${t.table}`} className="flex items-center gap-2 py-2">
            <Table2 className="size-3.5 shrink-0 text-muted-tertiary" aria-hidden />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate font-mono text-small font-medium">{t.table}</span>
              <span
                className={`truncate text-small ${t.covered || !t.present ? "text-muted-tertiary" : "text-warning"}`}
              >
                {t.sourceName} ·{" "}
                {!t.present ? (
                  "no longer in its catalog"
                ) : t.covered ? (
                  <>
                    verified as{" "}
                    <Link href={`/knowledge/datasets/${t.covered.id}`} className="text-link hover:underline">
                      {t.covered.title}
                    </Link>
                  </>
                ) : (
                  "no verified dataset yet"
                )}
              </span>
            </span>
            {t.covered ? (
              <ShieldCheck className="size-3.5 shrink-0 text-success" aria-label="Verified dataset" />
            ) : (
              <CircleDashed className="size-3.5 shrink-0 text-warning" aria-label="No verified dataset" />
            )}
          </li>
        ))}
      </ul>
      {editing ? (
        <KeyTablesEditor
          projectId={projectId}
          projectName={projectName}
          tables={tables}
          sources={sources}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </section>
  );
}

/** Picks a project's key tables, a source at a time. */
function KeyTablesEditor({
  projectId,
  projectName,
  tables,
  sources,
  onClose,
}: {
  projectId: string;
  projectName: string;
  tables: KeyTableView[];
  sources: { id: string; name: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [source, setSource] = useState(tables[0]?.connectionId ?? sources[0]?.id ?? "");
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [chosen, setChosen] = useState<KeyTable[]>(
    tables.map((t) => ({ connectionId: t.connectionId, table: t.table })),
  );
  const [find, setFind] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!source) return;
    let live = true;
    setChoices(null);
    void keyTableChoicesAction(projectId, source).then((r) => {
      if (!live) return;
      if (!r.ok) return void toast.danger(r.message);
      setChoices(r.choices);
    });
    return () => {
      live = false;
    };
  }, [projectId, source]);
  const isChosen = (table: string) => chosen.some((c) => c.connectionId === source && c.table === table);
  const toggle = (table: string, on: boolean) =>
    setChosen((list) =>
      on
        ? list.length >= MAX
          ? list
          : [...list, { connectionId: source, table }]
        : list.filter((c) => !(c.connectionId === source && c.table === table)),
    );
  const shown = useMemo(
    () => (choices ?? []).filter((c) => c.table.toLowerCase().includes(find.trim().toLowerCase())).slice(0, 100),
    [choices, find],
  );
  const save = async () => {
    setPending(true);
    const r = await setKeyTablesAction(projectId, chosen);
    setPending(false);
    if (!r.ok) return void toast.danger(r.message);
    toast.success("Key tables saved.");
    onClose();
    router.refresh();
  };
  return (
    <Modal>
      <Modal.Backdrop isOpen onOpenChange={(open) => !open && onClose()}>
        <Modal.Container size="md">
          <Modal.Dialog>
            <Modal.Header className="flex flex-col gap-1">
              <Modal.Heading>Key tables</Modal.Heading>
              <p className="text-small text-muted">
                The tables {projectName}'s work rests on. Its page shows which have a verified dataset.
              </p>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-3">
              <Select value={source} onChange={(key) => setSource(String(key ?? ""))} className="flex flex-col gap-1.5">
                <Label>Source</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {sources.map((s) => (
                      <ListBox.Item key={s.id} id={s.id} textValue={s.name}>
                        {s.name}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
              <SearchField value={find} onChange={setFind} aria-label="Find a table">
                <SearchField.Group>
                  <SearchField.SearchIcon />
                  <SearchField.Input placeholder="Find a table" />
                  <SearchField.ClearButton />
                </SearchField.Group>
              </SearchField>
              <ul className="flex max-h-80 flex-col overflow-y-auto rounded-xl border border-border">
                {choices === null ? (
                  <li className="px-3 py-3 text-small text-muted">Reading its catalog…</li>
                ) : shown.length ? (
                  shown.map((c) => (
                    <li key={c.table} className="border-b border-border px-3 py-2 last:border-b-0">
                      <Checkbox isSelected={isChosen(c.table)} onChange={(on) => toggle(c.table, on)}>
                        <Checkbox.Content className="flex w-full items-center gap-2.5">
                          <Checkbox.Control>
                            <Checkbox.Indicator />
                          </Checkbox.Control>
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="truncate font-mono text-small font-medium">{c.table}</span>
                            <span className="truncate text-small text-muted-tertiary">
                              {[n(c.rows), c.covered ? `verified as ${c.covered.title}` : "no verified dataset"]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </span>
                          {c.covered ? (
                            <ShieldCheck className="size-3.5 shrink-0 text-success" aria-hidden />
                          ) : (
                            <CircleDashed className="size-3.5 shrink-0 text-muted-tertiary" aria-hidden />
                          )}
                        </Checkbox.Content>
                      </Checkbox>
                    </li>
                  ))
                ) : (
                  <li className="px-3 py-3 text-small text-muted">No table matches.</li>
                )}
              </ul>
            </Modal.Body>
            <Modal.Footer className="flex items-center gap-2">
              <span className="flex-1 text-small text-muted-tertiary">
                {chosen.length} chosen · up to {MAX}
              </span>
              <Button variant="ghost" slot="close">
                Cancel
              </Button>
              <Button isPending={pending} onPress={() => void save()}>
                Save
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
