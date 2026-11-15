"use client";

import { type KeyboardEvent, type ReactNode, useRef } from "react";

export type LineMark = "changed" | "error";

/**
 * A plain code editor: a textarea with a line-number gutter and per-line marks (changed, error) behind the
 * text, which follow its scroll. The scroll offset is runtime geometry, so it's set here as a CSS variable.
 * Tab inserts two spaces; ⌘S / Ctrl-S calls onSave.
 */
export function CodeEditor({
  value,
  onValueChange,
  marks = {},
  label,
  header,
  footer,
  onCursor,
  onSave,
}: {
  value: string;
  onValueChange: (value: string) => void;
  /** 1-based line → mark. */
  marks?: Record<number, LineMark>;
  label: string;
  header?: ReactNode;
  footer?: ReactNode;
  onCursor?: (at: { line: number; col: number }) => void;
  onSave?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const lines = value.split("\n");
  const cursor = (el: HTMLTextAreaElement) => {
    const at = el.value.slice(0, el.selectionStart).split("\n");
    onCursor?.({ line: at.length, col: (at.at(-1)?.length ?? 0) + 1 });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b } = el;
      onValueChange(`${value.slice(0, a)}  ${value.slice(b)}`);
      requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      onSave?.();
    }
  };
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-border">
      {header ? (
        <div className="flex h-9 items-center justify-between gap-3 border-b border-border bg-surface-secondary px-3">
          {header}
        </div>
      ) : null}
      <div ref={box} className="code-editor relative flex min-h-96">
        <div
          aria-hidden
          className="w-11 shrink-0 select-none overflow-hidden py-2.5 pe-3 text-right text-muted-tertiary"
        >
          <div className="code-editor__scrolled">
            {lines.map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: line numbers are positions
              <div key={i} className={marks[i + 1] === "error" ? "text-danger" : ""}>
                {i + 1}
              </div>
            ))}
          </div>
        </div>
        <div className="relative min-w-0 flex-1">
          <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden py-2.5">
            <div className="code-editor__scrolled">
              {lines.map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: line marks are positions
                <div key={i} className="code-editor__mark" data-mark={marks[i + 1]} />
              ))}
            </div>
          </div>
          <textarea
            aria-label={label}
            value={value}
            spellCheck={false}
            wrap="off"
            onChange={(e) => {
              onValueChange(e.target.value);
              cursor(e.target);
            }}
            onKeyUp={(e) => cursor(e.currentTarget)}
            onClick={(e) => cursor(e.currentTarget)}
            onScroll={(e) => box.current?.style.setProperty("--code-scroll", `${-e.currentTarget.scrollTop}px`)}
            onKeyDown={onKeyDown}
            className="relative h-full min-h-96 w-full resize-y overflow-auto bg-transparent py-2.5 pe-3 text-foreground outline-none"
          />
        </div>
      </div>
      {footer ? (
        <div className="flex h-8 items-center justify-between gap-3 border-t border-border px-3 text-small">
          {footer}
        </div>
      ) : null}
    </div>
  );
}
