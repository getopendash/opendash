// Select to edit, the page's rules (pure, so tests read them): what the App's frame says was clicked is a hint, since
// App code shares the frame and could send anything. The page takes a selection only for the revision it drew, of the
// shape a mark has, bounded, at most so often, once per piece and up to a question's limit. It never sends anything:
// a selection becomes a chip on the question the person is writing, and goes with it only when they send it.
import type { Picked } from "@opendash/apps/protocol";
import { parseSourceMark, SELECTED_TAG_MAX, selectedText, selectionLabel } from "@opendash/apps/select";

/** A selection as the composer attaches it: an attachment of kind app_element with its chip's words. */
export interface SelectedPiece {
  kind: "app_element";
  id: string;
  title: string;
  dashboardId: string;
  revision: string;
  file: string;
  line: number;
  column: number;
  tag: string;
  text: string;
}

export type PickedResult =
  | { ok: true; piece: SelectedPiece }
  /** `unmarked`: the click found no mark (the App's bundle was built before marks): it's saved once to have them. */
  | { ok: false; why: "unmarked" | "invalid" | "stale" };

/** What the frame said, as a selection of this App at the revision drawn, or why not. */
export function pickedSelection(
  params: unknown,
  drawn: { dashboardId: string; revision: string },
  newId: () => string,
): PickedResult {
  if (!params || typeof params !== "object") return { ok: false, why: "invalid" };
  const p = params as Partial<Record<keyof Picked, unknown>>;
  if (p.revision !== drawn.revision) return { ok: false, why: "stale" };
  if (p.src === undefined) return { ok: false, why: "unmarked" };
  const mark = parseSourceMark(p.src);
  if (!mark) return { ok: false, why: "invalid" };
  const tag =
    typeof p.tag === "string" && p.tag.length <= SELECTED_TAG_MAX && /^[a-z][a-z0-9-]*$/i.test(p.tag) ? p.tag : "";
  const text = selectedText(p.text);
  return {
    ok: true,
    piece: {
      kind: "app_element",
      id: newId(),
      title: selectionLabel({ file: mark.file, text }),
      dashboardId: drawn.dashboardId,
      revision: drawn.revision,
      file: mark.file,
      line: mark.line,
      column: mark.column,
      tag,
      text,
    },
  };
}

/** The same piece, however often it's clicked: its App, revision, file and line. */
export const pieceKey = (p: Pick<SelectedPiece, "dashboardId" | "revision" | "file" | "line">) =>
  `${p.dashboardId}:${p.revision}:${p.file}:${p.line}`;

/**
 * The page's gate for one stretch of pick mode: a piece once, at most `max` of them, and no faster than one every
 * `gapMs` (a frame posting in a loop adds nothing).
 */
export function selectionGate(options: { max: number; gapMs: number; now?: () => number }) {
  const now = options.now ?? Date.now;
  const seen = new Set<string>();
  let last = Number.NEGATIVE_INFINITY;
  return (piece: SelectedPiece): "added" | "again" | "too-fast" | "full" => {
    const at = now();
    if (at - last < options.gapMs) return "too-fast";
    const key = pieceKey(piece);
    if (seen.has(key)) return "again";
    if (seen.size >= options.max) return "full";
    last = at;
    seen.add(key);
    return "added";
  };
}

/**
 * A chip appended to the question's attachments from outside the composer (a piece selected in an App): once, and only
 * while there's room (`limit`: how many the question takes beside the page's own chip).
 */
export function appendAttached<T extends { kind: string; id: string }>(
  list: T[],
  item: T,
  limit: number,
): { list: T[]; outcome: "added" | "already" | "full" } {
  const same = (x: T) =>
    x.kind === item.kind &&
    (x.id === item.id ||
      (item.kind === "app_element" &&
        pieceKey(x as unknown as SelectedPiece) === pieceKey(item as unknown as SelectedPiece)));
  if (list.some(same)) return { list, outcome: "already" };
  if (list.length >= limit) return { list, outcome: "full" };
  return { list: [...list, item], outcome: "added" };
}
