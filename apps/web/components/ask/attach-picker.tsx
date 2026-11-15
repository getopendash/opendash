"use client";

import { Button, Description, Header, Label, ListBox, Popover, SearchField, Spinner, toast } from "@heroui/react";
import type { AttachmentInput } from "@opendash/api/client";
import { useQuery } from "@tanstack/react-query";
import {
  AtSign,
  BookOpen,
  Check,
  Eye,
  FileText,
  ImageIcon,
  LayoutDashboard,
  ListChecks,
  type LucideIcon,
  Paperclip,
  ShieldCheck,
  Sigma,
  SquareMousePointer,
  Table2,
  X,
} from "lucide-react";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { api, apiQueries } from "@/lib/api";

/** Something attached to the question being written, with what its chip shows. */
export type AttachedItem = AttachmentInput & { title: string };

export const MAX_ATTACHED = 5;

const KINDS: { kind: AttachedItem["kind"]; heading: string; label: string; icon: LucideIcon }[] = [
  { kind: "metric", heading: "Metrics", label: "Metric", icon: Sigma },
  { kind: "dataset", heading: "Datasets", label: "Dataset", icon: Table2 },
  { kind: "guide", heading: "Guides", label: "Guide", icon: BookOpen },
  { kind: "verified_query", heading: "Verified queries", label: "Verified query", icon: ShieldCheck },
  { kind: "skill", heading: "Skills", label: "Skill", icon: ListChecks },
  { kind: "dashboard", heading: "Dashboards", label: "Dashboard", icon: LayoutDashboard },
];
/** A chip's kind: what the picker attaches, or a file or image the person added (paperclip, or Slack). */
type ChipKind = AttachedItem["kind"];
const FILE_KIND = { kind: "file" as const, heading: "Files", label: "File", icon: FileText };
const IMAGE_KIND = { kind: "image" as const, heading: "Images", label: "Image", icon: ImageIcon };
/** A piece of an App selected on its page (select to edit): never offered by `@`, only added from the App. */
const ELEMENT_KIND = { kind: "app_element" as const, heading: "Selected", label: "Selected", icon: SquareMousePointer };
const kindOf = (kind: ChipKind) =>
  kind === "file"
    ? FILE_KIND
    : kind === "image"
      ? IMAGE_KIND
      : kind === "app_element"
        ? ELEMENT_KIND
        : (KINDS.find((k) => k.kind === kind) ?? (KINDS[0] as (typeof KINDS)[0]));

/** An attached item as a question sends it: everything but its chip's title. */
export const sentAttachment = ({ title: _title, ...rest }: AttachmentInput & { title?: string }): AttachmentInput =>
  rest;

/** Base64 of a file's bytes, in chunks (a large file would overflow one call). */
async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

/**
 * The paperclip: files and images the person adds to a question, read by OpenDash's reader on the
 * server (text, Markdown, CSV, JSON, HTML, PDF as their text; images as themselves); what it couldn't read is said.
 */
export function ReferencePicker({
  attached,
  onAdd,
  onReading,
  incoming,
}: {
  /** Files pasted into the question or dropped on it: read like the paperclip's. */
  incoming?: { files: File[]; nonce: number } | null;
  /** Everything going with the question (the page's chip too): what the limits count. */
  attached: AttachedItem[];
  onAdd: (item: AttachedItem) => void;
  /** How many are being read: the composer waits for them before sending. */
  onReading?: (n: number) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(0);
  // The composer is told after the count changes, never from inside the update (a drop read files while rendering;
  // React refused the composer's update).
  // biome-ignore lint/correctness/useExhaustiveDependencies: told on each change of the count
  useEffect(() => {
    onReading?.(reading);
  }, [reading]);
  const full = attached.length >= MAX_ATTACHED;
  const read = async (files: FileList | File[] | null) => {
    // The limits a question has: five things, two of them images, counted with those already going and being read.
    let room = MAX_ATTACHED - attached.length - reading;
    let images = attached.filter((a) => a.kind === "image").length;
    for (const file of [...(files ?? [])]) {
      if (room <= 0) {
        toast.danger(`A question takes ${MAX_ATTACHED} things: ${file.name} wasn't added.`);
        continue;
      }
      if (file.type.startsWith("image/") && images >= 2) {
        toast.danger(`A question takes two images: ${file.name} wasn't added.`);
        continue;
      }
      room -= 1;
      if (file.type.startsWith("image/")) images += 1;
      if (file.size > 8 * 1024 * 1024) {
        toast.danger(`${file.name} is over 8 MB.`);
        continue;
      }
      setReading((n) => n + 1);
      try {
        const got = await api.ask.readReference({ name: file.name, data: await base64Of(file) });
        if (got.kind === "refused") toast.danger(got.note);
        else {
          if (got.kind === "file" && got.note) toast(got.note);
          onAdd(
            got.kind === "file"
              ? { kind: "file", id: got.id, name: got.name, text: got.text, title: got.name }
              : {
                  kind: "image",
                  id: got.id,
                  name: got.name,
                  mediaType: got.mediaType,
                  data: got.data,
                  title: got.name,
                },
          );
        }
      } catch (error) {
        toast.danger(error instanceof Error ? error.message : `${file.name} couldn't be read.`);
      } finally {
        setReading((n) => n - 1);
      }
    }
    if (input.current) input.current.value = "";
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once per paste or drop
  useEffect(() => {
    if (incoming?.files.length) void read(incoming.files);
  }, [incoming?.nonce]);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept=".txt,.md,.markdown,.csv,.tsv,.json,.html,.htm,.pdf,image/png,image/jpeg,image/gif,image/webp"
        onChange={(e) => void read(e.target.files)}
      />
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label="Add a file or an image (text, CSV, HTML, PDF, PNG, JPEG)"
        className="text-muted"
        isDisabled={full}
        onPress={() => input.current?.click()}
      >
        {reading ? <Spinner size="sm" /> : <Paperclip className="size-3.5" aria-hidden />}
      </Button>
    </>
  );
}

/**
 * `@` in the composer. What the asker can attach on the conversation's source, by kind: verified metrics and
 * datasets, guides, verified queries and skills, and the dashboards they can open (one of theirs can then be changed
 * from this conversation). Choosing one attaches it (one already attached:
 * takes it off) and goes back to the question.
 */
export function AttachPicker({
  connectionId,
  attached,
  onToggle,
}: {
  connectionId: string;
  attached: AttachedItem[];
  onToggle: (item: AttachedItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const deferred = useDeferredValue(q.trim());
  const list = useQuery({
    ...apiQueries.ask.attachable.queryOptions({ input: { connectionId, ...(deferred ? { q: deferred } : {}) } }),
    enabled: open,
    placeholderData: (previous) => previous,
  });
  const items = list.data ?? [];
  const isAttached = (kind: string, id: string) => attached.some((a) => a.kind === kind && a.id === id);
  const full = attached.length >= MAX_ATTACHED;
  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label="Attach a metric, dataset, guide, verified query, skill or dashboard"
        className="text-muted"
      >
        <AtSign className="size-3.5" aria-hidden />
      </Button>
      <Popover.Content placement="top start" className="w-96">
        <Popover.Dialog aria-label="Attach to this question" className="flex flex-col gap-1 p-1.5">
          <SearchField aria-label="Find something to attach" value={q} onChange={setQ} autoFocus fullWidth>
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder="Find a metric, dataset, guide or query" />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>
          {list.isPending ? (
            <p className="px-2 py-3 text-small text-muted-tertiary">Looking…</p>
          ) : items.length ? (
            <ListBox
              aria-label="What you can attach"
              className="max-h-80 overflow-y-auto"
              onAction={(key) => {
                const [kind, id] = String(key).split(":") as [AttachedItem["kind"], string];
                const item = items.find((i) => i.kind === kind && i.id === id);
                if (!item || (full && !isAttached(kind, id))) return;
                onToggle({ kind, id, title: item.title });
                // One at a time, like an @-mention: back to the question (`@` again attaches another).
                setOpen(false);
                setQ("");
              }}
            >
              {KINDS.map(({ kind, heading, icon: Icon }) => {
                const of = items.filter((i) => i.kind === kind);
                if (!of.length) return null;
                return (
                  <ListBox.Section key={kind}>
                    <Header className="px-2 pt-2 pb-1 text-small font-medium text-muted-tertiary">{heading}</Header>
                    {of.map((i) => {
                      const on = isAttached(i.kind, i.id);
                      return (
                        <ListBox.Item
                          key={`${i.kind}:${i.id}`}
                          id={`${i.kind}:${i.id}`}
                          textValue={i.title}
                          isDisabled={full && !on}
                        >
                          <Icon className={`size-3.5 shrink-0 ${on ? "text-accent" : "text-muted"}`} aria-hidden />
                          <span className="flex min-w-0 flex-1 flex-col">
                            <Label className="truncate">{i.title}</Label>
                            <Description className="truncate text-small text-muted-tertiary">{i.meta}</Description>
                          </span>
                          <Check className={`size-3.5 shrink-0 ${on ? "text-accent" : "invisible"}`} aria-hidden />
                        </ListBox.Item>
                      );
                    })}
                  </ListBox.Section>
                );
              })}
            </ListBox>
          ) : (
            <p className="px-2 py-3 text-small text-muted-tertiary">
              {deferred ? `Nothing called "${deferred}" here.` : "Nothing to attach on this source yet."}
            </p>
          )}
          <p className="border-t border-border px-2 pt-2 pb-1 text-small text-muted-tertiary">
            {full ? `That's ${MAX_ATTACHED}, the most one question takes.` : "The analyst reads what you attach."}
          </p>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

/** The chips of what's attached: above the question being written (removable), or on a question already asked. */
export function AttachmentChips({
  items,
  onRemove,
  align = "start",
}: {
  items: { kind: ChipKind; id: string; title: string | null }[];
  onRemove?: (item: { kind: AttachedItem["kind"]; id: string }) => void;
  align?: "start" | "end";
}) {
  if (!items.length) return null;
  return (
    <ul
      className={`flex min-w-0 max-w-full flex-wrap gap-1.5 ${align === "end" ? "justify-end" : ""}`}
      aria-label="Attached"
    >
      {items.map((a) => {
        const k = kindOf(a.kind);
        const Icon = k.icon;
        const gone = a.title === null;
        // A selected piece of an App reads "Selected: Queue · ‘#4656 urgent’ (components/Queue.tsx:42)"; in someone
        // else's shared conversation its words are its owner's, and it reads as a piece of an App.
        const element = a.kind === "app_element";
        return (
          <li
            key={`${a.kind}:${a.id}`}
            className="flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-border bg-surface-secondary ps-2 pe-1.5 text-small"
          >
            <Icon className={`size-3.5 shrink-0 ${gone ? "text-muted-tertiary" : "text-accent"}`} aria-hidden />
            <span className={`truncate ${gone ? "text-muted-tertiary" : "font-medium text-foreground"}`}>
              {a.title ?? (element ? "a piece of an App" : "Not available to you")}
            </span>
            {element ? null : <span className="shrink-0 whitespace-nowrap text-muted-tertiary">{k.label}</span>}
            {onRemove && a.kind !== "file" ? (
              <button
                type="button"
                aria-label={`Remove ${a.title ?? k.label}`}
                onClick={() => onRemove({ kind: a.kind as AttachedItem["kind"], id: a.id })}
                className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-tertiary hover:bg-default hover:text-foreground"
              >
                <X className="size-3" aria-hidden />
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The page's chip in the composer: what's on screen, sent with each question asked beside it so the analyst knows what
 * "this" is. Taken off, it isn't sent.
 */
export function FocusChip({ item, onRemove }: { item: AttachedItem; onRemove?: () => void }) {
  const k = kindOf(item.kind);
  return (
    <span
      title={`${k.label} on screen: it goes with your question. Take it off to ask without it.`}
      className="flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-border bg-surface-secondary ps-2 pe-1.5 text-small"
    >
      <Eye className="size-3.5 shrink-0 text-accent" aria-hidden />
      <span className="truncate font-medium text-foreground">{item.title}</span>
      <span className="shrink-0 whitespace-nowrap text-muted-tertiary">on screen</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Ask without ${item.title}`}
          onClick={onRemove}
          className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-tertiary hover:bg-default hover:text-foreground"
        >
          <X className="size-3" aria-hidden />
        </button>
      ) : null}
    </span>
  );
}
